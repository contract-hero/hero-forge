// The Finish subcommands: merge-gate, merge, explainer.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeGh, runCli, tempDir, type FakeGhResponse } from './test-helpers.ts'

const SHA = 'c'.repeat(40)
const OTHER = 'd'.repeat(40)
const REPO = 'contract-hero/hero-pocock'
const VIEW = ['pr', 'view', '13', '--repo', REPO, '--json', 'state,isDraft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup']
const MERGE = ['pr', 'merge', '13', '--repo', REPO, '--squash', '--match-head-commit', SHA]
const VERIFY = ['pr', 'view', '13', '--repo', REPO, '--json', 'state,mergeCommit']

const GREEN_RUN = { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }
const SKIPPED_RUN = { __typename: 'CheckRun', name: 'deploy', status: 'COMPLETED', conclusion: 'SKIPPED' }
const GREEN_STATUS = { __typename: 'StatusContext', context: 'ci/lint', state: 'SUCCESS' }
const PENDING_RUN = { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: '' }
const PENDING_STATUS = { __typename: 'StatusContext', context: 'ci/e2e', state: 'PENDING' }
const RED_RUN = { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }
const RED_STATUS = { __typename: 'StatusContext', context: 'ci/lint', state: 'ERROR' }

type Pr = {
  state?: string
  isDraft?: boolean
  headRefOid?: string
  mergeable?: string
  mergeStateStatus?: string
  statusCheckRollup?: unknown[]
}

function pr(over: Pr = {}): string {
  return JSON.stringify({
    state: 'OPEN',
    isDraft: false,
    headRefOid: SHA,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [GREEN_RUN, SKIPPED_RUN, GREEN_STATUS],
    ...over,
  })
}

type Setup = { mode?: string; phase?: string; noState?: boolean }

// A run state for PR #13 at `phase` (default explained), and a fake gh.
async function setup(t: Parameters<typeof tempDir>[0], options: Setup = {}) {
  const dir = await tempDir(t)
  const gh = await fakeGh(dir)
  const env = { ...gh.env, HERO_POCOCK_STATE_DIR: join(dir, 'state') }
  if (options.noState !== true) {
    const created = await runCli(
      ['run-state', 'create', '--pr', '13', '--repo', REPO, '--base', 'main', '--head', 'feature/x', '--head-sha', SHA,
        '--runtime', 'claude', '--reviewer-login', 'none', '--mode', options.mode ?? 'single'],
      { env },
    )
    assert.equal(created.code, 0, created.stderr)
    const advanced = await runCli(['run-state', 'advance', '--pr', '13', options.phase ?? 'explained'], { env })
    assert.equal(advanced.code, 0, advanced.stderr)
  }
  const cli = (...args: string[]) => runCli([...args, '--repo', REPO, '--pr', '13'], { env })
  const state = async () => JSON.parse((await runCli(['run-state', 'read', '--pr', '13'], { env })).stdout)
  return { dir, gh, cli, state }
}

test('merge-gate says go when CI is green and the PR is mergeable at the re-checked head', async (t) => {
  const s = await setup(t)
  await s.gh.respond([{ match: 'mergeStateStatus', stdout: pr() }])
  const { code, stdout, stderr } = await s.cli('merge-gate')
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), {
    gate: 'go',
    ci: 'green',
    checks: { passed: 3, pending: [], failed: [] },
    mergeable: 'MERGEABLE',
    merge_state: 'CLEAN',
    problems: [],
  })
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [VIEW])
})

const CASES: { name: string; pr: Pr; gate: string; ci: string; problem?: RegExp }[] = [
  { name: 'no checks at all is go, with ci none', pr: { statusCheckRollup: [] }, gate: 'go', ci: 'none' },
  {
    name: 'a running check run is wait',
    pr: { statusCheckRollup: [GREEN_RUN, PENDING_RUN], mergeStateStatus: 'BLOCKED' },
    gate: 'wait', ci: 'pending', problem: /CI is still running: build/,
  },
  { name: 'a pending status is wait', pr: { statusCheckRollup: [PENDING_STATUS] }, gate: 'wait', ci: 'pending', problem: /ci\/e2e/ },
  { name: 'a failed check run is stop', pr: { statusCheckRollup: [RED_RUN, PENDING_RUN] }, gate: 'stop', ci: 'red', problem: /CI failed: test/ },
  { name: 'an errored status is stop', pr: { statusCheckRollup: [RED_STATUS] }, gate: 'stop', ci: 'red', problem: /ci\/lint/ },
  { name: 'a merge conflict is stop', pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, gate: 'stop', ci: 'green', problem: /conflict/ },
  { name: 'mergeable not yet computed is wait', pr: { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, gate: 'wait', ci: 'green', problem: /UNKNOWN/ },
  { name: 'branch protection blocking is stop', pr: { mergeStateStatus: 'BLOCKED' }, gate: 'stop', ci: 'green', problem: /BLOCKED/ },
  { name: 'a branch behind its base is stop', pr: { mergeStateStatus: 'BEHIND' }, gate: 'stop', ci: 'green', problem: /BEHIND/ },
  { name: 'a draft PR is stop', pr: { isDraft: true, mergeStateStatus: 'DRAFT' }, gate: 'stop', ci: 'green', problem: /draft/ },
  { name: 'a head the re-checker did not see is stop', pr: { headRefOid: OTHER }, gate: 'stop', ci: 'green', problem: /head moved/ },
  { name: 'a closed PR is stop', pr: { state: 'CLOSED' }, gate: 'stop', ci: 'green', problem: /CLOSED/ },
  { name: 'an already merged PR is merged', pr: { state: 'MERGED', mergeable: 'UNKNOWN' }, gate: 'merged', ci: 'green' },
]

for (const c of CASES) {
  test(`merge-gate: ${c.name}`, async (t) => {
    const s = await setup(t)
    await s.gh.respond([{ match: 'mergeStateStatus', stdout: pr(c.pr) }])
    const { code, stdout, stderr } = await s.cli('merge-gate')
    assert.equal(code, 0, stderr)
    const out = JSON.parse(stdout)
    assert.equal(out.gate, c.gate)
    assert.equal(out.ci, c.ci)
    if (c.problem === undefined) assert.deepEqual(out.problems, [])
    else assert.ok(out.problems.some((p: string) => c.problem!.test(p)), JSON.stringify(out.problems))
  })
}

test('merge-gate with no run state exits 3', async (t) => {
  const s = await setup(t, { noState: true })
  const { code, stderr } = await s.cli('merge-gate')
  assert.equal(code, 3)
  assert.match(stderr, /no run state for PR #13/)
  assert.deepEqual(await s.gh.calls(), [])
})

test('merge-gate refuses a repo that is not the run state repo', async (t) => {
  const s = await setup(t)
  const { code, stderr } = await runCli(['merge-gate', '--repo', 'someone/else', '--pr', '13'], {
    env: { ...s.gh.env, HERO_POCOCK_STATE_DIR: join(s.dir, 'state') },
  })
  assert.equal(code, 1)
  assert.match(stderr, /contract-hero\/hero-pocock/)
})

test('merge-gate exits 1 when gh cannot read the PR', async (t) => {
  const s = await setup(t)
  await s.gh.respond([{ match: 'mergeStateStatus', stderr: 'HTTP 404', exit: 1 }])
  const { code, stderr } = await s.cli('merge-gate')
  assert.equal(code, 1)
  assert.match(stderr, /HTTP 404/)
})

test('merge squash-merges the re-checked head on a green gate, and nothing else', async (t) => {
  const s = await setup(t)
  await s.gh.respond([
    { match: 'mergeStateStatus', stdout: pr() },
    { match: 'state,mergeCommit', stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: OTHER } }) },
  ])
  const { code, stdout, stderr } = await s.cli('merge')
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { merged: true, already: false, merge_commit: OTHER })
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [VIEW, MERGE, VERIFY])
})

test('merge on a PR that is already merged (a resumed run) merges nothing', async (t) => {
  const s = await setup(t, { phase: 'merged' })
  await s.gh.respond([{ match: 'mergeStateStatus', stdout: pr({ state: 'MERGED', mergeable: 'UNKNOWN' }) }])
  const { code, stdout } = await s.cli('merge')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { merged: true, already: true })
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [VIEW])
})

const REFUSALS: { name: string; pr: Pr; problem: RegExp }[] = [
  { name: 'red CI', pr: { statusCheckRollup: [RED_RUN] }, problem: /gate stop.*CI failed: test/ },
  { name: 'running CI', pr: { statusCheckRollup: [PENDING_RUN] }, problem: /gate wait.*CI is still running/ },
  { name: 'a merge conflict', pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, problem: /gate stop.*conflict/ },
  { name: 'a moved head', pr: { headRefOid: OTHER }, problem: /gate stop.*head moved/ },
]

for (const c of REFUSALS) {
  test(`merge refuses ${c.name} and calls no merge`, async (t) => {
    const s = await setup(t)
    await s.gh.respond([{ match: 'mergeStateStatus', stdout: pr(c.pr) }])
    const { code, stderr } = await s.cli('merge')
    assert.equal(code, 1)
    assert.match(stderr, c.problem)
    assert.deepEqual((await s.gh.calls()).map((call) => call.argv), [VIEW])
  })
}

for (const mode of ['layer', 'stack-final']) {
  test(`merge refuses a ${mode} run without asking GitHub`, async (t) => {
    const s = await setup(t, { mode })
    const { code, stderr } = await s.cli('merge')
    assert.equal(code, 1)
    assert.match(stderr, new RegExp(`${mode} mode: review-pipeline does not merge it`))
    assert.deepEqual(await s.gh.calls(), [])
  })
}

test('merge refuses before the explainer step', async (t) => {
  const s = await setup(t, { phase: 'ready' })
  const { code, stderr } = await s.cli('merge')
  assert.equal(code, 1)
  assert.match(stderr, /merge needs phase explained, but PR #13 is at ready/)
  assert.deepEqual(await s.gh.calls(), [])
})

test('merge reports GitHub refusing the merge', async (t) => {
  const s = await setup(t)
  await s.gh.respond([
    { match: 'mergeStateStatus', stdout: pr() },
    { match: 'pr merge', stderr: 'Head branch was modified', exit: 1 },
  ])
  const { code, stderr } = await s.cli('merge')
  assert.equal(code, 1)
  assert.match(stderr, /GitHub refused the squash merge of PR #13: Head branch was modified/)
})

test('merge fails when the PR is not MERGED after the merge call', async (t) => {
  const s = await setup(t)
  await s.gh.respond([
    { match: 'mergeStateStatus', stdout: pr() },
    { match: 'state,mergeCommit', stdout: JSON.stringify({ state: 'OPEN', mergeCommit: null }) },
  ])
  const { code, stderr } = await s.cli('merge')
  assert.equal(code, 1)
  assert.match(stderr, /PR #13 is OPEN after the merge call, not MERGED/)
})

const ME: FakeGhResponse = { match: 'api user', stdout: 'alilloig\n' }
const ISSUE_COMMENTS = ['api', '--paginate', '--jq', '.[] | {id, body, login: .user.login}', `repos/${REPO}/issues/13/comments`]
const COMMENT_POST = ['api', '-X', 'POST', `repos/${REPO}/issues/13/comments`, '--input', '-']
const EXPLAINER_MARKER = '<!-- hero-pocock:review-pipeline pr=13 kind=explainer -->'

async function withExplainer(t: Parameters<typeof tempDir>[0]) {
  const s = await setup(t, { phase: 'ready' })
  const file = join(s.dir, 'state', 'pr-13', 'explainer.html')
  await writeFile(file, '<!doctype html><title>PR #13</title>')
  return { ...s, file }
}

test('explainer records the path and links it from the PR in one comment', async (t) => {
  const s = await withExplainer(t)
  await s.gh.respond([{ match: '--input', stdout: JSON.stringify({ id: 900 }) }, ME])
  const { code, stdout, stderr } = await s.cli('explainer', '--file', s.file)
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { explainer: s.file, comment: { id: 900, posted: true } })
  const calls = await s.gh.calls()
  assert.deepEqual(calls.map((c) => c.argv), [['api', 'user', '--jq', '.login'], ISSUE_COMMENTS, COMMENT_POST])
  assert.deepEqual(JSON.parse(calls[2]!.stdin), { body: `Explainer (local, not published): \`${s.file}\`\n\n${EXPLAINER_MARKER}` })
  assert.equal((await s.state()).explainer, s.file)
})

test('explainer on a re-run posts no second comment', async (t) => {
  const s = await withExplainer(t)
  await s.gh.respond([
    { match: 'issues/13/comments', stdout: `${JSON.stringify({ id: 777, login: 'alilloig', body: `x\n\n${EXPLAINER_MARKER}` })}\n` },
    ME,
  ])
  const { code, stdout } = await s.cli('explainer', '--file', s.file)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { explainer: s.file, comment: { id: 777, posted: false } })
  assert.ok((await s.gh.calls()).every((c) => !c.argv.includes('POST')))
})

test('explainer ignores the marker in a comment by someone else', async (t) => {
  const s = await withExplainer(t)
  await s.gh.respond([
    { match: '--input', stdout: JSON.stringify({ id: 901 }) },
    { match: 'issues/13/comments', stdout: `${JSON.stringify({ id: 5, login: 'mallory', body: EXPLAINER_MARKER })}\n` },
    ME,
  ])
  const { code, stdout } = await s.cli('explainer', '--file', s.file)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout).comment, { id: 901, posted: true })
})

test('explainer needs an absolute path to a file that exists', async (t) => {
  const s = await withExplainer(t)
  const relative = await s.cli('explainer', '--file', 'explainer.html')
  assert.equal(relative.code, 2)
  assert.match(relative.stderr, /--file must be an absolute path/)
  const missing = await s.cli('explainer', '--file', join(s.dir, 'nope.html'))
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /no explainer file at .*nope\.html: build it first/)
  assert.deepEqual(await s.gh.calls(), [])
  assert.equal((await s.state()).explainer, null)
})
