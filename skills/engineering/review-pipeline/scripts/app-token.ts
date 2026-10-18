// `review.ts app-token` (usage in the table in cli.ts).
// Check that the reviewer GitHub App can mint an installation token for the
// repo, from the credentials in ~/.config/hero-forge/ (never in the repo),
// or print its bot login.
//
// It never prints the token: any agent with a shell could take it and
// approve its own PR. post-review mints its own token in-process
// (mintAppToken) for each post.
//
// Exit 3: the config has no `app: enabled`, so the caller posts as the user.
// Exit 4: the App is enabled but something is wrong (credentials, key, an
// HTTP error, the App not installed on the repo), so the caller stops. A
// broken App never falls back to the user: that would quietly turn the
// approval gate off.
//
// Output: the bot login `<slug>[bot]` (`--login`), or nothing (`--check`).
// Errors never carry the token or the key.
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { Failure, parse, runMain, usageFor } from './cli.ts'

const FIX = 'Fix the App credentials, or re-run /setup-review-pipeline'

export const ID_KEY = 'HERO_FORGE_REVIEWER_APP_ID'
export const KEY_KEY = 'HERO_FORGE_REVIEWER_APP_KEY'

// The env file, overridable for tests with HERO_FORGE_REVIEWER_APP_ENV.
export function appEnvPath(): string {
  return process.env.HERO_FORGE_REVIEWER_APP_ENV || join(homedir(), '.config', 'hero-forge', 'reviewer-app.env')
}

function apiBase(): string {
  return (process.env.HERO_FORGE_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
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
    const [, name = '', rawValue = ''] = match
    let value = rawValue.trim()
    const quoted = /^(["'])(.*)\1$/.exec(value)
    if (quoted !== null) value = quoted[2] ?? ''
    values.set(name, expandHome(value))
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

const usage = usageFor('app-token')

async function appToken(argv: string[]): Promise<string> {
  const { values } = parse(
    argv,
    {
      repo: { type: 'string' },
      config: { type: 'string' },
      login: { type: 'boolean' },
      check: { type: 'boolean' },
    },
    usage,
  )
  const { repo } = values
  if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw usage('--repo must be OWNER/REPO')
  if (values.login && values.check) throw usage('--login and --check do not go together')
  if (!values.login && !values.check) throw usage('app-token needs --check or --login: it never prints a token (post-review mints its own)')

  // The pipeline never gets here without a valid config, so any problem is broken (4).
  const loaded = await loadConfig(values.config)
  if (!loaded.ok) throw new Failure(loaded.message, 4)
  if (!loaded.config.app) {
    throw new Failure('no reviewer App configured for this repo (no "app: enabled" in the config): post as the user', 3)
  }

  const minted = await mintAppToken(repo)
  return values.login ? `${minted.login}\n` : ''
}

export const main = runMain('app-token', appToken)
