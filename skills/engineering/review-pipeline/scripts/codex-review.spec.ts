import assert from 'node:assert/strict'
import { access, readFile, realpath, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeCodex, fakeGh, run, runCli, tempDir, type FakeCodexCall, type FakeCodexSpec, type FakeGhResponse } from './test-helpers.ts'

const SKILL = dirname(dirname(fileURLToPath(import.meta.url)))
const FINDINGS_SCHEMA = join(SKILL, 'findings.schema.json')
const REVIEW_SCHEMA = join(SKILL, 'review.schema.json')
const CONFIG = '# Review pipeline\n\n```yaml\nruntime: codex\npairs: 2\norchestrator:\n  model: gpt-6-astra\n  effort: low\nreviewer:\n  model: gpt-6.1-sol\n  effort: xhigh\n```\n'
const FINDINGS = '{"axis":"standards","pair":1,"findings":[],"notes":""}'
const COMMENT = { path: 'src/a.ts', line: 5, side: 'RIGHT', start_line: null, start_side: null, body: '**F1** (Standards, bug, high, 2/2 pairs) Off by one.' }
const LEDGER = [{ id: 'F1', where: 'src/a.ts:5', axis: 'standards', severity: 'high', pairs: '2/2', finding: 'Off by one.', decision: '', reason: '' }]
const OUTPUT = { payload: { event: 'COMMENT', body: '## Review pipeline: round 1', comments: [COMMENT] }, ledger: LEDGER, report: 'kept 1, dropped 0' }
const ISSUE = { match: 'issue view 2', stdout: JSON.stringify({ number: 2, title: 'Spec', body: '- [ ] AC one\n- [ ] AC two\n' }) }
const ME: FakeGhResponse = { match: 'api user', stdout: 'alilloig\n' }
const POSTED: FakeGhResponse = { match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 555 }) }
const FORBIDDEN = ['danger-full-access', 'workspace-write', 'network_access', '--full-auto', '--dangerously-bypass-approvals-and-sandbox']

type Setup = { codex?: FakeCodexSpec; gh?: FakeGhResponse[] }

const git = async (cwd: string, ...args: string[]) => {
  const r = await run('git', args, { cwd })
  assert.equal(r.code, 0, r.stderr)
  return r.stdout.trim()
}

// A git repo with origin/main and a PR head that changes src/a.ts line 5 and
// adds src/b.ts, a run state for PR #13 pinned to that head, a codex config,
// a fake gh and a fake codex.
async function setup(t: Parameters<typeof tempDir>[0], options: Setup = {}) {
  const dir = await realpath(await tempDir(t))
  const repo = join(dir, 'repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`)
  await writeFile(join(repo, 'src', 'a.ts'), `${lines.join('\n')}\n`)
  await git(dir, 'init', '-q', '-b', 'main', repo)
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.')
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base')
  await git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  lines[4] = 'line five'
  await writeFile(join(repo, 'src', 'a.ts'), `${lines.join('\n')}\n`)
  await writeFile(join(repo, 'src', 'b.ts'), 'export const b = 1\n')
  await git(repo, 'add', '.')
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'head')
  const sha = await git(repo, 'rev-parse', 'HEAD')

  const gh = await fakeGh(dir, [...(options.gh ?? [ISSUE, POSTED]), ME])
  const codex = await fakeCodex(dir, options.codex ?? { routes: [
    { match: 'reviewer-p', out: FINDINGS },
    { match: 'orchestrator-output', out: JSON.stringify(OUTPUT) },
  ] })
  const state = join(dir, 'state')
  const env = { ...gh.env, PATH: `${join(dir, 'codex-bin')}:${gh.env.PATH}`, HERO_POCOCK_STATE_DIR: state }
  const configPath = join(dir, 'review.md')
  await writeFile(configPath, CONFIG)
  const created = await runCli(['run-state', 'create', '--pr', '13', '--repo', 'contract-hero/hero-pocock', '--base', 'main',
    '--head', 'feature/x', '--head-sha', sha, '--runtime', 'codex', '--reviewer-login', 'none'], { cwd: repo, env })
  assert.equal(created.code, 0, created.stderr)
  const runDir = join(state, 'pr-13')
  const review = (...extra: string[]) => runCli(['codex-review', '--pr', '13', '--config', configPath, ...extra], { cwd: repo, env })
  const execs = async () => (await codex.calls()).filter((c) => c.argv[0] === 'exec')
  const posts = async () => (await gh.calls()).filter((c) => c.argv.includes('POST'))
  return { dir, repo, sha, gh, codex, runDir, review, execs, posts }
}

const flag = (call: FakeCodexCall, name: string) => call.argv[call.argv.indexOf(name) + 1] ?? ''

test('codex-review runs each reviewer read-only, has the Orchestrator consolidate read-only, then posts its checked payload', async (t) => {
  const s = await setup(t)

  const { code, stdout, stderr } = await s.review('--issue', '2')

  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout).posted, true)

  const execs = await s.execs()
  for (const call of execs) {
    assert.equal(flag(call, '-s'), 'read-only', call.argv.join(' '))
    for (const bad of FORBIDDEN) assert.ok(!call.argv.join(' ').includes(bad), `${bad} in ${call.argv.join(' ')}`)
    assert.deepEqual(call.tokens, [])
  }
  const reviewers = execs.filter((c) => flag(c, '-o').includes('reviewer-p'))
  assert.deepEqual(reviewers.map((c) => flag(c, '-o')).sort(), ['p1-spec', 'p1-standards', 'p2-spec', 'p2-standards']
    .map((n) => join(s.runDir, `reviewer-${n}.json`)))
  for (const call of reviewers) {
    assert.equal(flag(call, '-m'), 'gpt-6.1-sol')
    assert.equal(flag(call, '-c'), 'model_reasoning_effort=xhigh')
    assert.equal(flag(call, '--output-schema'), FINDINGS_SCHEMA)
  }
  const brief = (name: string) => reviewers.find((c) => flag(c, '-o').endsWith(`${name}.json`))?.stdin ?? ''
  assert.match(brief('p1-standards'), /Standards reviewer of pair 1 of 2/)
  assert.match(brief('p1-standards'), /Changed files, in your focus order: src\/a\.ts, src\/b\.ts\n/)
  assert.match(brief('p2-standards'), /Changed files, in your focus order: src\/b\.ts, src\/a\.ts\n/)
  assert.match(brief('p1-standards'), /Checklist, in your focus order: documented standards, smells, bugs, silent failures, test gaps\n/)
  assert.match(brief('p2-standards'), /Checklist, in your focus order: smells, bugs, silent failures, test gaps, documented standards\n/)
  assert.match(brief('p2-spec'), /Spec reviewer of pair 2 of 2/)
  assert.match(brief('p2-spec'), new RegExp(`${join(s.runDir, 'spec.md')}`))

  const orchestrator = execs.filter((c) => flag(c, '-o').includes('orchestrator-output'))
  assert.equal(orchestrator.length, 1)
  const [o] = orchestrator
  assert.equal(flag(o!, '-m'), 'gpt-6-astra')
  assert.equal(flag(o!, '-c'), 'model_reasoning_effort=low')
  assert.equal(flag(o!, '--output-schema'), REVIEW_SCHEMA)
  assert.ok(!o!.stdin.includes('{{'), 'unfilled placeholder in the orchestrator brief')
  assert.ok(o!.stdin.includes(join(s.runDir, 'reviewer-p2-spec.json')))
  assert.ok(o!.stdin.includes(s.sha))

  assert.match(await readFile(join(s.runDir, 'spec.md'), 'utf8'), /AC one/)
  const posts = await s.posts()
  assert.equal(posts.length, 1)
  const sent = JSON.parse(posts[0]!.stdin)
  assert.equal(sent.commit_id, s.sha)
  assert.equal(sent.event, 'COMMENT')
  assert.match(sent.body, /^## Review pipeline: round 1\n\n<!-- hero-pocock:review-pipeline pr=13 round=1 kind=review -->$/)
  assert.deepEqual(sent.comments, [{ path: 'src/a.ts', line: 5, side: 'RIGHT', body: COMMENT.body }])
  assert.deepEqual(JSON.parse(await readFile(join(s.runDir, 'findings.json'), 'utf8')), LEDGER)
  assert.match(await readFile(join(s.runDir, 'orchestrator-report.md'), 'utf8'), /kept 1, dropped 0/)
})

const withOrchestrator = (out: string | null, exit = 0): FakeCodexSpec => ({ routes: [
  { match: 'reviewer-p', out: FINDINGS },
  { match: 'orchestrator-output', out, exit },
] })

for (const [name, out, why] of [
  ['an APPROVE event', JSON.stringify({ ...OUTPUT, payload: { ...OUTPUT.payload, event: 'APPROVE' } }), /\$\.payload\.event: must be one of "COMMENT"/],
  ['a missing ledger', JSON.stringify({ payload: OUTPUT.payload, report: '' }), /\$: missing "ledger"/],
  ['an extra key', JSON.stringify({ ...OUTPUT, post: true }), /\$: unknown key "post"/],
  ['prose', 'I posted the review myself.', /is not JSON/],
] as const) {
  test(`an Orchestrator output with ${name} stops the round and posts nothing`, async (t) => {
    const s = await setup(t, { codex: withOrchestrator(out) })
    const { code, stdout, stderr } = await s.review('--issue', '2')
    assert.equal(code, 1)
    assert.equal(stdout, '')
    assert.match(stderr, /the Orchestrator failed, so nothing was posted/)
    assert.match(stderr, why)
    assert.deepEqual(await s.posts(), [])
    await assert.rejects(access(join(s.runDir, 'review-payload.json')))
  })
}

test('an Orchestrator that fails stops the round and posts nothing', async (t) => {
  const s = await setup(t, { codex: withOrchestrator(null, 1) })
  const { code, stderr } = await s.review()
  assert.equal(code, 1)
  assert.match(stderr, /the Orchestrator failed, so nothing was posted: codex exec failed \(exit 1\)/)
  assert.deepEqual(await s.posts(), [])
})

test('an Orchestrator payload that leaks a token posts nothing', async (t) => {
  const leak = { ...COMMENT, body: `**F1** see\nghp_${'A1b2'.repeat(9)}` }
  const s = await setup(t, { codex: withOrchestrator(JSON.stringify({ ...OUTPUT, payload: { ...OUTPUT.payload, comments: [leak] } })) })
  const { code, stderr } = await s.review()
  assert.equal(code, 1)
  assert.match(stderr, /looks like a GitHub token\. Nothing was posted/)
  assert.deepEqual(await s.posts(), [])
})

test('an inline anchor outside the diff moves into the walkthrough instead of failing the review', async (t) => {
  const outside = { ...COMMENT, line: 12, body: '**F2** (Standards, smell, low, 1/2 pairs) Far away.' }
  const multi = { ...COMMENT, start_line: 4, start_side: 'RIGHT', line: 6, body: '**F3** span' }
  const s = await setup(t, { codex: withOrchestrator(JSON.stringify({ ...OUTPUT, payload: { ...OUTPUT.payload, comments: [COMMENT, outside, multi] } })) })
  const { code, stderr } = await s.review()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const sent = JSON.parse((await s.posts())[0]!.stdin)
  assert.deepEqual(sent.comments, [
    { path: 'src/a.ts', line: 5, side: 'RIGHT', body: COMMENT.body },
    { path: 'src/a.ts', line: 6, side: 'RIGHT', start_line: 4, start_side: 'RIGHT', body: '**F3** span' },
  ])
  assert.match(sent.body, /### Findings outside the diff\n\n- `src\/a\.ts:12`: \*\*F2\*\* \(Standards, smell, low, 1\/2 pairs\) Far away\./)
})

test('anchors still match the diff when the user sets diff.noprefix', async (t) => {
  const s = await setup(t)
  await git(s.repo, 'config', 'diff.noprefix', 'true')
  const { code, stderr } = await s.review()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const sent = JSON.parse((await s.posts())[0]!.stdin)
  assert.deepEqual(sent.comments, [{ path: 'src/a.ts', line: 5, side: 'RIGHT', body: COMMENT.body }])
  assert.doesNotMatch(sent.body, /Findings outside the diff/)
})

test('without --issue no spec is fetched, and the Spec reviewers look for the spec themselves', async (t) => {
  const s = await setup(t)
  const { code, stderr } = await s.review()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.ok(!(await s.gh.calls()).some((c) => c.argv[0] === 'issue'))
  const spec = (await s.execs()).find((c) => flag(c, '-o').endsWith('reviewer-p1-spec.json'))
  assert.match(spec!.stdin, /no spec issue was given/)
  await assert.rejects(access(join(s.runDir, 'spec.md')))
})

test('a relaunch reuses each reviewer output for the same brief and runs only the failed ones', async (t) => {
  const s = await setup(t, { codex: { routes: [
    { match: 'reviewer-p2-spec', out: null, exit: 1 },
    { match: 'reviewer-p', out: FINDINGS },
    { match: 'orchestrator-output', out: JSON.stringify(OUTPUT) },
  ] } })
  const first = await s.review()
  assert.equal(first.code, 0)
  assert.match(first.stderr, /reviewer-p2-spec failed/)
  const brief = (await s.execs()).find((c) => flag(c, '-o').includes('orchestrator-output'))!.stdin
  assert.match(brief, /reviewer-p2-spec\.json`: failed/)
  assert.match(brief, /reviewer-p1-spec\.json`: ok/)

  const before = (await s.execs()).length
  const again = await s.review()
  assert.equal(again.code, 0)
  const rerun = (await s.execs()).slice(before).map((c) => flag(c, '-o').split('/').pop())
  assert.deepEqual(rerun, ['reviewer-p2-spec.json', 'orchestrator-output.json'])
  assert.equal(JSON.parse(again.stdout).duplicate, true)
})

test('when every reviewer fails, the Orchestrator never runs and nothing is posted', async (t) => {
  const s = await setup(t, { codex: { exec: { out: null, exit: 1 } } })
  const { code, stderr } = await s.review()
  assert.equal(code, 1)
  assert.match(stderr, /every reviewer failed, so nothing was posted/)
  assert.ok(!(await s.execs()).some((c) => flag(c, '-o').includes('orchestrator-output')))
  assert.deepEqual(await s.posts(), [])
})

test('bad arguments are a usage error, before any codex call', async (t) => {
  const s = await setup(t)
  assert.equal((await s.review('--issue', 'two')).code, 2)
  assert.equal((await runCli(['codex-review'], { cwd: s.repo })).code, 2)
  assert.deepEqual(await s.execs(), [])
})
