// `review.ts codex-exec --role orchestrator|reviewer --brief <file> --out <file>
//   [--schema <file>] [--log <file>] [--config <path>]`
// The one way the pipeline calls Codex. The model and effort always come from
// the config, so no call can fall back to ~/.codex/config.toml. Every call is
// read-only (no writes, no network) and gets an allowlisted environment with an
// empty HOME, so no gh token or other credential reaches it: the agents read
// untrusted PR text, so only review.ts itself posts. The brief goes in on
// stdin; Codex's final message goes to --out and must match --schema; its
// output goes to --log (default: --out with its extension replaced by .log).
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadConfig, type ResolvedConfig } from './config.ts'
import { schemaProblem } from './schema.ts'

const PREFIX = 'review.ts codex-exec: '
const USAGE =
  'usage: review.ts codex-exec --role orchestrator|reviewer --brief <file> --out <file> [--schema <file>] [--log <file>] [--config <path>]'
const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
export const SCHEMAS = {
  orchestrator: join(SKILL_DIR, 'review.schema.json'),
  reviewer: join(SKILL_DIR, 'findings.schema.json'),
}
// The sandbox of every Codex call. Never danger-full-access or workspace-write.
export const SANDBOX = 'read-only'
// The only caller variables Codex sees. HOME and XDG_CONFIG_HOME point at an
// empty temp dir, so ~/.config/gh and the like are not found through them.
const PASSED = /^(PATH|LANG|LC_[A-Z_]+|TMPDIR|TERM)$/

export type Role = 'orchestrator' | 'reviewer'
export type CodexCall = { role: Role; brief: string; out: string; schema?: string; log?: string }
export type CodexResult =
  | { ok: true; role: Role; model: string; effort: string; sandbox: string; out: string; log: string; output: unknown }
  | { ok: false; message: string; code: number }

export function repoRoot(): string {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  return git.status === 0 ? git.stdout.trim() : process.cwd()
}

function defaultLog(out: string): string {
  const ext = extname(out)
  return `${ext === '' ? out : out.slice(0, -ext.length)}.log`
}

// Run `fn` with Codex's environment: the allowlisted caller variables,
// CODEX_HOME (the caller's, else the real ~/.codex, so the Codex login still
// works), and a fresh empty HOME that is removed afterwards.
async function withCodexEnv<T>(fn: (env: NodeJS.ProcessEnv) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'review-pipeline-home-'))
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => PASSED.test(name)))
  env.CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  env.HOME = home
  env.XDG_CONFIG_HOME = home
  try {
    return await fn(env)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// `input` is the open brief; it becomes Codex's stdin and is closed after.
function runCodex(args: string[], input: number, log: string): Promise<number | null> {
  const output = openSync(log, 'w')
  return withCodexEnv(
    (env) =>
      new Promise((done, reject) => {
        const child = spawn('codex', args, { stdio: [input, output, output], env })
        child.on('error', reject)
        child.on('close', (code) => {
          closeSync(input)
          closeSync(output)
          done(code)
        })
      }),
  )
}

// Exit 4 when the runtime is not codex or the Codex CLI is missing or broken.
export async function checkCodex(config: ResolvedConfig): Promise<{ message: string; code: number } | undefined> {
  if (config.runtime !== 'codex') {
    return { message: `${config.config_path}: runtime is ${config.runtime}, not codex. Do not call Codex on this runtime.`, code: 4 }
  }
  const version = await withCodexEnv((env) => spawnSync('codex', ['--version'], { encoding: 'utf8', env }))
  if (version.error !== undefined || version.status !== 0) {
    const why = version.error?.message ?? (version.stderr.trim() || `codex --version exited ${version.status}`)
    return {
      message: `the Codex CLI is missing or broken (${why}). Install or repair codex, or re-run /setup-review-pipeline to pick runtime claude.`,
      code: 4,
    }
  }
  return undefined
}

// One read-only `codex exec`. The output must parse and match the schema.
export async function execRole(config: ResolvedConfig, call: CodexCall): Promise<CodexResult> {
  const { role } = call
  const { model, effort } = config[role]
  const outPath = resolve(call.out)
  const log = resolve(call.log ?? defaultLog(call.out))
  const schemaPath = resolve(call.schema ?? SCHEMAS[role])
  let schema: object
  try {
    schema = JSON.parse(await readFile(schemaPath, 'utf8'))
  } catch (error) {
    return { ok: false, message: `cannot read the schema ${schemaPath}: ${(error as Error).message}`, code: 1 }
  }
  const args = ['exec', '-C', repoRoot(), '-m', model, '-c', `model_reasoning_effort=${effort}`, '-s', SANDBOX,
    '--output-schema', schemaPath, '-o', outPath, '-']
  let input: number
  try {
    input = openSync(resolve(call.brief), 'r')
  } catch (error) {
    return { ok: false, message: `cannot read the brief ${resolve(call.brief)}: ${(error as Error).message}`, code: 1 }
  }
  // A stale output from an earlier run must never count as this run's answer.
  await rm(outPath, { force: true })
  const status = await runCodex(args, input, log)
  if (status !== 0) {
    let message = `codex exec failed (exit ${status}). See ${log}.`
    const text = await readFile(log, 'utf8')
    if (text.includes('unsupported_value') && text.includes('reasoning.effort')) {
      message += ` Codex rejected ${role}.effort "${effort}" for model ${model}. Fix the effort in docs/agents/review.md or re-run /setup-review-pipeline.`
    }
    return { ok: false, message, code: 1 }
  }
  let text: string
  try {
    text = await readFile(outPath, 'utf8')
  } catch {
    return { ok: false, message: `codex exec wrote no output to ${outPath}. See ${log}.`, code: 1 }
  }
  let output: unknown
  try {
    output = JSON.parse(text)
  } catch {
    return { ok: false, message: `the output in ${outPath} is not JSON. See ${log}.`, code: 1 }
  }
  const problem = schemaProblem(schema, output)
  if (problem !== undefined) return { ok: false, message: `the output in ${outPath} does not match ${schemaPath}: ${problem}`, code: 1 }
  return { ok: true, role, model, effort, sandbox: SANDBOX, out: outPath, log, output }
}

function fail(message: string, code: number): number {
  process.stderr.write(`${PREFIX}${message}\n`)
  return code
}

export async function main(argv: string[]): Promise<number> {
  let values: { role?: string; brief?: string; out?: string; schema?: string; log?: string; config?: string }
  try {
    values = parseArgs({
      args: argv,
      options: {
        role: { type: 'string' },
        brief: { type: 'string' },
        out: { type: 'string' },
        schema: { type: 'string' },
        log: { type: 'string' },
        config: { type: 'string' },
      },
      strict: true,
    }).values
  } catch (error) {
    return fail(`${(error as Error).message}\n${USAGE}`, 2)
  }
  const { role, brief, out } = values
  if (role !== 'orchestrator' && role !== 'reviewer') return fail(`--role must be orchestrator or reviewer\n${USAGE}`, 2)
  if (brief === undefined || out === undefined) return fail(`--brief and --out are required\n${USAGE}`, 2)

  const loaded = await loadConfig(values.config)
  if (!loaded.ok) return fail(loaded.message, loaded.code)
  const broken = await checkCodex(loaded.config)
  if (broken !== undefined) return fail(broken.message, broken.code)

  const result = await execRole(loaded.config, { role, brief, out, schema: values.schema, log: values.log })
  if (!result.ok) return fail(result.message, result.code)
  const { model, effort, sandbox, out: outPath, log } = result
  process.stdout.write(`${JSON.stringify({ role, model, effort, sandbox, out: outPath, log }, null, 2)}\n`)
  return 0
}
