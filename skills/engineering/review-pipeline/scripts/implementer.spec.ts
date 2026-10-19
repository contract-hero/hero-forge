// `review.ts implementer`: the Implementer App pushes, opens the draft PR and
// comments, each verb minting its own token, so no token reaches the caller.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeGh, fakeGit, IMPLEMENTER_TOKEN, implementerApp, run, runCli, tempDir, type FakeGhResponse, type FakeGitSpec } from './test-helpers.ts'

const REPO = 'contract-hero/hero-forge'
const WITH_APP = '```yaml\nruntime: claude\napp: enabled\n```\n'
const NO_APP = '```yaml\nruntime: claude\n```\n'

type Setup = { config?: string; broken?: boolean; responses?: FakeGhResponse[] }

// A temp dir with a config, the Implementer App and a fake gh. `cli` runs
// `review.ts implementer <args> --repo REPO --config <config>`.
async function setup(t: Parameters<typeof tempDir>[0], options: Setup = {}) {
  const dir = await tempDir(t)
  const config = join(dir, 'review.md')
  await writeFile(config, options.config ?? WITH_APP)
  const app = await implementerApp(t, dir, REPO, { broken: options.broken })
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

test('comment without "app: enabled" exits 3, mints nothing and posts nothing', async (t) => {
  const s = await setup(t, { config: NO_APP })
  const body = await s.file('comment.md', 'hello')
  const result = await s.cli('comment', '--issue', '7', '--body-file', body)
  assert.equal(result.code, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^review\.ts implementer: no implementer App configured for this repo \(no "app: enabled" in the config\): push and post as the user\n$/)
  assert.deepEqual(await s.gh.calls(), [])
  assert.deepEqual(s.api.requests, [])
})

test('comment with a broken Implementer App exits 4 and posts nothing, as the App or as the user', async (t) => {
  const s = await setup(t, { broken: true })
  const body = await s.file('comment.md', 'hello')
  const result = await s.cli('comment', '--issue', '7', '--body-file', body)
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^review\.ts implementer: the implementer App is enabled but its env file .*implementer-app\.env does not exist/)
  assert.deepEqual(await s.gh.calls(), [])
})

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
// `gh auth setup-git` does), and the fake git. `push` runs the push verb in
// the repo.
async function pushSetup(t: Parameters<typeof tempDir>[0], options: Setup & { git?: FakeGitSpec } = {}) {
  const s = await setup(t, options)
  const repo = join(s.dir, 'work')
  const globalConfig = join(s.dir, 'gitconfig')
  await writeFile(globalConfig, `[credential "https://github.com"]\n\thelper =\n\thelper = "!f() { echo username=me; echo password=${USER_TOKEN}; }; f"\n`)
  const env = { ...s.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  for (const args of [['init', '-q', '-b', 'main', repo], ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one'],
    ['-C', repo, 'branch', 'ticket/27-x']]) {
    const done = await run('git', args, { env })
    assert.equal(done.code, 0, done.stderr)
  }
  const sha = (await run('git', ['-C', repo, 'rev-parse', 'ticket/27-x'], { env })).stdout.trim()
  const git = await fakeGit(s.dir, options.git)
  const pushEnv = { ...env, PATH: `${git.bin}:${s.env.PATH ?? ''}`, GIT_ASKPASS: '/usr/bin/false' }
  const push = (...args: string[]) =>
    runCli(['implementer', 'push', ...args, '--repo', REPO, '--config', join(s.dir, 'review.md')], { env: pushEnv, cwd: repo })
  return { ...s, sha, push, pushes: git.pushes }
}

const USER_TOKEN = `gho_${'U5'.repeat(18)}`

test('push sends the branch to GitHub over https with the Implementer App token, never the user credentials, and prints no token', async (t) => {
  const s = await pushSetup(t)
  const result = await s.push('--branch', 'ticket/27-x')
  assert.equal(result.stderr, '')
  assert.equal(result.code, 0)
  noToken(result)
  assert.deepEqual(JSON.parse(result.stdout), { branch: 'ticket/27-x', commit: s.sha, as: 'contract-implementer[bot]' })
  const pushes = await s.pushes()
  assert.equal(pushes.length, 1)
  const [push] = pushes
  assert.deepEqual(push!.argv.slice(-3), ['push', `https://github.com/${REPO}.git`, 'refs/heads/ticket/27-x:refs/heads/ticket/27-x'])
  assert.ok(!push!.argv.join(' ').includes(IMPLEMENTER_TOKEN), 'the token is in the git argv')
  assert.equal(push!.password, IMPLEMENTER_TOKEN)
  assert.equal(push!.evil_password, null)
  assert.deepEqual(push!.env, { GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https', GIT_ASKPASS: null })
})

for (const [name, options, code, message] of [
  ['without "app: enabled" it exits 3', { config: NO_APP }, 3, /no implementer App configured for this repo/],
  ['with a broken Implementer App it exits 4', { broken: true }, 4, /the implementer App is enabled but its env file .* does not exist/],
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
