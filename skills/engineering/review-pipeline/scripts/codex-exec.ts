// `review.ts codex-exec --role orchestrator|reviewer --brief <file> --out <file>
//   [--schema <file>] [--log <file>] [--config <path>]`
// The one way the pipeline calls Codex. The model and effort always come from
// the config, so no call can fall back to ~/.codex/config.toml. The brief goes
// in on stdin; Codex's final message goes to --out; its output goes to --log
// (default: --out with its extension replaced by .log).
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadConfig } from './config.ts'

const PREFIX = 'review.ts codex-exec: '
const USAGE =
  'usage: review.ts codex-exec --role orchestrator|reviewer --brief <file> --out <file> [--schema <file>] [--log <file>] [--config <path>]'
const FINDINGS_SCHEMA = join(dirname(dirname(fileURLToPath(import.meta.url))), 'findings.schema.json')

type Role = 'orchestrator' | 'reviewer'

function fail(message: string, code: number): number {
  process.stderr.write(`${PREFIX}${message}\n`)
  return code
}

function repoRoot(): string {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  return git.status === 0 ? git.stdout.trim() : process.cwd()
}

function defaultLog(out: string): string {
  const ext = extname(out)
  return `${ext === '' ? out : out.slice(0, -ext.length)}.log`
}

// `input` is the open brief; it becomes Codex's stdin and is closed after.
function runCodex(args: string[], input: number, log: string): Promise<number | null> {
  const output = openSync(log, 'w')
  return new Promise((done, reject) => {
    const child = spawn('codex', args, { stdio: [input, output, output] })
    child.on('error', reject)
    child.on('close', (code) => {
      closeSync(input)
      closeSync(output)
      done(code)
    })
  })
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
  if (loaded.config.runtime !== 'codex') {
    return fail(`${loaded.config.config_path}: runtime is ${loaded.config.runtime}, not codex. Do not call codex-exec on this runtime.`, 4)
  }
  const { model, effort } = loaded.config[role as Role]

  const version = spawnSync('codex', ['--version'], { encoding: 'utf8' })
  if (version.error !== undefined || version.status !== 0) {
    const why = version.error?.message ?? (version.stderr.trim() || `codex --version exited ${version.status}`)
    return fail(
      `the Codex CLI is missing or broken (${why}). Install or repair codex, or re-run /setup-review-pipeline to pick runtime claude.`,
      4,
    )
  }

  const sandbox = role === 'orchestrator' ? 'danger-full-access' : 'read-only'
  const outPath = resolve(out)
  const log = resolve(values.log ?? defaultLog(out))
  const schema = role === 'reviewer' ? ['--output-schema', resolve(values.schema ?? FINDINGS_SCHEMA)] : []
  const args = ['exec', '-C', repoRoot(), '-m', model, '-c', `model_reasoning_effort=${effort}`, '-s', sandbox, ...schema, '-o', outPath, '-']
  // A stale output from an earlier run must never count as this run's answer.
  let input: number
  try {
    input = openSync(resolve(brief), 'r')
  } catch (error) {
    return fail(`cannot read the brief ${resolve(brief)}: ${(error as Error).message}`, 1)
  }
  await rm(outPath, { force: true })
  const status = await runCodex(args, input, log)
  if (status !== 0) {
    let message = `codex exec failed (exit ${status}). See ${log}.`
    const text = await readFile(log, 'utf8')
    if (text.includes('unsupported_value') && text.includes('reasoning.effort')) {
      message += ` Codex rejected ${role}.effort "${effort}" for model ${model}. Fix the effort in docs/agents/review.md or re-run /setup-review-pipeline.`
    }
    return fail(message, 1)
  }
  let output: string
  try {
    output = await readFile(outPath, 'utf8')
  } catch {
    return fail(`codex exec wrote no output to ${outPath}. See ${log}.`, 1)
  }
  if (role === 'reviewer') {
    try {
      JSON.parse(output)
    } catch {
      return fail(`the output in ${outPath} is not JSON. See ${log}.`, 1)
    }
  }

  process.stdout.write(`${JSON.stringify({ role, model, effort, sandbox, out: outPath, log }, null, 2)}\n`)
  return 0
}
