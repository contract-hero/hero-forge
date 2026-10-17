import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { appKey, baseEnv, fakeGitHubApi, runCli, tempDir, type FakeApiRoute } from './test-helpers.ts'

const REPO = 'contract-hero/hero-pocock'
const NO_APP = '# Review pipeline\n\n```yaml\nruntime: claude\n```\n'
const WITH_APP = '# Review pipeline\n\n```yaml\nruntime: claude\napp: enabled\n```\n'
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
  await writeFile(configPath, options.config ?? WITH_APP)
  const key = await appKey(dir)
  const trusted = options.wrongKey ? (await appKey(dir, 'other.pem')).publicKey : key.publicKey
  const api = await fakeGitHubApi(t, trusted, options.routes ?? WORKING)
  const envFile = join(dir, 'reviewer-app.env')
  if (options.env !== null) {
    const text = typeof options.env === 'function' ? options.env(dir) : options.env
    await writeFile(envFile, text ?? `HERO_POCOCK_REVIEWER_APP_ID=123456\nHERO_POCOCK_REVIEWER_APP_KEY=${key.pem}\n`)
  }
  const env = { ...baseEnv(), HERO_POCOCK_REVIEWER_APP_ENV: envFile, HERO_POCOCK_GITHUB_API_URL: api.url }
  const mint = (...extra: string[]) => runCli(['app-token', '--repo', REPO, '--config', configPath, ...extra], { env })
  return { dir, key, api, envFile, mint }
}

test('no App in the config exits 3 and calls no API', async (t) => {
  const s = await setup(t, { config: NO_APP })
  const { code, stdout, stderr } = await s.mint()
  assert.equal(code, 3)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts app-token: no reviewer App configured for this repo/m)
  assert.deepEqual(s.api.requests, [])
})

test('a working App prints the minted token, signed by its key, for this one repo', async (t) => {
  const s = await setup(t)
  const { code, stdout, stderr } = await s.mint()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.equal(stdout, `${TOKEN}\n`)
  assert.deepEqual(
    s.api.requests.map((r) => [r.method, r.path, r.jwt_ok, r.iss, r.accept, r.api_version]),
    [
      ['GET', `/repos/${REPO}/installation`, true, '123456', 'application/vnd.github+json', '2022-11-28'],
      ['POST', '/app/installations/4242/access_tokens', true, '123456', 'application/vnd.github+json', '2022-11-28'],
      ['GET', '/app', true, '123456', 'application/vnd.github+json', '2022-11-28'],
    ],
  )
  assert.deepEqual(s.api.requests[1].body, {
    repositories: ['hero-pocock'],
    permissions: { pull_requests: 'write', contents: 'read' },
  })
})

test('--login prints the App bot login and --check prints nothing', async (t) => {
  const s = await setup(t)
  assert.deepEqual(await s.mint('--login'), { code: 0, stdout: 'hero-reviewer[bot]\n', stderr: '' })
  assert.deepEqual(await s.mint('--check'), { code: 0, stdout: '', stderr: '' })
})

const BROKEN: [string, Setup, RegExp][] = [
  ['the env file is missing', { env: null }, /env file .*reviewer-app\.env does not exist/],
  ['the env file has no App ID', { env: 'HERO_POCOCK_REVIEWER_APP_KEY=/x.pem\n' }, /sets no HERO_POCOCK_REVIEWER_APP_ID/],
  ['the env file has no key path', { env: 'HERO_POCOCK_REVIEWER_APP_ID=1\n' }, /sets no HERO_POCOCK_REVIEWER_APP_KEY/],
  [
    'the key file does not exist',
    { env: (dir) => `HERO_POCOCK_REVIEWER_APP_ID=1\nHERO_POCOCK_REVIEWER_APP_KEY=${join(dir, 'gone.pem')}\n` },
    /cannot read the App private key .*gone\.pem \(ENOENT\)/,
  ],
  [
    'the key file is not a PEM key',
    { env: (dir) => `HERO_POCOCK_REVIEWER_APP_ID=1\nHERO_POCOCK_REVIEWER_APP_KEY=${join(dir, 'review.md')}\n` },
    /the App private key .*review\.md is not a valid PEM private key/,
  ],
  ['the key is not the App key (GitHub answers 401)', { wrongKey: true }, /find the App installation failed: HTTP 401 \(A JSON web token could not be decoded\)/],
  [
    'the App is not installed on the repo (404)',
    { routes: { ...WORKING, [`GET /repos/${REPO}/installation`]: { status: 404, body: { message: 'Not Found' } } } },
    /the reviewer App is not installed on contract-hero\/hero-pocock \(HTTP 404\)/,
  ],
  [
    'GitHub refuses the token',
    { routes: { ...WORKING, 'POST /app/installations/4242/access_tokens': { status: 422, body: { message: 'no access to hero-pocock' } } } },
    /mint the installation token failed: HTTP 422 \(no access to hero-pocock\)/,
  ],
  ['the config is invalid', { config: '```yaml\nruntime: claude\napp: yes\n```\n' }, /app must be "enabled" or left out/],
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
  const { code, stderr } = await runCli(['app-token', '--repo', REPO, '--config', join(s.dir, 'nope.md')], {
    env: { ...baseEnv(), HERO_POCOCK_REVIEWER_APP_ENV: s.envFile, HERO_POCOCK_GITHUB_API_URL: s.api.url },
  })
  assert.equal(code, 4)
  assert.match(stderr, /no review config at/)
  assert.deepEqual(s.api.requests, [])
})

test('an unreachable GitHub API exits 4', async (t) => {
  const s = await setup(t)
  const { code, stderr } = await runCli(['app-token', '--repo', REPO, '--config', join(s.dir, 'review.md'), '--check'], {
    env: { ...baseEnv(), HERO_POCOCK_REVIEWER_APP_ENV: s.envFile },
  })
  assert.equal(code, 4)
  assert.match(stderr, /find the App installation: cannot reach the GitHub API at http:\/\/127\.0\.0\.1:9/)
})

test('bad arguments are a usage error (exit 2)', async (t) => {
  const s = await setup(t)
  for (const args of [[], ['--repo', 'nope'], ['--repo', REPO, '--login', '--check'], ['--repo', REPO, '--bogus']]) {
    const { code, stderr } = await runCli(['app-token', ...args], { env: baseEnv() })
    assert.equal(code, 2, `${args.join(' ')}: ${stderr}`)
    assert.match(stderr, /usage: review\.ts app-token/)
  }
  assert.deepEqual(s.api.requests, [])
})

// An lfg-style credential dir: its env file uses the LFG_ names and points at
// its own pem, as `~/.config/lfg/` does.
async function lfgCredentials(dir: string) {
  const lfg = join(dir, 'lfg')
  await mkdir(lfg, { recursive: true })
  const key = await appKey(lfg)
  const env = join(lfg, 'reviewer-app.env')
  await writeFile(env, `LFG_REVIEWER_APP_ID=987654\nLFG_REVIEWER_APP_KEY=${key.pem}\n`, { mode: 0o600 })
  return { env, key }
}

test('--copy-from copies lfg credentials into a fresh env file and key, and prints only paths', async (t) => {
  const dir = await tempDir(t)
  const lfg = await lfgCredentials(dir)
  const target = join(dir, 'hero-pocock', 'reviewer-app.env')
  const env = { ...baseEnv(), HERO_POCOCK_REVIEWER_APP_ENV: target }
  const { code, stdout, stderr } = await runCli(['app-token', '--copy-from', lfg.env], { env })
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const pem = join(dir, 'hero-pocock', 'reviewer-app.pem')
  assert.deepEqual(JSON.parse(stdout), { copied: true, env: target, key: pem })
  assert.doesNotMatch(stdout, /987654/)
  assert.equal(await readFile(pem, 'utf8'), await readFile(lfg.key.pem, 'utf8'))
  assert.equal(await readFile(target, 'utf8'), `HERO_POCOCK_REVIEWER_APP_ID=987654\nHERO_POCOCK_REVIEWER_APP_KEY=${pem}\n`)
  assert.equal((await stat(join(dir, 'hero-pocock'))).mode & 0o777, 0o700)
  assert.equal((await stat(target)).mode & 0o777, 0o600)
  assert.equal((await stat(pem)).mode & 0o777, 0o600)

  // The copy works: a token mints from the new files with the old key.
  const api = await fakeGitHubApi(t, lfg.key.publicKey, WORKING)
  const configPath = join(dir, 'review.md')
  await writeFile(configPath, WITH_APP)
  const minted = await runCli(['app-token', '--repo', REPO, '--config', configPath, '--check'], {
    env: { ...env, HERO_POCOCK_GITHUB_API_URL: api.url },
  })
  assert.deepEqual(minted, { code: 0, stdout: '', stderr: '' })
  assert.equal(api.requests[0].iss, '987654')
})

test('--copy-from never overwrites existing credentials without --force', async (t) => {
  const dir = await tempDir(t)
  const lfg = await lfgCredentials(dir)
  const target = join(dir, 'hero-pocock', 'reviewer-app.env')
  await mkdir(join(dir, 'hero-pocock'))
  await writeFile(target, 'HERO_POCOCK_REVIEWER_APP_ID=111\n')
  const env = { ...baseEnv(), HERO_POCOCK_REVIEWER_APP_ENV: target }

  const refused = await runCli(['app-token', '--copy-from', lfg.env], { env })
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /already exists: .*--force/)
  assert.equal(await readFile(target, 'utf8'), 'HERO_POCOCK_REVIEWER_APP_ID=111\n')

  const forced = await runCli(['app-token', '--copy-from', lfg.env, '--force'], { env })
  assert.equal(forced.code, 0, forced.stderr)
  assert.match(await readFile(target, 'utf8'), /^HERO_POCOCK_REVIEWER_APP_ID=987654\n/)
})

test('--copy-from with no lfg env file exits 3, and with an incomplete one exits 4', async (t) => {
  const dir = await tempDir(t)
  const target = join(dir, 'hero-pocock', 'reviewer-app.env')
  const env = { ...baseEnv(), HERO_POCOCK_REVIEWER_APP_ENV: target }

  const absent = await runCli(['app-token', '--copy-from', join(dir, 'lfg', 'reviewer-app.env')], { env })
  assert.equal(absent.code, 3)
  assert.match(absent.stderr, /no lfg credentials at /)

  await mkdir(join(dir, 'lfg'))
  await writeFile(join(dir, 'lfg', 'reviewer-app.env'), 'LFG_REVIEWER_APP_ID=987654\n')
  const incomplete = await runCli(['app-token', '--copy-from', join(dir, 'lfg', 'reviewer-app.env')], { env })
  assert.equal(incomplete.code, 4)
  assert.match(incomplete.stderr, /sets no LFG_REVIEWER_APP_KEY/)
  assert.doesNotMatch(incomplete.stderr, /987654/)
  await assert.rejects(stat(target))
})

test('the env file is read as data: export, quotes, comments and a ~/ key path', async (t) => {
  const dir = await tempDir(t)
  const home = join(dir, 'home')
  const appDir = join(home, '.config', 'hero-pocock')
  await mkdir(appDir, { recursive: true })
  const key = await appKey(appDir)
  const api = await fakeGitHubApi(t, key.publicKey, WORKING)
  const configPath = join(dir, 'review.md')
  await writeFile(configPath, WITH_APP)
  await writeFile(
    join(appDir, 'reviewer-app.env'),
    `# reviewer App\n\nexport HERO_POCOCK_REVIEWER_APP_ID="Iv23liFAKE"\nHERO_POCOCK_REVIEWER_APP_KEY='~/.config/hero-pocock/reviewer-app.pem'\n`,
  )
  // No HERO_POCOCK_REVIEWER_APP_ENV: the default path under this test's HOME is used.
  const env = { ...baseEnv(), HOME: home, HERO_POCOCK_GITHUB_API_URL: `${api.url}/` }
  delete env.HERO_POCOCK_REVIEWER_APP_ENV
  const { code, stdout, stderr } = await runCli(['app-token', '--repo', REPO, '--config', configPath, '--login'], { env })
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.equal(stdout, 'hero-reviewer[bot]\n')
  assert.equal(api.requests[0].iss, 'Iv23liFAKE')
})
