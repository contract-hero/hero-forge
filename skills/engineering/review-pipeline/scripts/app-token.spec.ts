import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { appKey, baseEnv, fakeGitHubApi, runCli, tempDir, type FakeApiRoute } from './test-helpers.ts'

const REPO = 'contract-hero/hero-forge'
const NO_APP = '# Review pipeline\n\n```yaml\nruntime: claude\n```\n'
const WITH_APP = '# Review pipeline\n\n```yaml\nruntime: claude\napp: enabled\n```\n'
// The Implementer App's switch is its own: implementer.app, not app.
const WITH_IMPLEMENTER = '# Review pipeline\n\n```yaml\nruntime: claude\nimplementer:\n  app: enabled\n```\n'
const TOKEN = 'ghs_faketoken0123456789'

// GitHub's three answers for a working App installed on the repo.
const WORKING: Record<string, FakeApiRoute> = {
  [`GET /repos/${REPO}/installation`]: { status: 200, body: { id: 4242 } },
  'POST /app/installations/4242/access_tokens': { status: 201, body: { token: TOKEN, expires_at: '2099-01-01T00:00:00Z' } },
  'GET /app': { status: 200, body: { slug: 'hero-reviewer' } },
}

// `env`: the env file's text, a function of the temp dir that returns it, or
// null for no env file.
type Setup = {
  app?: 'reviewer' | 'implementer'
  config?: string
  env?: string | ((dir: string) => string) | null
  routes?: Record<string, FakeApiRoute>
  wrongKey?: boolean
}

// A temp dir with a config, a fresh App key, an env file naming it, and a fake
// GitHub API that trusts that key (or another one, with `wrongKey`).
async function setup(t: Parameters<typeof tempDir>[0], options: Setup = {}) {
  const dir = await tempDir(t)
  const configPath = join(dir, 'review.md')
  await writeFile(configPath, options.config ?? (options.app === 'implementer' ? WITH_IMPLEMENTER : WITH_APP))
  const key = await appKey(dir)
  const trusted = options.wrongKey ? (await appKey(dir, 'other.pem')).publicKey : key.publicKey
  const api = await fakeGitHubApi(t, trusted, options.routes ?? WORKING)
  // With `app`, the env file and env var of that App, and `--app` on every call.
  const NAME = (options.app ?? 'reviewer').toUpperCase()
  const envFile = join(dir, `${options.app ?? 'reviewer'}-app.env`)
  if (options.env !== null) {
    const text = typeof options.env === 'function' ? options.env(dir) : options.env
    await writeFile(envFile, text ?? `HERO_FORGE_${NAME}_APP_ID=123456\nHERO_FORGE_${NAME}_APP_KEY=${key.pem}\n`)
  }
  const env = { ...baseEnv(), [`HERO_FORGE_${NAME}_APP_ENV`]: envFile, HERO_FORGE_GITHUB_API_URL: api.url }
  const appFlag = options.app === undefined ? [] : ['--app', options.app]
  // `--check` unless the test names its own flags.
  const mint = (...extra: string[]) =>
    runCli(['app-token', '--repo', REPO, '--config', configPath, ...appFlag, ...(extra.length === 0 ? ['--check'] : extra)], { env })
  return { dir, key, api, envFile, mint, env, configPath }
}

test('no App in the config exits 3 and calls no API', async (t) => {
  const s = await setup(t, { config: NO_APP })
  const { code, stdout, stderr } = await s.mint()
  assert.equal(code, 3)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts app-token: no reviewer App configured for this repo/m)
  assert.deepEqual(s.api.requests, [])
})

test('--check mints a token for this one repo, signed by the App key, and prints nothing', async (t) => {
  const s = await setup(t)
  const { code, stdout, stderr } = await s.mint('--check')
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.equal(stdout, '')
  assert.deepEqual(
    s.api.requests.map((r) => [r.method, r.path, r.jwt_ok, r.iss, r.accept, r.api_version]),
    [
      ['GET', `/repos/${REPO}/installation`, true, '123456', 'application/vnd.github+json', '2022-11-28'],
      ['POST', '/app/installations/4242/access_tokens', true, '123456', 'application/vnd.github+json', '2022-11-28'],
      ['GET', '/app', true, '123456', 'application/vnd.github+json', '2022-11-28'],
    ],
  )
  assert.deepEqual(s.api.requests[1]?.body, {
    repositories: ['hero-forge'],
    permissions: { pull_requests: 'write', contents: 'read' },
  })
})

test('--login prints the App bot login and --check prints nothing', async (t) => {
  const s = await setup(t)
  assert.deepEqual(await s.mint('--login'), { code: 0, stdout: 'hero-reviewer[bot]\n', stderr: '' })
  assert.deepEqual(await s.mint('--check'), { code: 0, stdout: '', stderr: '' })
})

test('without --check or --login it is a usage error, calls no API, and never prints a token', async (t) => {
  const s = await setup(t)
  const { code, stdout, stderr } = await runCli(['app-token', '--repo', REPO, '--config', s.configPath], { env: s.env })
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts app-token: app-token needs --check or --login: it never prints a token \(post-review mints its own\)\n/)
  assert.deepEqual(s.api.requests, [])
})

const BROKEN: [string, Setup, RegExp][] = [
  ['the env file is missing', { env: null }, /env file .*reviewer-app\.env does not exist/],
  ['the env file has no App ID', { env: 'HERO_FORGE_REVIEWER_APP_KEY=/x.pem\n' }, /sets no HERO_FORGE_REVIEWER_APP_ID/],
  ['the env file has no key path', { env: 'HERO_FORGE_REVIEWER_APP_ID=1\n' }, /sets no HERO_FORGE_REVIEWER_APP_KEY/],
  [
    'the key file does not exist',
    { env: (dir) => `HERO_FORGE_REVIEWER_APP_ID=1\nHERO_FORGE_REVIEWER_APP_KEY=${join(dir, 'gone.pem')}\n` },
    /cannot read the App private key .*gone\.pem \(ENOENT\)/,
  ],
  [
    'the key file is not a PEM key',
    { env: (dir) => `HERO_FORGE_REVIEWER_APP_ID=1\nHERO_FORGE_REVIEWER_APP_KEY=${join(dir, 'review.md')}\n` },
    /the App private key .*review\.md is not a valid PEM private key/,
  ],
  ['the key is not the App key (GitHub answers 401)', { wrongKey: true }, /find the App installation failed: HTTP 401 \(A JSON web token could not be decoded\)/],
  [
    'the App is not installed on the repo (404)',
    { routes: { ...WORKING, [`GET /repos/${REPO}/installation`]: { status: 404, body: { message: 'Not Found' } } } },
    /the reviewer App is not installed on contract-hero\/hero-forge \(HTTP 404\)/,
  ],
  [
    'GitHub refuses the token',
    { routes: { ...WORKING, 'POST /app/installations/4242/access_tokens': { status: 422, body: { message: 'no access to hero-forge' } } } },
    /mint the installation token failed: HTTP 422 \(no access to hero-forge\)/,
  ],
  ['the config is invalid', { config: '```yaml\nruntime: claude\napp: yes\n```\n' }, /app must be "enabled" or left out/],
  [
    'the env file uses only the old HERO_POCOCK_ key names',
    { env: (dir) => `HERO_POCOCK_REVIEWER_APP_ID=1\nHERO_POCOCK_REVIEWER_APP_KEY=${join(dir, 'reviewer-app.pem')}\n` },
    /sets no HERO_FORGE_REVIEWER_APP_ID/,
  ],
]

for (const [name, options, message] of BROKEN) {
  test(`a broken App exits 4 and prints no token: ${name}`, async (t) => {
    const s = await setup(t, options)
    const { code, stdout, stderr } = await s.mint()
    assert.equal(code, 4)
    assert.equal(stdout, '')
    assert.match(stderr, /^review\.ts app-token: /)
    assert.match(stderr, message)
    assert.doesNotMatch(stderr, new RegExp(TOKEN))
    assert.doesNotMatch(stderr, /PRIVATE KEY/)
  })
}

test('a missing config exits 4: the pipeline never asks for a token without one', async (t) => {
  const s = await setup(t)
  const { code, stderr } = await runCli(['app-token', '--repo', REPO, '--config', join(s.dir, 'nope.md'), '--check'], {
    env: { ...baseEnv(), HERO_FORGE_REVIEWER_APP_ENV: s.envFile, HERO_FORGE_GITHUB_API_URL: s.api.url },
  })
  assert.equal(code, 4)
  assert.match(stderr, /no review config at/)
  assert.deepEqual(s.api.requests, [])
})

test('an unreachable GitHub API exits 4', async (t) => {
  const s = await setup(t)
  const { code, stderr } = await runCli(['app-token', '--repo', REPO, '--config', join(s.dir, 'review.md'), '--check'], {
    env: { ...baseEnv(), HERO_FORGE_REVIEWER_APP_ENV: s.envFile },
  })
  assert.equal(code, 4)
  assert.match(stderr, /find the App installation: cannot reach the GitHub API at http:\/\/127\.0\.0\.1:9/)
})

test('the old App env names and the LFG_ credentials are ignored: the hero-forge env file is missing', async (t) => {
  const s = await setup(t, { env: null })
  const home = join(s.dir, 'home')
  const old = join(s.dir, 'old.env')
  await writeFile(old, `HERO_POCOCK_REVIEWER_APP_ID=123456\nHERO_POCOCK_REVIEWER_APP_KEY=${s.key.pem}\nHERO_FORGE_REVIEWER_APP_ID=123456\nHERO_FORGE_REVIEWER_APP_KEY=${s.key.pem}\n`)
  const env: Record<string, string | undefined> = {
    ...baseEnv(),
    HOME: home,
    HERO_POCOCK_REVIEWER_APP_ENV: old,
    HERO_POCOCK_GITHUB_API_URL: s.api.url,
    HERO_FORGE_GITHUB_API_URL: s.api.url,
    LFG_REVIEWER_APP_ID: '987654',
    LFG_REVIEWER_APP_KEY: s.key.pem,
  }
  delete env.HERO_FORGE_REVIEWER_APP_ENV
  const { code, stdout, stderr } = await runCli(['app-token', '--repo', REPO, '--config', s.configPath, '--check'], { env })
  assert.equal(code, 4)
  assert.equal(stdout, '')
  const expected = join(home, '.config', 'hero-forge', 'reviewer-app.env').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(stderr, new RegExp(`env file ${expected} does not exist`))
  assert.deepEqual(s.api.requests, [])
})

test('the old HERO_POCOCK_GITHUB_API_URL is ignored, also when HERO_FORGE_GITHUB_API_URL is unset', async (t) => {
  const s = await setup(t, { env: (dir) => `HERO_FORGE_REVIEWER_APP_ID=123456\nHERO_FORGE_REVIEWER_APP_KEY=${join(dir, 'reviewer-app.pem')}\n` })
  // With no HERO_FORGE_GITHUB_API_URL the CLI uses its default endpoint. A
  // preload stubs fetch in the child so that call fails at once and never
  // reaches the real api.github.com.
  const preload = join(dirname(s.envFile), 'no-default-api.mjs')
  await writeFile(
    preload,
    "const real = globalThis.fetch\nglobalThis.fetch = (url, init) => String(url).startsWith('https://api.github.com/') ? Promise.reject(new Error('stubbed default endpoint')) : real(url, init)\n",
  )
  const env: Record<string, string | undefined> = {
    ...baseEnv(),
    HERO_FORGE_REVIEWER_APP_ENV: s.envFile,
    HERO_POCOCK_GITHUB_API_URL: s.api.url,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  }
  delete env.HERO_FORGE_GITHUB_API_URL
  const { code, stderr } = await runCli(['app-token', '--repo', REPO, '--config', s.configPath, '--check'], { env })
  assert.equal(code, 4)
  assert.match(stderr, /find the App installation: cannot reach the GitHub API at https:\/\/api\.github\.com/)
  assert.deepEqual(s.api.requests, [])
})

test('bad arguments are a usage error (exit 2)', async (t) => {
  const s = await setup(t)
  for (const args of [[], ['--repo', 'nope'], ['--repo', REPO, '--login', '--check'], ['--repo', REPO, '--bogus'], ['--copy-from', '/x'], ['--repo', REPO, '--check', '--force']]) {
    const { code, stderr } = await runCli(['app-token', ...args], { env: baseEnv() })
    assert.equal(code, 2, `${args.join(' ')}: ${stderr}`)
    assert.match(stderr, /usage: review\.ts app-token/)
  }
  assert.deepEqual(s.api.requests, [])
})

test('the env file is read as data: export, quotes, comments and a ~/ key path', async (t) => {
  const dir = await tempDir(t)
  const home = join(dir, 'home')
  const appDir = join(home, '.config', 'hero-forge')
  await mkdir(appDir, { recursive: true })
  const key = await appKey(appDir)
  const api = await fakeGitHubApi(t, key.publicKey, WORKING)
  const configPath = join(dir, 'review.md')
  await writeFile(configPath, WITH_APP)
  await writeFile(
    join(appDir, 'reviewer-app.env'),
    `# reviewer App\n\nexport HERO_FORGE_REVIEWER_APP_ID="Iv23liFAKE"\nHERO_FORGE_REVIEWER_APP_KEY='~/.config/hero-forge/reviewer-app.pem'\n`,
  )
  // No HERO_FORGE_REVIEWER_APP_ENV: the default path under this test's HOME is used.
  const env: Record<string, string | undefined> = { ...baseEnv(), HOME: home, HERO_FORGE_GITHUB_API_URL: `${api.url}/` }
  delete env.HERO_FORGE_REVIEWER_APP_ENV
  const { code, stdout, stderr } = await runCli(['app-token', '--repo', REPO, '--config', configPath, '--login'], { env })
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.equal(stdout, 'hero-reviewer[bot]\n')
  assert.equal(api.requests[0]?.iss, 'Iv23liFAKE')
})

// The implementer App: its own env file and key names, its own slug.
const IMPLEMENTER: Record<string, FakeApiRoute> = { ...WORKING, 'GET /app': { status: 200, body: { slug: 'hero-implementer' } } }

test('--app implementer --check mints a token from the implementer env file and prints nothing', async (t) => {
  const s = await setup(t, { app: 'implementer', routes: IMPLEMENTER })
  const { code, stdout, stderr } = await s.mint('--check')
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.equal(stdout, '')
  assert.deepEqual(
    s.api.requests.map((r) => [r.method, r.path, r.jwt_ok, r.iss]),
    [
      ['GET', `/repos/${REPO}/installation`, true, '123456'],
      ['POST', '/app/installations/4242/access_tokens', true, '123456'],
      ['GET', '/app', true, '123456'],
    ],
  )
  // The Implementer pushes branches, opens pull requests, comments and labels.
  assert.deepEqual(s.api.requests[1]?.body, {
    repositories: ['hero-forge'],
    permissions: { contents: 'write', pull_requests: 'write', issues: 'write' },
  })
})

test('--app implementer --login prints the implementer App bot login', async (t) => {
  const s = await setup(t, { app: 'implementer', routes: IMPLEMENTER })
  assert.deepEqual(await s.mint('--login'), { code: 0, stdout: 'hero-implementer[bot]\n', stderr: '' })
})

const IMPLEMENTER_OFF: [string, string][] = [
  ['no App in the config', NO_APP],
  ['only the reviewer App enabled (app: enabled)', WITH_APP],
  ['implementer.app: disabled', '# Review pipeline\n\n```yaml\nruntime: claude\napp: enabled\nimplementer:\n  app: disabled\n```\n'],
  ['an implementer block with no app key', '# Review pipeline\n\n```yaml\nruntime: claude\nimplementer:\n  attempts: 2\n```\n'],
]

for (const [name, config] of IMPLEMENTER_OFF) {
  test(`--app implementer with ${name} exits 3 and calls no API`, async (t) => {
    const s = await setup(t, { app: 'implementer', routes: IMPLEMENTER, config })
    const { code, stdout, stderr } = await s.mint('--login')
    assert.equal(code, 3)
    assert.equal(stdout, '')
    assert.equal(
      stderr,
      'review.ts app-token: no implementer App configured for this repo (no "implementer.app: enabled" in the config): post as the user\n',
    )
    assert.deepEqual(s.api.requests, [])
  })
}

test('the reviewer App does not answer to implementer.app', async (t) => {
  const s = await setup(t, { config: WITH_IMPLEMENTER })
  const { code, stderr } = await s.mint('--check')
  assert.equal(code, 3)
  assert.match(stderr, /^review\.ts app-token: no reviewer App configured for this repo \(no "app: enabled" in the config\)/)
  assert.deepEqual(s.api.requests, [])
})

test('--app implementer with no override reads ~/.config/hero-forge/implementer-app.env', async (t) => {
  const s = await setup(t, { app: 'implementer', routes: IMPLEMENTER })
  const home = join(s.dir, 'home')
  const configDir = join(home, '.config', 'hero-forge')
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'implementer-app.env'), `HERO_FORGE_IMPLEMENTER_APP_ID=123456\nHERO_FORGE_IMPLEMENTER_APP_KEY=${s.key.pem}\n`)
  // A reviewer env file at its default path too: the implementer must not pick it.
  await writeFile(join(configDir, 'reviewer-app.env'), 'HERO_FORGE_REVIEWER_APP_ID=999\nHERO_FORGE_REVIEWER_APP_KEY=/no/such/key.pem\n')
  const env: Record<string, string | undefined> = { ...s.env, HOME: home }
  delete env.HERO_FORGE_IMPLEMENTER_APP_ENV
  delete env.HERO_FORGE_REVIEWER_APP_ENV
  const { code, stdout, stderr } = await runCli(['app-token', '--repo', REPO, '--config', s.configPath, '--app', 'implementer', '--login'], { env })
  assert.deepEqual({ code, stdout, stderr }, { code: 0, stdout: 'hero-implementer[bot]\n', stderr: '' })
})

test('--app implementer never reads the reviewer env file', async (t) => {
  // A working reviewer env file, and no implementer env var: the default
  // implementer path is one baseEnv points at nothing. Both Apps are on.
  const s = await setup(t, { config: '# Review pipeline\n\n```yaml\nruntime: claude\napp: enabled\nimplementer:\n  app: enabled\n```\n' })
  const { code, stdout, stderr } = await runCli(['app-token', '--repo', REPO, '--config', s.configPath, '--app', 'implementer', '--check'], { env: s.env })
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts app-token: the implementer App is enabled but its env file .*implementer-app\.env does not exist/)
  assert.deepEqual(s.api.requests, [])
})

const BROKEN_IMPLEMENTER: [string, Setup, RegExp][] = [
  ['the env file is missing', { env: null }, /the implementer App is enabled but its env file .*implementer-app\.env does not exist/],
  [
    'the env file uses the reviewer key names',
    { env: (dir) => `HERO_FORGE_REVIEWER_APP_ID=1\nHERO_FORGE_REVIEWER_APP_KEY=${join(dir, 'reviewer-app.pem')}\n` },
    /sets no HERO_FORGE_IMPLEMENTER_APP_ID/,
  ],
  ['the env file has no key path', { env: 'HERO_FORGE_IMPLEMENTER_APP_ID=1\n' }, /sets no HERO_FORGE_IMPLEMENTER_APP_KEY/],
  [
    'the key file is not a PEM key',
    { env: (dir) => `HERO_FORGE_IMPLEMENTER_APP_ID=1\nHERO_FORGE_IMPLEMENTER_APP_KEY=${join(dir, 'review.md')}\n` },
    /the App private key .*review\.md is not a valid PEM private key/,
  ],
  ['the key is not the App key (GitHub answers 401)', { wrongKey: true }, /find the App installation failed: HTTP 401/],
  [
    'the App is not installed on the repo (404)',
    { routes: { ...IMPLEMENTER, [`GET /repos/${REPO}/installation`]: { status: 404, body: { message: 'Not Found' } } } },
    /the implementer App is not installed on contract-hero\/hero-forge \(HTTP 404\)/,
  ],
  [
    'the App lacks a permission the token asks for (422)',
    { routes: { ...IMPLEMENTER, 'POST /app/installations/4242/access_tokens': { status: 422, body: { message: 'permission contents not granted' } } } },
    /mint the installation token failed: HTTP 422 \(permission contents not granted\)/,
  ],
  ['the config is invalid', { config: '```yaml\nruntime: claude\napp: yes\n```\n' }, /app must be "enabled" or left out/],
]

for (const [name, options, message] of BROKEN_IMPLEMENTER) {
  test(`a broken implementer App exits 4 and prints no token: ${name}`, async (t) => {
    const s = await setup(t, { app: 'implementer', routes: IMPLEMENTER, ...options })
    const { code, stdout, stderr } = await s.mint()
    assert.equal(code, 4)
    assert.equal(stdout, '')
    assert.match(stderr, /^review\.ts app-token: /)
    assert.match(stderr, message)
    assert.doesNotMatch(stderr, new RegExp(TOKEN))
    assert.doesNotMatch(stderr, /PRIVATE KEY/)
  })
}

test('--app reviewer is the same as no --app', async (t) => {
  const s = await setup(t)
  const plain = await s.mint('--login')
  assert.deepEqual(await s.mint('--app', 'reviewer', '--login'), plain)
  const none = await setup(t, { config: NO_APP })
  assert.deepEqual(await none.mint('--app', 'reviewer', '--check'), await none.mint('--check'))
})

test('an unknown --app is a usage error (exit 2) and calls no API', async (t) => {
  const s = await setup(t)
  for (const args of [['--app', 'bogus'], ['--app', 'Reviewer'], ['--app', '']]) {
    const { code, stdout, stderr } = await runCli(['app-token', '--repo', REPO, '--config', s.configPath, ...args, '--check'], { env: s.env })
    assert.equal(code, 2, `${args.join(' ')}: ${stderr}`)
    assert.equal(stdout, '')
    assert.match(stderr, /^review\.ts app-token: --app must be reviewer or implementer\nusage: review\.ts app-token/)
  }
  assert.deepEqual(s.api.requests, [])
})
