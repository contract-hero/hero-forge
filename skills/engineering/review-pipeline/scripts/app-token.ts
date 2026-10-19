// `review.ts app-token` (usage in the table in cli.ts).
// Check that a GitHub App can mint an installation token for the repo, from
// its credentials in ~/.config/hero-forge/ (never in the repo), or print its
// bot login. Two Apps, each with its own env file: `reviewer` (the default)
// posts the reviews and merges, `implementer` builds the tickets.
//
// It never prints the token: any agent with a shell could take it and
// approve its own PR. post-review mints its own token in-process
// (mintAppToken) for each post.
//
// Exit 3: the App is not switched on in the config, so the caller posts as
// the user. Each App has its own switch: `app: enabled` for the reviewer,
// `implementer.app: enabled` (in the `implementer:` block) for the
// implementer.
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

const FIX = 'Fix the App credentials, or re-run /setup-forge'

export const APPS = ['reviewer', 'implementer'] as const

export type AppName = (typeof APPS)[number]

// Each App's env file holds HERO_FORGE_<NAME>_APP_ID and HERO_FORGE_<NAME>_APP_KEY
// (a path to the PEM key). The token asks only for what the App does: the
// reviewer posts reviews, the implementer also pushes, comments and labels.
const APP: Record<AppName, { prefix: string; permissions: Record<string, string> }> = {
  reviewer: { prefix: 'HERO_FORGE_REVIEWER_APP', permissions: { pull_requests: 'write', contents: 'read' } },
  implementer: {
    prefix: 'HERO_FORGE_IMPLEMENTER_APP',
    permissions: { contents: 'write', pull_requests: 'write', issues: 'write' },
  },
}

// The env file, overridable for tests with HERO_FORGE_<NAME>_APP_ENV.
export function appEnvPath(app: AppName = 'reviewer'): string {
  return process.env[`${APP[app].prefix}_ENV`] || join(homedir(), '.config', 'hero-forge', `${app}-app.env`)
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

async function loadCredentials(app: AppName): Promise<{ id: string; key: KeyObject }> {
  const file = appEnvPath(app)
  const ID_KEY = `${APP[app].prefix}_ID`
  const KEY_KEY = `${APP[app].prefix}_KEY`
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const missing = (error as { code?: string }).code === 'ENOENT'
    throw broken(`the ${app} App is enabled but its env file ${file} ${missing ? 'does not exist' : 'cannot be read'}`)
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
  return (await request<T>(step, jwt, method, path, body)).parsed
}

// `call`, with the answer's Link header (null without one).
async function request<T>(step: string, jwt: string, method: string, path: string, body?: unknown): Promise<{ parsed: T; link: string | null }> {
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
    parsed = parseExact(await response.text())
  } catch {
    // Some error answers have no JSON body; the status says enough.
  }
  if (!response.ok) {
    const said = (parsed as { message?: unknown } | null)?.message
    throw new ApiFailure(`${step} failed: HTTP ${response.status}${typeof said === 'string' ? ` (${said})` : ''}. ${FIX}.`, response.status)
  }
  return { parsed: (parsed ?? {}) as T, link: response.headers.get('link') }
}

// JSON.parse, but an integer a JS number cannot hold exactly (above 2^53, as
// GitHub's webhook delivery ids are) stays as its exact digits, a string.
function parseExact(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source ?? '') ? context!.source : value,
  )
}

// An HTTP error answer from GitHub (exit 4), with its status, so a caller can
// tell a 404 from a broken App.
export class ApiFailure extends Failure {
  status: number
  constructor(message: string, status: number) {
    super(message, 4)
    this.status = status
  }
}

// GitHub API calls as the App itself, signed with its JWT (not an
// installation token): what `delivery` and `app-check` read. The JWT stays in
// this process. Throws Failure 4 when the credentials are broken.
// `page` GETs one page of a list and gives the `cursor` of the next page
// from the Link header (null on the last page). Only the cursor is taken
// from the link: the next request goes to the same API, whatever host the
// link names.
export type AppApi = {
  <T>(step: string, method: string, path: string): Promise<T>
  page: <T>(step: string, path: string) => Promise<{ body: T; cursor: string | null }>
}

function nextCursor(link: string | null): string | null {
  const url = /<([^>]+)>\s*;\s*rel="next"/.exec(link ?? '')?.[1]
  if (url === undefined) return null
  try {
    return new URL(url).searchParams.get('cursor')
  } catch {
    return null
  }
}

export async function appApi(app: AppName): Promise<AppApi> {
  const { id, key } = await loadCredentials(app)
  const jwt = appJwt(id, key)
  const api = (<T>(step: string, method: string, path: string) => call<T>(step, jwt, method, path)) as AppApi
  api.page = async <T>(step: string, path: string) => {
    const { parsed, link } = await request<T>(step, jwt, 'GET', path)
    return { body: parsed, cursor: nextCursor(link) }
  }
  return api
}

export type AppIdentity = { token: string; login: string }

// Mint a token for one repo, scoped to `permissions` (by default what the App
// does, from APP), and read the App's bot login. Throws Failure 4.
export async function mintAppToken(
  repo: string,
  app: AppName = 'reviewer',
  permissions: Record<string, string> = APP[app].permissions,
): Promise<AppIdentity> {
  const [owner, name] = repo.split('/')
  const { id, key } = await loadCredentials(app)
  const jwt = appJwt(id, key)

  let installation: { id?: unknown }
  try {
    installation = await call('find the App installation', jwt, 'GET', `/repos/${owner}/${name}/installation`)
  } catch (error) {
    if (error instanceof Failure && / HTTP 404/.test(error.message)) {
      throw broken(`the ${app} App is not installed on ${repo} (HTTP 404)`)
    }
    throw error
  }
  if (typeof installation.id !== 'number') throw broken('find the App installation: GitHub sent no installation id')

  const access = await call<{ token?: unknown }>('mint the installation token', jwt, 'POST', `/app/installations/${installation.id}/access_tokens`, {
    repositories: [name],
    permissions,
  })
  if (typeof access.token !== 'string' || access.token === '') throw broken('mint the installation token: GitHub sent no token')

  const self = await call<{ slug?: unknown }>('read the App', jwt, 'GET', '/app')
  if (typeof self.slug !== 'string' || self.slug === '') throw broken('read the App: GitHub sent no slug')
  return { token: access.token, login: `${self.slug}[bot]` }
}

const usage = usageFor('app-token')

async function appToken(argv: string[]): Promise<string> {
  const { values } = parse(
    argv,
    {
      repo: { type: 'string' },
      app: { type: 'string', default: 'reviewer' },
      config: { type: 'string' },
      login: { type: 'boolean' },
      check: { type: 'boolean' },
    },
    usage,
  )
  const { repo } = values
  if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw usage('--repo must be OWNER/REPO')
  const app = values.app as AppName
  if (!APPS.includes(app)) throw usage(`--app must be ${APPS.join(' or ')}`)
  if (values.login && values.check) throw usage('--login and --check do not go together')
  if (!values.login && !values.check) throw usage('app-token needs --check or --login: it never prints a token (post-review mints its own)')

  // The pipeline never gets here without a valid config, so any problem is broken (4).
  const loaded = await loadConfig(values.config)
  if (!loaded.ok) throw new Failure(loaded.message, 4)
  const on = app === 'implementer' ? loaded.config.implementer.app : loaded.config.app
  if (!on) {
    const key = app === 'implementer' ? 'implementer.app: enabled' : 'app: enabled'
    throw new Failure(`no ${app} App configured for this repo (no "${key}" in the config): post as the user`, 3)
  }

  const minted = await mintAppToken(repo, app)
  return values.login ? `${minted.login}\n` : ''
}

export const main = runMain('app-token', appToken)
