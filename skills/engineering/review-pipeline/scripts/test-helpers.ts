// Shared harness for the helper CLI tests. Every test drives `review.ts`
// through its command line in a child process, never by importing a module.
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REVIEW_TS = join(dirname(fileURLToPath(import.meta.url)), 'review.ts')

export type RunResult = { code: number | null; stdout: string; stderr: string }

export type RunOptions = { cwd?: string; env?: Record<string, string | undefined>; stdin?: string }

// The machine may export a real token, or hold real App credentials and run
// caps in ~/.config/hero-forge/. A test must never inherit or reach them: each
// App env file and the cap dir point at paths that do not exist, and the
// GitHub API at a port nothing listens on, until a test sets its own.
export function baseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  env.HERO_FORGE_REVIEWER_APP_ENV = join(tmpdir(), 'review-pipeline-no-such-dir', 'reviewer-app.env')
  env.HERO_FORGE_IMPLEMENTER_APP_ENV = join(tmpdir(), 'review-pipeline-no-such-dir', 'implementer-app.env')
  env.HERO_FORGE_CAP_DIR = join(tmpdir(), 'review-pipeline-no-such-dir', 'caps')
  env.HERO_FORGE_GITHUB_API_URL = 'http://127.0.0.1:9'
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
    // A child that exits before it reads stdin (a usage error, say) makes this
    // write fail with EPIPE. The exit code and output are the result, so the
    // error is ignored; unhandled, it would crash the test run.
    child.stdin.on('error', () => {})
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

// A valid run state for PR #13 at `phase` created, with `over` on top. Tests
// that start a run in the middle write it with `seedState`, because `advance`
// only moves one step at a time.
export function stateFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    schema: 2,
    repo: 'contract-hero/hero-forge',
    pr: 13,
    mode: 'single',
    base_ref: 'main',
    head_ref: 'feature/x',
    head_sha: 'c'.repeat(40),
    runtime: 'claude',
    reviewer_login: 'none',
    round: 1,
    phase: 'created',
    reviews: [],
    gates: [],
    explainer: null,
    created_at: now,
    updated_at: now,
    ...over,
  }
}

// Write `stateFixture(over)` as the state file of its PR under `root`.
export async function seedState(root: string, over: Record<string, unknown> = {}): Promise<string> {
  const state = stateFixture(over)
  const dir = join(root, `pr-${state.pr}`)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'state.json')
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`)
  return file
}

// `ignore_stdin`: exit without reading stdin, as a gh that fails early does.
export type FakeGhResponse = { match: string; stdout?: string; stderr?: string; exit?: number; ignore_stdin?: boolean }

export type FakeGhCall = { argv: string[]; gh_token: string | null; stdin: string }

export type FakeGh = {
  env: Record<string, string | undefined>
  calls: () => Promise<FakeGhCall[]>
  // Replace the responses for the calls that follow (the log is kept).
  respond: (responses: FakeGhResponse[]) => Promise<void>
}

const FAKE_GH = `import { appendFileSync, readFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const responses = JSON.parse(readFileSync(process.env.FAKE_GH_RESPONSES, 'utf8'))
const joined = argv.join(' ')
const hit = responses.find((r) => joined.includes(r.match)) ?? {}
const stdin = process.stdin.isTTY || hit.ignore_stdin ? '' : readFileSync(0, 'utf8')
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ argv, gh_token: process.env.GH_TOKEN ?? null, stdin }) + '\\n')
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
// `routes` answer an exec whose `-o` path contains `match` (first match wins;
// no match falls back to `exec`).
export type FakeCodexExec = FakeCodexStep & { out?: string | null }
export type FakeCodexSpec = {
  version?: FakeCodexStep
  exec?: FakeCodexExec
  routes?: (FakeCodexExec & { match: string })[]
}

// `tokens` names the gh token variables the call could see; `env_keys` all
// the variables it could see. `home`, `xdg_config_home` and `codex_home` are
// those variables, and `home_entries` counts the files in HOME.
export type FakeCodexCall = {
  argv: string[]
  stdin: string
  tokens: string[]
  env_keys: string[]
  home: string | null
  xdg_config_home: string | null
  codex_home: string | null
  home_entries: number | null
}

export type FakeCodex = {
  env: Record<string, string | undefined>
  calls: () => Promise<FakeCodexCall[]>
}

// The log and spec paths are baked in, so the fake works whatever env the
// code under test gives it.
const fakeCodexScript = (log: string, specFile: string) => `import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const exec = argv[0] === 'exec'
const stdin = exec && !process.stdin.isTTY ? readFileSync(0, 'utf8') : ''
const env = process.env
const tokens = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'].filter((k) => env[k] !== undefined)
let home_entries = null
try { home_entries = readdirSync(env.HOME).length } catch {}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, stdin, tokens, env_keys: Object.keys(env).sort(), home: env.HOME ?? null,
  xdg_config_home: env.XDG_CONFIG_HOME ?? null, codex_home: env.CODEX_HOME ?? null, home_entries }) + '\\n')
const spec = JSON.parse(readFileSync(${JSON.stringify(specFile)}, 'utf8'))
const o = argv.indexOf('-o')
const route = exec && o !== -1 ? (spec.routes ?? []).find((r) => argv[o + 1].includes(r.match)) : undefined
const step = route ?? (exec ? spec.exec : spec.version) ?? {}
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
  const log = join(dir, 'codex-calls.jsonl')
  const specFile = join(dir, 'codex-spec.json')
  const script = join(bin, 'fake-codex.mjs')
  await writeFile(script, fakeCodexScript(log, specFile))
  const shim = join(bin, 'codex')
  await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  await chmod(shim, 0o755)
  await writeFile(log, '')
  await writeFile(specFile, JSON.stringify(spec))
  return {
    env: { ...baseEnv(), PATH: `${bin}:${process.env.PATH ?? ''}` },
    calls: async () =>
      (await readFile(log, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as FakeCodexCall),
  }
}

// A reviewer App key pair made for one test. The private key is written as a
// PKCS#1 PEM (the format of GitHub's download); the public key stays here, so
// the fake API can check the JWT signature.
export async function appKey(dir: string, name = 'reviewer-app.pem'): Promise<{ pem: string; publicKey: KeyObject }> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = join(dir, name)
  await writeFile(pem, privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 })
  return { pem, publicKey }
}

export type FakeApiRoute = { status: number; body: unknown }

export type FakeApiRequest = {
  method: string
  path: string
  // The JWT's `iss` (null unless the Bearer value is a JWT the test's key signed).
  iss: string | null
  jwt_ok: boolean
  accept: string | null
  api_version: string | null
  body: unknown
}

export type FakeGitHubApi = { url: string; requests: FakeApiRequest[] }

function checkJwt(auth: string | undefined, publicKey: KeyObject): { ok: boolean; iss: string | null } {
  const parts = /^Bearer (.+)$/.exec(auth ?? '')?.[1]?.split('.') ?? []
  const [header = '', payload = '', signature = ''] = parts
  if (parts.length !== 3) return { ok: false, iss: null }
  const signed = verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))
  if (!signed) return { ok: false, iss: null }
  const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  const now = Math.floor(Date.now() / 1000)
  // GitHub refuses a JWT that is not yet valid, expired, or valid for over 10 minutes.
  const fresh = claims.iat <= now && claims.exp > now && claims.exp - claims.iat <= 600
  return { ok: head.alg === 'RS256' && head.typ === 'JWT' && fresh, iss: String(claims.iss) }
}

// A local stand-in for api.github.com. `routes` maps "METHOD /path" to a
// response; any other request gets a 404. A request whose Bearer JWT does not
// verify with `publicKey` gets a 401, as GitHub answers a wrong key. Every
// request is recorded, and `onRequest` runs before each answer, so a test can
// act between two calls. The server runs in the test process, so spawn the
// CLI with the async `run`/`runCli`, never with spawnSync.
export async function fakeGitHubApi(
  t: { after: (fn: () => Promise<void>) => void },
  publicKey: KeyObject,
  routes: Record<string, FakeApiRoute>,
  onRequest?: (request: FakeApiRequest) => Promise<void>,
): Promise<FakeGitHubApi> {
  const requests: FakeApiRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const jwt = checkJwt(req.headers.authorization, publicKey)
      const method = req.method ?? 'GET'
      const path = req.url ?? '/'
      let body: unknown = null
      try {
        body = raw === '' ? null : JSON.parse(raw)
      } catch {
        body = raw
      }
      const version = req.headers['x-github-api-version']
      const request: FakeApiRequest = {
        method,
        path,
        iss: jwt.iss,
        jwt_ok: jwt.ok,
        accept: req.headers.accept ?? null,
        api_version: typeof version === 'string' ? version : null,
        body,
      }
      requests.push(request)
      const route: FakeApiRoute = !jwt.ok
        ? { status: 401, body: { message: 'A JSON web token could not be decoded' } }
        : (routes[`${method} ${path}`] ?? { status: 404, body: { message: 'Not Found' } })
      void (onRequest?.(request) ?? Promise.resolve()).then(() => {
        res.writeHead(route.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(route.body))
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, requests }
}

export const IMPLEMENTER_TOKEN = 'ghs_implementer0123456789abcdef'

// A working Implementer App for `repo`: a fresh key, its env file, and a fake
// GitHub API that mints IMPLEMENTER_TOKEN for slug `contract-implementer`.
// `missing` leaves out the env file, as on a machine with no Implementer App;
// `broken` writes one that names no key. Merge `env` into the env of the CLI
// call.
export async function implementerApp(
  t: { after: (fn: () => Promise<void>) => void },
  dir: string,
  repo: string,
  options: { missing?: boolean; broken?: boolean; onRequest?: (request: FakeApiRequest) => Promise<void> } = {},
): Promise<{ env: Record<string, string>; api: FakeGitHubApi }> {
  const key = await appKey(dir, 'implementer-app.pem')
  const api = await fakeGitHubApi(t, key.publicKey, {
    [`GET /repos/${repo}/installation`]: { status: 200, body: { id: 4343 } },
    'POST /app/installations/4343/access_tokens': { status: 201, body: { token: IMPLEMENTER_TOKEN } },
    'GET /app': { status: 200, body: { slug: 'contract-implementer' } },
  }, options.onRequest)
  const envFile = join(dir, 'implementer-app.env')
  if (options.broken === true) await writeFile(envFile, 'HERO_FORGE_IMPLEMENTER_APP_ID=777\n')
  else if (options.missing !== true) {
    await writeFile(envFile, `HERO_FORGE_IMPLEMENTER_APP_ID=777\nHERO_FORGE_IMPLEMENTER_APP_KEY=${key.pem}\n`)
  }
  return { env: { HERO_FORGE_IMPLEMENTER_APP_ENV: envFile, HERO_FORGE_GITHUB_API_URL: api.url }, api }
}

// `password` is what the push's own credential config gives a real `git
// credential fill` for https://github.com, `evil_password` the same for another
// host (null: no password). `config` is the real `git config --list
// --show-origin` the push would read, its `-c` options included. `env` is
// the push's whole environment. `landed` is the exit code of the real push
// to `remote` (null: not run).
export type FakeGitPush = {
  argv: string[]
  cwd: string
  password: string | null
  evil_password: string | null
  config: string[]
  env: Record<string, string>
  landed: number | null
}

// How the fake answers a push. `{password}` in `stderr` becomes the password
// the push's credential config gave, as a git that echoed it would print.
// With `remote` (a bare repo path) and no failing `exit`, the fake also runs
// the real push there, with the same options and env, over the file protocol.
export type FakeGitSpec = { exit?: number; stderr?: string; remote?: string }

const fakeGitScript = (realGit: string, log: string, specFile: string) => `import { appendFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const argv = process.argv.slice(2)
const configs = []
let i = 0
while (argv[i] === '-c') { configs.push(argv[i + 1]); i += 2 }
if (argv[i] !== 'push') {
  const real = spawnSync(${JSON.stringify(realGit)}, argv, { stdio: 'inherit' })
  process.exit(real.status ?? 1)
}
const fill = (host) => {
  const r = spawnSync(${JSON.stringify(realGit)}, [...configs.flatMap((c) => ['-c', c]), 'credential', 'fill'], {
    input: 'protocol=https\\nhost=' + host + '\\n\\n', encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return /^password=(.*)$/m.exec(r.stdout ?? '')?.[1] ?? null
}
const password = fill('github.com')
const listed = spawnSync(${JSON.stringify(realGit)}, [...configs.flatMap((c) => ['-c', c]), 'config', '--list', '--show-origin'], { encoding: 'utf8' })
const config = (listed.stdout ?? '').split('\\n').filter((line) => line !== '')
const spec = JSON.parse(readFileSync(${JSON.stringify(specFile)}, 'utf8'))
let landed = null
if (spec.remote !== undefined && (spec.exit ?? 0) === 0) {
  const real = spawnSync(${JSON.stringify(realGit)}, [...configs.flatMap((c) => ['-c', c]), 'push', '-q', spec.remote, argv.at(-1)],
    { encoding: 'utf8', env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } })
  landed = real.status
  if (real.status !== 0) process.stderr.write(real.stderr)
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), password, evil_password: fill('evil.example'), config,
  env: process.env, landed }) + '\\n')
process.stderr.write((spec.stderr ?? 'To https://github.com/x/y.git\\n * [new branch] x -> x\\n').replaceAll('{password}', password ?? ''))
process.exitCode = spec.exit ?? 0
`

// Put a fake `git` first on PATH. Every git command but `push` runs the real
// git. A push is logged, never sent: the fake runs the real git's credential
// fill with the push's own `-c` options, so the log shows whose credentials
// the push would carry. Put `bin` first on the PATH of the CLI call.
export async function fakeGit(dir: string, spec: FakeGitSpec = {}): Promise<{ bin: string; pushes: () => Promise<FakeGitPush[]> }> {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
  const bin = join(dir, 'git-bin')
  await mkdir(bin, { recursive: true })
  const log = join(dir, 'git-pushes.jsonl')
  const specFile = join(dir, 'git-spec.json')
  const script = join(bin, 'fake-git.mjs')
  await writeFile(script, fakeGitScript(realGit, log, specFile))
  const shim = join(bin, 'git')
  await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  await chmod(shim, 0o755)
  await writeFile(log, '')
  await writeFile(specFile, JSON.stringify(spec))
  return {
    bin,
    pushes: async () =>
      (await readFile(log, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as FakeGitPush),
  }
}
