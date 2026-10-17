// Shared harness for the helper CLI tests. Every test drives `review.ts`
// through its command line in a child process, never by importing a module.
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REVIEW_TS = join(dirname(fileURLToPath(import.meta.url)), 'review.ts')

export type RunResult = { code: number | null; stdout: string; stderr: string }

export type RunOptions = { cwd?: string; env?: Record<string, string | undefined>; stdin?: string }

// The machine may export a real token. A test must never inherit it.
export function baseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  return env
}

// Run any executable with async spawn (spawnSync would block a fake server
// served from this same process).
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? baseEnv() })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(options.stdin ?? '')
  })
}

export function runCli(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return run(process.execPath, [REVIEW_TS, ...args], options)
}

// A fresh directory, removed when the test ends.
export async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'review-pipeline-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

export type FakeGhResponse = { match: string; stdout?: string; stderr?: string; exit?: number }

export type FakeGhCall = { argv: string[]; gh_token: string | null; stdin: string }

export type FakeGh = {
  env: Record<string, string | undefined>
  calls: () => Promise<FakeGhCall[]>
  // Replace the responses for the calls that follow (the log is kept).
  respond: (responses: FakeGhResponse[]) => Promise<void>
}

const FAKE_GH = `import { appendFileSync, readFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const stdin = process.stdin.isTTY ? '' : readFileSync(0, 'utf8')
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ argv, gh_token: process.env.GH_TOKEN ?? null, stdin }) + '\\n')
const responses = JSON.parse(readFileSync(process.env.FAKE_GH_RESPONSES, 'utf8'))
const joined = argv.join(' ')
const hit = responses.find((r) => joined.includes(r.match)) ?? {}
if (hit.stdout) process.stdout.write(hit.stdout)
if (hit.stderr) process.stderr.write(hit.stderr)
process.exitCode = hit.exit ?? 0
`

// Put a fake `gh` first on PATH. Each call is logged as one JSON line and
// answered from `responses`: the first entry whose `match` is a substring of
// the joined argv wins; no match exits 0 with empty output. The fake reads
// stdin to EOF, so code that spawns `gh` must close the child's stdin (or
// spawn it with stdin ignored), or the call never returns.
export async function fakeGh(dir: string, responses: FakeGhResponse[] = []): Promise<FakeGh> {
  const bin = join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'fake-gh.mjs'), FAKE_GH)
  const shim = join(bin, 'gh')
  await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-gh.mjs" "$@"\n`)
  await chmod(shim, 0o755)
  const log = join(dir, 'gh-calls.jsonl')
  const responsesFile = join(dir, 'gh-responses.json')
  await writeFile(log, '')
  await writeFile(responsesFile, JSON.stringify(responses))
  return {
    env: {
      ...baseEnv(),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_GH_LOG: log,
      FAKE_GH_RESPONSES: responsesFile,
    },
    calls: async () =>
      (await readFile(log, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as FakeGhCall),
    respond: (next) => writeFile(responsesFile, JSON.stringify(next)),
  }
}

export type FakeCodexStep = { exit?: number; stdout?: string; stderr?: string }

// `version` answers `codex --version`. `exec` answers `codex exec ...`; its
// `out` is written to the file named after `-o` (null: write nothing).
export type FakeCodexSpec = { version?: FakeCodexStep; exec?: FakeCodexStep & { out?: string | null } }

export type FakeCodexCall = { argv: string[]; stdin: string }

export type FakeCodex = {
  env: Record<string, string | undefined>
  calls: () => Promise<FakeCodexCall[]>
}

const FAKE_CODEX = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const exec = argv[0] === 'exec'
const stdin = exec && !process.stdin.isTTY ? readFileSync(0, 'utf8') : ''
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv, stdin }) + '\\n')
const spec = JSON.parse(readFileSync(process.env.FAKE_CODEX_SPEC, 'utf8'))
const step = (exec ? spec.exec : spec.version) ?? {}
const o = argv.indexOf('-o')
if (exec && o !== -1 && step.out !== null) writeFileSync(argv[o + 1], step.out ?? '{}')
if (step.stdout !== undefined) process.stdout.write(step.stdout)
else if (!exec) process.stdout.write('codex-cli 0.163.0\\n')
if (step.stderr) process.stderr.write(step.stderr)
process.exitCode = step.exit ?? 0
`

// Put a fake `codex` first on PATH. Each call is logged as one JSON line
// (argv, plus stdin for `exec`) and answered from `spec`.
export async function fakeCodex(dir: string, spec: FakeCodexSpec = {}): Promise<FakeCodex> {
  const bin = join(dir, 'codex-bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'fake-codex.mjs'), FAKE_CODEX)
  const shim = join(bin, 'codex')
  await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-codex.mjs" "$@"\n`)
  await chmod(shim, 0o755)
  const log = join(dir, 'codex-calls.jsonl')
  const specFile = join(dir, 'codex-spec.json')
  await writeFile(log, '')
  await writeFile(specFile, JSON.stringify(spec))
  return {
    env: { ...baseEnv(), PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_CODEX_LOG: log, FAKE_CODEX_SPEC: specFile },
    calls: async () =>
      (await readFile(log, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as FakeCodexCall),
  }
}
