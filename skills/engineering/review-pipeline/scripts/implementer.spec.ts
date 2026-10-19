// `review.ts implementer`: the Implementer App pushes, opens the draft PR and
// comments, each verb minting its own token, so no token reaches the caller.
import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeGh, fakeGit, IMPLEMENTER_TOKEN, implementerApp, run, runCli, tempDir, type FakeApiRequest, type FakeGhResponse, type FakeGitSpec } from './test-helpers.ts'

const REPO = 'contract-hero/hero-forge'
// The Implementer App's switch is implementer.app; app: enabled is the reviewer App's.
const WITH_APP = '```yaml\nruntime: claude\nimplementer:\n  app: enabled\n```\n'
const NO_APP = '```yaml\nruntime: claude\n```\n'
const REVIEWER_ONLY = '```yaml\nruntime: claude\napp: enabled\nimplementer:\n  app: disabled\n```\n'

type Setup = { config?: string; missing?: boolean; responses?: FakeGhResponse[]; onRequest?: (request: FakeApiRequest) => Promise<void> }

// A temp dir with a config, the Implementer App and a fake gh. `cli` runs
// `review.ts implementer <args> --repo REPO --config <config>`.
async function setup(t: Parameters<typeof tempDir>[0], options: Setup = {}) {
  const dir = await tempDir(t)
  const config = join(dir, 'review.md')
  await writeFile(config, options.config ?? WITH_APP)
  const app = await implementerApp(t, dir, REPO, { missing: options.missing, onRequest: options.onRequest })
  const gh = await fakeGh(dir, options.responses ?? [])
  const env = { ...gh.env, ...app.env }
  const file = async (name: string, text: string) => {
    const path = join(dir, name)
    await writeFile(path, text)
    return path
  }
  const cli = (...args: string[]) => runCli(['implementer', ...args, '--repo', REPO, '--config', config], { env })
  return { dir, env, gh, api: app.api, file, cli }
}

const noToken = (r: { stdout: string; stderr: string }) => {
  assert.ok(!r.stdout.includes(IMPLEMENTER_TOKEN), r.stdout)
  assert.ok(!r.stderr.includes(IMPLEMENTER_TOKEN), r.stderr)
}

test('comment posts the body on the issue as the Implementer App and prints no token', async (t) => {
  const s = await setup(t, { responses: [{ match: 'issues/7/comments', stdout: JSON.stringify({ id: 901 }) }] })
  const body = await s.file('comment.md', 'Paused: a one-way door needs your call.')
  const result = await s.cli('comment', '--issue', '7', '--body-file', body)
  assert.equal(result.stderr, '')
  assert.equal(result.code, 0)
  noToken(result)
  assert.deepEqual(JSON.parse(result.stdout), { id: 901, as: 'contract-implementer[bot]' })
  const calls = await s.gh.calls()
  assert.deepEqual(calls.map((c) => c.argv), [['api', '-X', 'POST', `repos/${REPO}/issues/7/comments`, '--input', '-']])
  assert.equal(calls[0]!.gh_token, IMPLEMENTER_TOKEN)
  assert.deepEqual(JSON.parse(calls[0]!.stdin), { body: 'Paused: a one-way door needs your call.' })
})

// The posting verbs, with arguments that pass the usage checks.
const POSTS: [string, (body: string) => string[]][] = [
  ['comment', (body) => ['comment', '--issue', '7', '--body-file', body]],
  ['pr', (body) => ['pr', '--head', 'ticket/27-x', '--base', 'main', '--title', 'T', '--body-file', body]],
]

for (const [verb, args] of POSTS) {
  for (const [name, config] of [['no App in the config', NO_APP], ['only the reviewer App enabled', REVIEWER_ONLY]] as const) {
    test(`${verb} with ${name} exits 3, mints nothing and posts nothing`, async (t) => {
      const s = await setup(t, { config })
      const body = await s.file('body.md', 'hello')
      const result = await s.cli(...args(body))
      assert.equal(result.code, 3)
      assert.equal(result.stdout, '')
      assert.equal(
        result.stderr,
        'review.ts implementer: no implementer App configured for this repo (no "implementer.app: enabled" in the config): push and post as the user\n',
      )
      assert.deepEqual(await s.gh.calls(), [])
      assert.deepEqual(s.api.requests, [])
    })
  }

  test(`${verb} with a broken Implementer App exits 4 and posts nothing, as the App or as the user`, async (t) => {
    const s = await setup(t, { missing: true })
    const body = await s.file('body.md', 'hello')
    const result = await s.cli(...args(body))
    assert.equal(result.code, 4)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^review\.ts implementer: the implementer App is enabled but its env file .*implementer-app\.env does not exist/)
    assert.deepEqual(await s.gh.calls(), [])
  })
}

for (const [name, text, message] of [
  ['a token', `see ghs_${'Z9'.repeat(18)}`, /contains what looks like a GitHub token\. Nothing was posted/],
  ['the pipeline marker', 'done <!-- hero-forge:review-pipeline pr=7 kind=reply -->', /contains the marker "hero-forge:review-pipeline", which only the helper CLI writes/],
] as const) {
  test(`a comment body that holds ${name} is refused before any token is minted`, async (t) => {
    const s = await setup(t)
    const body = await s.file('comment.md', text)
    const result = await s.cli('comment', '--issue', '7', '--body-file', body)
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, message)
    assert.deepEqual(await s.gh.calls(), [])
    assert.deepEqual(s.api.requests, [])
  })
}

const PR_RESPONSE: FakeGhResponse = {
  match: `repos/${REPO}/pulls`,
  stdout: JSON.stringify({ number: 41, html_url: `https://github.com/${REPO}/pull/41`, user: { login: 'contract-implementer[bot]' } }),
}

test('pr opens a draft pull request as the Implementer App, so the App is its author, and prints no token', async (t) => {
  const s = await setup(t, { responses: [PR_RESPONSE] })
  const body = await s.file('pr-body.md', '## What\n\nBuilt it.\n\nCloses #27\n')
  const result = await s.cli('pr', '--head', 'ticket/27-x', '--base', 'main', '--title', 'Implementer acts as its App', '--body-file', body)
  assert.equal(result.stderr, '')
  assert.equal(result.code, 0)
  noToken(result)
  assert.deepEqual(JSON.parse(result.stdout), { number: 41, url: `https://github.com/${REPO}/pull/41`, as: 'contract-implementer[bot]' })
  const calls = await s.gh.calls()
  assert.deepEqual(calls.map((c) => c.argv), [['api', '-X', 'POST', `repos/${REPO}/pulls`, '--input', '-']])
  assert.equal(calls[0]!.gh_token, IMPLEMENTER_TOKEN)
  assert.deepEqual(JSON.parse(calls[0]!.stdin), {
    title: 'Implementer acts as its App',
    head: 'ticket/27-x',
    base: 'main',
    body: '## What\n\nBuilt it.\n\nCloses #27\n',
    draft: true,
  })
})

test('a pr title that holds a token is refused before any token is minted', async (t) => {
  const s = await setup(t, { responses: [PR_RESPONSE] })
  const body = await s.file('pr-body.md', 'body')
  const result = await s.cli('pr', '--head', 'ticket/27-x', '--base', 'main', '--title', `fix ghp_${'Q1'.repeat(18)}`, '--body-file', body)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /--title contains what looks like a GitHub token\. Nothing was posted/)
  assert.deepEqual(await s.gh.calls(), [])
  assert.deepEqual(s.api.requests, [])
})

test('GitHub refusing the pull request exits 1 with its message', async (t) => {
  const s = await setup(t, { responses: [{ match: 'pulls', stderr: 'gh: A pull request already exists for contract-hero:ticket/27-x. (HTTP 422)\n', exit: 1 }] })
  const body = await s.file('pr-body.md', 'body')
  const result = await s.cli('pr', '--head', 'ticket/27-x', '--base', 'main', '--title', 'T', '--body-file', body)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /^review\.ts implementer: GitHub rejected the pull request: gh: A pull request already exists .*\(HTTP 422\)\n$/)
  noToken(result)
})

// A git repo with a commit on `ticket/27-x`, a user-level git config whose
// credential helper hands out the user's token for github.com (as
// `gh auth setup-git` does), a bare repo that stands in for GitHub, and the
// fake git, which also runs each push for real into that bare repo. `push`
// runs the push verb in the repo.
async function pushSetup(t: Parameters<typeof tempDir>[0], options: Setup & { git?: FakeGitSpec; env?: Record<string, string> } = {}) {
  const s = await setup(t, options)
  const repo = join(s.dir, 'work')
  const remote = join(s.dir, 'remote.git')
  const globalConfig = join(s.dir, 'gitconfig')
  await writeFile(globalConfig, `[credential "https://github.com"]\n\thelper =\n\thelper = "!f() { echo username=me; echo password=${USER_TOKEN}; }; f"\n`)
  const env = { ...s.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  for (const args of [['init', '-q', '-b', 'main', repo], ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one'],
    ['-C', repo, 'branch', 'ticket/27-x'], ['init', '-q', '--bare', remote]]) {
    const done = await run('git', args, { env })
    assert.equal(done.code, 0, done.stderr)
  }
  const sha = (await run('git', ['-C', repo, 'rev-parse', 'ticket/27-x'], { env })).stdout.trim()
  const git = await fakeGit(s.dir, { remote, ...options.git })
  const pushEnv = { ...env, PATH: `${git.bin}:${s.env.PATH ?? ''}`, GIT_ASKPASS: '/usr/bin/false', ...options.env }
  const push = (...args: string[]) =>
    runCli(['implementer', 'push', ...args, '--repo', REPO, '--config', join(s.dir, 'review.md')], { env: pushEnv, cwd: repo })
  const gitConfig = async (file: string, ...args: string[]) =>
    assert.equal((await run('git', ['config', '--file', file, ...args], { env })).code, 0)
  const landed = async () => (await run('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/ticket/27-x'], { env })).stdout.trim()
  return { ...s, repo, sha, push, pushes: git.pushes, gitConfig, globalConfig, landed }
}

const USER_TOKEN = `gho_${'U5'.repeat(18)}`

// The only `-c` options the push may carry, in order.
const PUSH_OPTIONS = [
  'credential.helper=', 'credential.helper=<the App helper>', 'http.extraHeader=', 'http.sslVerify=true', 'http.proxy=', 'core.askPass=',
  'core.hooksPath=/dev/null',
]

// The variables the push may see. A shell between the CLI and the fake git
// adds PWD, SHLVL and `_`, and macOS adds __CF_USER_TEXT_ENCODING to every
// process, so those are left out of the check.
const PUSH_ENV =
  /^(PATH|TMPDIR|LANG|LC_[A-Z]+|HOME|GIT_DIR|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_GLOBAL|GIT_TERMINAL_PROMPT|GIT_ALLOW_PROTOCOL|HERO_FORGE_GIT_TOKEN|PWD|SHLVL|_|__CF_USER_TEXT_ENCODING)$/

// One push, checked: it ran in a scratch repo that is gone now, with only
// the allowed env and options and no other config, authenticated with the
// App token alone, and the branch tip landed in the stand-in for GitHub.
async function assertIsolatedPush(s: Awaited<ReturnType<typeof pushSetup>>, result: { code: number | null; stdout: string; stderr: string }) {
  assert.equal(result.stderr, '')
  assert.equal(result.code, 0)
  noToken(result)
  assert.deepEqual(JSON.parse(result.stdout), { branch: 'ticket/27-x', commit: s.sha, as: 'contract-implementer[bot]' })
  const pushes = await s.pushes()
  assert.equal(pushes.length, 1)
  const push = pushes[0]!
  assert.deepEqual(push.argv.slice(-3), ['push', `https://github.com/${REPO}.git`, `${s.sha}:refs/heads/ticket/27-x`])
  assert.ok(!push.argv.join(' ').includes(IMPLEMENTER_TOKEN), 'the token is in the git argv')
  const options: string[] = []
  for (let i = 0; push.argv[i] === '-c'; i += 2) options.push(push.argv[i + 1]!.startsWith('credential.helper=!') ? 'credential.helper=<the App helper>' : push.argv[i + 1]!)
  assert.deepEqual(options, PUSH_OPTIONS)
  assert.equal(push.password, IMPLEMENTER_TOKEN)
  assert.equal(push.evil_password, null)
  const extra = Object.keys(push.env).filter((name) => !PUSH_ENV.test(name))
  assert.deepEqual(extra, [])
  assert.equal(push.env.GIT_DIR, push.cwd)
  assert.equal(push.env.HOME, push.cwd)
  assert.ok(!push.cwd.startsWith(s.repo), push.cwd)
  assert.deepEqual(
    { nosystem: push.env.GIT_CONFIG_NOSYSTEM, global: push.env.GIT_CONFIG_GLOBAL, prompt: push.env.GIT_TERMINAL_PROMPT, protocol: push.env.GIT_ALLOW_PROTOCOL },
    { nosystem: '1', global: '/dev/null', prompt: '0', protocol: 'https' },
  )
  // Only the scratch repo's own config and the push's options: no file of the
  // user's, the repo's or the system's.
  const files = push.config.filter((line) => !line.startsWith('command line:'))
  assert.ok(files.every((line) => line.startsWith(`file:${push.cwd}/config\t`) && /\tcore\.[a-z]+=/.test(line)), files.join('\n'))
  await assert.rejects(stat(push.cwd), 'the scratch repo is still there')
  assert.equal(await s.landed(), s.sha)
}

test('push sends the branch tip to GitHub over https with the Implementer App token, from a scratch repo, and prints no token', async (t) => {
  const s = await pushSetup(t)
  await assertIsolatedPush(s, await s.push('--branch', 'ticket/27-x'))
})

test('no git config or env of the user, the repo or the caller reaches the push', async (t) => {
  const s = await pushSetup(t, {
    env: {
      HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', GIT_SSL_NO_VERIFY: '1',
      GIT_SSL_CAINFO: '/tmp/evil-ca.pem', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: basic eHg=',
      GIT_CONFIG_PARAMETERS: "'http.proxy'='http://127.0.0.1:9'",
    },
  })
  const local = join(s.repo, '.git', 'config')
  for (const [key, value] of [
    ['http.extraHeader', 'Authorization: basic dXNlcjpzZWNyZXQ='],
    ['http.https://github.com/.extraHeader', 'Authorization: bearer x'],
    ['url.git@github.com:.insteadOf', 'https://github.com/'],
    ['url.https://evil.example/.pushInsteadOf', 'https://github.com/'],
    ['http.proxy', 'http://127.0.0.1:9'],
    ['http.sslVerify', 'false'],
    ['http.sslCAInfo', '/tmp/evil-ca.pem'],
    ['http.cookieFile', '/tmp/cookies'],
  ] as [string, string][]) await s.gitConfig(local, key, value)
  await s.gitConfig(s.globalConfig, 'http.extraHeader', 'Authorization: basic Z2xvYmFs')
  await assertIsolatedPush(s, await s.push('--branch', 'ticket/27-x'))
})

test('config written to the repo between the mint and the push has no effect: the push never reads it', async (t) => {
  let local = ''
  const s = await pushSetup(t, {
    onRequest: async (request) => {
      if (request.method !== 'POST') return
      await writeFile(local, `[http]\n\textraHeader = Authorization: basic bGF0ZQ==\n\tproxy = http://127.0.0.1:9\n[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n`, { flag: 'a' })
    },
  })
  local = join(s.repo, '.git', 'config')
  await assertIsolatedPush(s, await s.push('--branch', 'ticket/27-x'))
  assert.match(await readFile(local, 'utf8'), /bGF0ZQ==/)
})

for (const [name, options, code, message] of [
  ['without "implementer.app: enabled" it exits 3', { config: NO_APP }, 3, /no "implementer\.app: enabled" in the config/],
  ['with only the reviewer App enabled it exits 3', { config: REVIEWER_ONLY }, 3, /no "implementer\.app: enabled" in the config/],
  ['with a broken Implementer App it exits 4', { missing: true }, 4, /the implementer App is enabled but its env file .* does not exist/],
] as const) {
  test(`push ${name} and pushes nothing, as the App or as the user`, async (t) => {
    const s = await pushSetup(t, options)
    const result = await s.push('--branch', 'ticket/27-x')
    assert.equal(result.code, code)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, message)
    assert.deepEqual(await s.pushes(), [])
  })
}

test('push of a branch that does not exist here exits 1 before any token is minted', async (t) => {
  const s = await pushSetup(t)
  const result = await s.push('--branch', 'ticket/99-none')
  assert.equal(result.code, 1)
  assert.match(result.stderr, /^review\.ts implementer: no local branch ticket\/99-none in this repo: run push in the worktree that holds it\n$/)
  assert.deepEqual(await s.pushes(), [])
  assert.deepEqual(s.api.requests, [])
})

test("GitHub refusing the push (a workflow file without the workflows permission) exits 1 with git's message and no token", async (t) => {
  const refused = ' ! [remote rejected] ticket/27-x -> ticket/27-x (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)\n'
  const s = await pushSetup(t, { git: { exit: 1, stderr: `To https://x-access-token:{password}@github.com/${REPO}.git\n${refused}` } })
  const result = await s.push('--branch', 'ticket/27-x')
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  noToken(result)
  assert.match(result.stderr, /^review\.ts implementer: GitHub refused the push of ticket\/27-x: To https:\/\/x-access-token:\*\*\*@github\.com\/.* ! \[remote rejected\] .*without `workflows` permission\)\n$/)
})

test('an unknown verb or a bad option is a usage error (exit 2) that mints nothing', async (t) => {
  const s = await setup(t)
  for (const args of [['merge'], ['comment', '--issue', '0', '--body-file', 'x'], ['pr', '--head', 'x', '--base', 'main', '--body-file', 'x'], ['push']]) {
    const result = await s.cli(...args)
    assert.equal(result.code, 2, args.join(' '))
    assert.match(result.stderr, /^review\.ts implementer: .*\nusage:\n/, args.join(' '))
  }
  assert.deepEqual(await s.gh.calls(), [])
  assert.deepEqual(s.api.requests, [])
})
