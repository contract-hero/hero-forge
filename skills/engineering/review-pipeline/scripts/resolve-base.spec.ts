// resolve-base: Finish merges the base branch into a PR that conflicts only
// in the version file and CHANGELOG.md, and re-checks the pushed merge. Each
// test builds a real repo with a bare `origin`.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseEnv, fakeGh, REVIEWER_TOKEN, reviewerApp, run, runCli, seedState, tempDir } from './test-helpers.ts'

const REPO = 'contract-hero/hero-forge'
const CONFIG = '```yaml\nruntime: claude\n```\n'
const APP_CONFIG = '```yaml\nruntime: claude\napp: enabled\n```\n'
const BOT = 'contract-reviewer[bot]'

const manifest = (version: string, skills: string[] = ['a']) =>
  `{\n  "name": "x",\n  "version": "${version}",\n  "description": "d",\n  "author": "e",\n  "license": "MIT",\n  "skills": [\n${skills.map((s, i) => `    "${s}"${i < skills.length - 1 ? ',' : ''}`).join('\n')}\n  ]\n}\n`

const changelog = (...entries: [string, string][]) =>
  `# x\n\n${entries.map(([version, text]) => `## ${version}\n\n- ${text}\n`).join('\n')}`

type Side = { version: string; entries: [string, string][]; skills?: string[]; files?: Record<string, string> }

// main and feature/x start from one commit at 1.0.19. Then the PR and main
// each make their own commit, and both are pushed to origin. The run state
// is at `phase` with a passing gate at the PR head.
async function repo(t: Parameters<typeof tempDir>[0], pr: Side, main: Side, phase = 'explained', app = false) {
  const root = await tempDir(t)
  const dir = join(root, 'work')
  const origin = join(root, 'origin.git')
  const stateDir = join(root, 'state')
  await mkdir(dir)
  const gh = await fakeGh(root)
  const reviewer = app ? (await reviewerApp(t, root, REPO)).env : {}
  const env: Record<string, string | undefined> = {
    ...baseEnv(),
    ...gh.env,
    ...reviewer,
    HERO_FORGE_STATE_DIR: stateDir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  const git = async (...args: string[]) => {
    const r = await run('git', args, { cwd: dir, env })
    assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const write = (name: string, text: string) => writeFile(join(dir, name), text)
  const commit = async (side: Side, message: string) => {
    await write('.claude-plugin/plugin.json', manifest(side.version, side.skills))
    await write('CHANGELOG.md', changelog(...side.entries))
    for (const [name, text] of Object.entries(side.files ?? {})) await write(name, text)
    await git('add', '.')
    await git('commit', '-qm', message)
  }
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin], { env })
  await git('init', '-q', '-b', 'main')
  await git('remote', 'add', 'origin', origin)
  await mkdir(join(dir, '.claude-plugin'))
  await commit({ version: '1.0.19', entries: [['1.0.19', 'old.']], files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } }, 'start')
  await git('checkout', '-qb', 'feature/x')
  await commit(pr, 'the PR')
  await git('checkout', '-q', 'main')
  await commit(main, 'another PR merged')
  await git('push', '-q', 'origin', 'main', 'feature/x')
  await git('checkout', '-q', 'feature/x')
  await git('branch', '-qD', 'main')
  const head = await git('rev-parse', 'HEAD')
  await seedState(stateDir, {
    repo: REPO,
    base_ref: 'main',
    head_ref: 'feature/x',
    head_sha: head,
    phase,
    reviewer_login: app ? BOT : 'none',
    gates: [{ round: 1, commit: head, result: 'pass' }],
  })
  const config = join(root, 'review.md')
  await writeFile(config, app ? APP_CONFIG : CONFIG)
  const cli = (...args: string[]) => runCli(args, { cwd: dir, env })
  const prepare = () => cli('resolve-base', 'prepare', '--repo', REPO, '--pr', '13')
  const record = (sha: string) => cli('resolve-base', 'record', '--repo', REPO, '--pr', '13', '--commit', sha, '--config', config)
  const atGitHub = (sha: string) => gh.respond([{ match: 'pr view 13', stdout: JSON.stringify({ headRefOid: sha }) }])
  const state = async () => JSON.parse(await readFile(join(stateDir, 'pr-13', 'state.json'), 'utf8'))
  return { dir, git, write, head, prepare, record, atGitHub, state, gh }
}

const PR: Side = {
  version: '1.0.20',
  entries: [['1.0.20', 'the PR change.'], ['1.0.19', 'old.']],
  skills: ['a', 'b'],
  files: { 'a.txt': 'a, by the PR\n' },
}
const MAIN: Side = {
  version: '1.0.21',
  entries: [['1.0.21', 'second on main.'], ['1.0.20', 'first on main.'], ['1.0.19', 'old.']],
  files: { 'b.txt': 'b, on main\n' },
}

test('prepare merges main, sets the next patch above main, and puts the PR entry on top of every main entry', async (t) => {
  const s = await repo(t, PR, MAIN)
  const { code, stdout, stderr } = await s.prepare()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const out = JSON.parse(stdout)
  assert.equal(out.version, '1.0.22')
  assert.equal(out.version_file, '.claude-plugin/plugin.json')
  assert.deepEqual(out.files, ['.claude-plugin/plugin.json', 'CHANGELOG.md'])
  assert.equal(out.branch, 'feature/x')
  assert.equal(await s.git('rev-parse', 'HEAD'), out.commit)
  assert.equal(await s.git('rev-list', '--parents', '-n', '1', 'HEAD'), `${out.commit} ${s.head} ${out.base}`)
  assert.equal(await s.git('rev-parse', 'origin/main'), out.base)
  // The PR's other manifest change (a new skill) stays.
  assert.equal(await s.git('show', 'HEAD:.claude-plugin/plugin.json'), manifest('1.0.22', ['a', 'b']).trim())
  assert.equal(
    await s.git('show', 'HEAD:CHANGELOG.md'),
    changelog(['1.0.22', 'the PR change.'], ['1.0.21', 'second on main.'], ['1.0.20', 'first on main.'], ['1.0.19', 'old.']).trim(),
  )
  // Both sides' other changes are in the merge.
  assert.equal(await s.git('show', 'HEAD:a.txt'), 'a, by the PR')
  assert.equal(await s.git('show', 'HEAD:b.txt'), 'b, on main')
  assert.equal(await s.git('status', '--porcelain'), '')
})

test('prepare bumps past main when both sides bumped to the same version and the manifest merged cleanly', async (t) => {
  const s = await repo(t, { ...PR, skills: undefined }, {
    version: '1.0.20',
    entries: [['1.0.20', 'first on main.'], ['1.0.19', 'old.']],
  })
  const { code, stdout, stderr } = await s.prepare()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const out = JSON.parse(stdout)
  assert.equal(out.version, '1.0.21')
  assert.deepEqual(out.files, ['CHANGELOG.md'])
  assert.match(await s.git('show', 'HEAD:.claude-plugin/plugin.json'), /"version": "1\.0\.21"/)
  assert.match(await s.git('show', 'HEAD:CHANGELOG.md'), /^# x\n\n## 1\.0\.21\n\n- the PR change\.\n\n## 1\.0\.20\n\n- first on main\./)
})

test('prepare refuses a conflict in any other file and changes nothing', async (t) => {
  const s = await repo(t, PR, { ...MAIN, files: { 'a.txt': 'a, on main\n' } })
  const { code, stdout, stderr } = await s.prepare()
  assert.equal(stdout, '')
  assert.equal(code, 1)
  assert.match(stderr, /conflicts with the base branch in files other than .*: a\.txt\. A human resolves it/)
  assert.equal(await s.git('rev-parse', 'HEAD'), s.head)
  assert.equal(await s.git('status', '--porcelain'), '')
})

test('prepare refuses a manifest conflict on more than the version line', async (t) => {
  const s = await repo(t, PR, { ...MAIN, skills: ['a', 'c'] })
  const { code, stderr } = await s.prepare()
  assert.equal(code, 1)
  assert.match(stderr, /plugin\.json conflicts with the base branch on more than its version line/)
  assert.equal(await s.git('rev-parse', 'HEAD'), s.head)
})

test('prepare refuses a PR that edits an older CHANGELOG entry', async (t) => {
  const s = await repo(t, { ...PR, entries: [['1.0.20', 'the PR change.'], ['1.0.19', 'old, reworded.']] }, MAIN)
  const { code, stderr } = await s.prepare()
  assert.equal(code, 1)
  assert.match(stderr, /the PR's change to CHANGELOG\.md is not one new entry at the top/)
})

test('prepare refuses a run that is not in Finish yet', async (t) => {
  const s = await repo(t, PR, MAIN, 'rechecked')
  const { code, stderr } = await s.prepare()
  assert.equal(code, 1)
  assert.match(stderr, /resolve-base runs in Finish .* but PR #13 is at rechecked/)
})

test('record re-checks the pushed merge, records a pass at the new head, and moves the run back to ready', async (t) => {
  const s = await repo(t, PR, MAIN)
  const sha = JSON.parse((await s.prepare()).stdout).commit as string
  await s.git('push', '-q', 'origin', 'feature/x')
  await s.atGitHub(sha)
  const { code, stdout, stderr } = await s.record(sha)
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout).phase, 'ready')
  const state = await s.state()
  assert.equal(state.head_sha, sha)
  assert.equal(state.phase, 'ready')
  assert.deepEqual(state.gates.at(-1), { round: 1, commit: sha, result: 'pass' })
  // A re-run changes nothing.
  const again = await s.record(sha)
  assert.equal(again.code, 0)
  assert.equal(JSON.parse(again.stdout).already, true)
  assert.equal((await s.state()).gates.length, 2)
})

test('record refuses a merge commit that changes more than the version and CHANGELOG', async (t) => {
  const s = await repo(t, PR, MAIN)
  await s.prepare()
  await s.write('b.txt', 'b, slipped in\n')
  await s.git('commit', '-q', '--amend', '-a', '--no-edit')
  const sha = await s.git('rev-parse', 'HEAD')
  await s.git('push', '-q', 'origin', 'feature/x')
  await s.atGitHub(sha)
  const { code, stderr } = await s.record(sha)
  assert.equal(code, 1)
  assert.match(stderr, /is not the plain resolution of the merge with/)
  const state = await s.state()
  assert.equal(state.head_sha, s.head)
  assert.equal(state.phase, 'explained')
})

test('record refuses while GitHub has another head', async (t) => {
  const s = await repo(t, PR, MAIN)
  const sha = JSON.parse((await s.prepare()).stdout).commit as string
  await s.atGitHub(s.head)
  const { code, stderr } = await s.record(sha)
  assert.equal(code, 1)
  assert.match(stderr, /PR #13 is at .* on GitHub, not .*: push the merge commit first/)
  assert.equal((await s.state()).phase, 'explained')
})

test('record with the reviewer App posts the gate success status at the new head, as the App', async (t) => {
  const s = await repo(t, PR, MAIN, 'explained', true)
  const sha = JSON.parse((await s.prepare()).stdout).commit as string
  await s.git('push', '-q', 'origin', 'feature/x')
  await s.atGitHub(sha)
  const { code, stderr } = await s.record(sha)
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const posts = (await s.gh.calls()).filter((c) => c.argv.includes('POST') && c.argv.some((a) => a.includes('/statuses/')))
  assert.equal(posts.length, 1)
  assert.equal(posts[0]?.argv.includes(`repos/${REPO}/statuses/${sha}`), true)
  assert.equal(posts[0]?.gh_token, REVIEWER_TOKEN)
  assert.equal(JSON.parse(posts[0]?.stdin ?? '{}').state, 'success')
  assert.equal((await s.state()).phase, 'ready')
})
