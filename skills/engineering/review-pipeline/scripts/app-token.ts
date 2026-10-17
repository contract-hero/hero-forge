// `review.ts app-token --repo O/R [--config <path>] [--login | --check]`
// `review.ts app-token --copy-from <lfg env file> [--force]`
// Mint an installation token for the reviewer GitHub App, from the
// credentials in ~/.config/hero-pocock/ (never in the repo). Or copy the
// credentials of the personal `/lfg` skill there.
//
// Exit 3: the config has no `app: enabled`, so the caller posts as the user.
// Exit 4: the App is enabled but something is wrong (credentials, key, an
// HTTP error, the App not installed on the repo), so the caller stops. A
// broken App never falls back to the user: that would quietly turn the
// approval gate off.
//
// Output: the token (default), the bot login `<slug>[bot]` (`--login`), or
// nothing (`--check`). Errors never carry the token or the key.
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from './config.ts'
import { Failure } from './run-state.ts'

const PREFIX = 'review.ts app-token: '
const USAGE = `usage: review.ts app-token --repo O/R [--config <path>] [--login | --check]
       review.ts app-token --copy-from <lfg env file> [--force]`
const FIX = 'Fix the App credentials, or re-run /setup-review-pipeline'

export const ID_KEY = 'HERO_POCOCK_REVIEWER_APP_ID'
export const KEY_KEY = 'HERO_POCOCK_REVIEWER_APP_KEY'

// The env file, overridable for tests with HERO_POCOCK_REVIEWER_APP_ENV.
export function appEnvPath(): string {
  return process.env.HERO_POCOCK_REVIEWER_APP_ENV || join(homedir(), '.config', 'hero-pocock', 'reviewer-app.env')
}

function apiBase(): string {
  return (process.env.HERO_POCOCK_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
}

function broken(message: string): Failure {
  return new Failure(`${message}. ${FIX}.`, 4)
}

function expandHome(value: string): string {
  if (value === '~' || value === '$HOME') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  if (value.startsWith('$HOME/')) return join(homedir(), value.slice(6))
  return value
}

// `KEY=VALUE` lines: an optional `export ` prefix, optional matching quotes
// around the value, `#` comment lines and blank lines. Read as data, never run
// by a shell.
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    const quoted = /^(["'])(.*)\1$/.exec(value)
    if (quoted !== null) value = quoted[2]
    values.set(match[1], expandHome(value))
  }
  return values
}

async function loadCredentials(): Promise<{ id: string; key: KeyObject }> {
  const file = appEnvPath()
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const missing = (error as { code?: string }).code === 'ENOENT'
    throw broken(`the reviewer App is enabled but its env file ${file} ${missing ? 'does not exist' : 'cannot be read'}`)
  }
  const values = parseEnvFile(text)
  const id = values.get(ID_KEY) ?? ''
  const keyPath = values.get(KEY_KEY) ?? ''
  if (id === '') throw broken(`${file} sets no ${ID_KEY}`)
  if (keyPath === '') throw broken(`${file} sets no ${KEY_KEY}`)
  let pem: string
  try {
    pem = await readFile(keyPath, 'utf8')
  } catch (error) {
    throw broken(`cannot read the App private key ${keyPath} (${(error as { code?: string }).code ?? 'error'})`)
  }
  try {
    return { id, key: createPrivateKey(pem) }
  } catch {
    throw broken(`the App private key ${keyPath} is not a valid PEM private key`)
  }
}

const b64url = (text: string) => Buffer.from(text).toString('base64url')

// RS256 JWT: backdated 60 s for clock drift, valid 9 minutes (GitHub allows 10).
function appJwt(id: string, key: KeyObject): string {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: id }))}`
  try {
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key, 'base64url')}`
  } catch {
    throw broken('cannot sign the App JWT with the private key')
  }
}

// One GitHub API call as the App. `fetch`, not `gh api`: gh adds the user's
// own Authorization header.
async function call<T>(step: string, jwt: string, method: string, path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code
    throw broken(`${step}: cannot reach the GitHub API at ${apiBase()} (${cause ?? (error as Error).message})`)
  }
  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {
    // Some error answers have no JSON body; the status says enough.
  }
  if (!response.ok) {
    const said = (parsed as { message?: unknown } | null)?.message
    throw broken(`${step} failed: HTTP ${response.status}${typeof said === 'string' ? ` (${said})` : ''}`)
  }
  return (parsed ?? {}) as T
}

export type AppIdentity = { token: string; login: string }

// Mint a token for one repo and read the App's bot login. Throws Failure 4.
export async function mintAppToken(repo: string): Promise<AppIdentity> {
  const [owner, name] = repo.split('/')
  const { id, key } = await loadCredentials()
  const jwt = appJwt(id, key)

  let installation: { id?: unknown }
  try {
    installation = await call('find the App installation', jwt, 'GET', `/repos/${owner}/${name}/installation`)
  } catch (error) {
    if (error instanceof Failure && / HTTP 404/.test(error.message)) {
      throw broken(`the reviewer App is not installed on ${repo} (HTTP 404)`)
    }
    throw error
  }
  if (typeof installation.id !== 'number') throw broken('find the App installation: GitHub sent no installation id')

  const access = await call<{ token?: unknown }>('mint the installation token', jwt, 'POST', `/app/installations/${installation.id}/access_tokens`, {
    repositories: [name],
    permissions: { pull_requests: 'write', contents: 'read' },
  })
  if (typeof access.token !== 'string' || access.token === '') throw broken('mint the installation token: GitHub sent no token')

  const app = await call<{ slug?: unknown }>('read the App', jwt, 'GET', '/app')
  if (typeof app.slug !== 'string' || app.slug === '') throw broken('read the App: GitHub sent no slug')
  return { token: access.token, login: `${app.slug}[bot]` }
}

// Copy the credentials of the personal `/lfg` skill: its env file uses the
// LFG_ names and points at its own pem, so copying the env file as it is
// would be wrong. Copy the pem next to our env file, then write our env file
// with our names and the new key path. Exit 3: no lfg env file. Prints paths
// only, never the App ID or the key.
async function copyFrom(source: string, force: boolean): Promise<string> {
  let text: string
  try {
    text = await readFile(source, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw new Failure(`no lfg credentials at ${source}`, 3)
    throw new Failure(`cannot read ${source} (${(error as { code?: string }).code ?? 'error'})`, 4)
  }
  const values = parseEnvFile(text)
  const id = values.get('LFG_REVIEWER_APP_ID') ?? ''
  const sourceKey = values.get('LFG_REVIEWER_APP_KEY') ?? ''
  if (id === '') throw new Failure(`${source} sets no LFG_REVIEWER_APP_ID`, 4)
  if (sourceKey === '') throw new Failure(`${source} sets no LFG_REVIEWER_APP_KEY`, 4)
  let pem: string
  try {
    pem = await readFile(sourceKey, 'utf8')
    createPrivateKey(pem)
  } catch {
    throw new Failure(`the lfg private key ${sourceKey} cannot be read or is not a PEM private key`, 4)
  }

  const env = appEnvPath()
  const dir = dirname(env)
  const key = join(dir, 'reviewer-app.pem')
  if (!force) {
    for (const file of [env, key]) {
      const exists = await access(file).then(() => true, () => false)
      if (exists) throw new Failure(`${file} already exists: keep it, or copy over it with --force`, 1)
    }
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  // chmod after each write: on --force, writeFile keeps an existing file's mode.
  await writeFile(key, pem, { mode: 0o600 })
  await chmod(key, 0o600)
  await writeFile(env, `${ID_KEY}=${id}\n${KEY_KEY}=${key}\n`, { mode: 0o600 })
  await chmod(env, 0o600)
  return `${JSON.stringify({ copied: true, env, key })}\n`
}

async function appToken(argv: string[]): Promise<string> {
  let values
  try {
    values = parseArgs({
      args: argv,
      strict: true,
      options: {
        repo: { type: 'string' },
        config: { type: 'string' },
        login: { type: 'boolean' },
        check: { type: 'boolean' },
        'copy-from': { type: 'string' },
        force: { type: 'boolean' },
      },
    }).values
  } catch (error) {
    throw new Failure(`${(error as Error).message}\n${USAGE}`, 2)
  }
  const source = values['copy-from']
  if (source !== undefined) {
    if (values.repo !== undefined || values.config !== undefined || values.login || values.check) {
      throw new Failure(`--copy-from goes with --force only\n${USAGE}`, 2)
    }
    return copyFrom(source, values.force === true)
  }
  if (values.force) throw new Failure(`--force goes with --copy-from only\n${USAGE}`, 2)
  const { repo } = values
  if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Failure(`--repo must be OWNER/REPO\n${USAGE}`, 2)
  if (values.login && values.check) throw new Failure(`--login and --check do not go together\n${USAGE}`, 2)

  // The pipeline never gets here without a valid config, so any problem is broken (4).
  const loaded = await loadConfig(values.config)
  if (!loaded.ok) throw new Failure(loaded.message, 4)
  if (!loaded.config.app) {
    throw new Failure('no reviewer App configured for this repo (no "app: enabled" in the config): post as the user', 3)
  }

  const minted = await mintAppToken(repo)
  if (values.check) return ''
  return `${values.login ? minted.login : minted.token}\n`
}

export async function main(argv: string[]): Promise<number> {
  try {
    process.stdout.write(await appToken(argv))
    return 0
  } catch (error) {
    if (!(error instanceof Failure)) throw error
    process.stderr.write(`${PREFIX}${error.message}\n`)
    return error.code
  }
}
