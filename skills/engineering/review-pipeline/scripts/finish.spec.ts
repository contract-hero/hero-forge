// The Finish subcommands: merge-gate, merge, explainer.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { appKey, fakeGh, fakeGitHubApi, runCli, seedState, tempDir, type FakeApiRoute, type FakeGhResponse } from './test-helpers.ts'

const SHA = 'c'.repeat(40)
const OTHER = 'd'.repeat(40)
const REPO = 'contract-hero/hero-forge'
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
// The reviewer App's own gate status: not CI, so merge-gate leaves it out of `ci`.
const GATE_STATUS = { __typename: 'StatusContext', context: 'contract-reviewer/gate', state: 'SUCCESS' }

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

const BOT = 'hero-reviewer[bot]'
const CONFIG = '```yaml\nruntime: claude\n```\n'
const APP_CONFIG = '```yaml\nruntime: claude\napp: enabled\n```\n'
const PASS = { round: 1, commit: SHA, result: 'pass' }
const APPROVE = { round: 1, kind: 'verdict', id: 601, commit: SHA, as: BOT, event: 'APPROVE' }
const APP_REVIEWS = ['api', '--paginate', '--jq', '.[] | {id, state, commit_id, login: .user.login}', `repos/${REPO}/pulls/13/reviews`]
// GitHub's answers for the reviewer App installed on the repo: its login,
// from its own credentials, is hero-reviewer[bot].
const APP_ROUTES: Record<string, FakeApiRoute> = {
  [`GET /repos/${REPO}/installation`]: { status: 200, body: { id: 4242 } },
  'POST /app/installations/4242/access_tokens': { status: 201, body: { token: 'ghs_faketoken0123456789' } },
  'GET /app': { status: 200, body: { slug: 'hero-reviewer' } },
}

type Setup = {
  mode?: string
  phase?: string
  noState?: boolean
  // With the reviewer App: `app: enabled` in the config, and the bot as the
  // run's reviewer_login (unless `state` says otherwise).
  app?: boolean
  config?: string
  state?: Record<string, unknown>
  routes?: Record<string, FakeApiRoute>
}

// A run state for PR #13 at `phase` (default explained) with a passing
// re-check gate at its head (and with the App, the App's APPROVE there), a
// review config, the reviewer App's credentials with a fake GitHub API that
// trusts them, and a fake gh.
async function setup(t: Parameters<typeof tempDir>[0], options: Setup = {}) {
  const dir = await tempDir(t)
  const gh = await fakeGh(dir)
  const root = join(dir, 'state')
  const key = await appKey(dir)
  const api = await fakeGitHubApi(t, key.publicKey, options.routes ?? APP_ROUTES)
  const appEnv = join(dir, 'reviewer-app.env')
  await writeFile(appEnv, `HERO_FORGE_REVIEWER_APP_ID=123456\nHERO_FORGE_REVIEWER_APP_KEY=${key.pem}\n`)
  const env = { ...gh.env, HERO_FORGE_STATE_DIR: root, HERO_FORGE_REVIEWER_APP_ENV: appEnv, HERO_FORGE_GITHUB_API_URL: api.url }
  const configPath = join(dir, 'review.md')
  await writeFile(configPath, options.config ?? (options.app ? APP_CONFIG : CONFIG))
  if (options.noState !== true) {
    await seedState(root, {
      head_sha: SHA,
      mode: options.mode ?? 'single',
      phase: options.phase ?? 'explained',
      reviewer_login: options.app ? BOT : 'none',
      gates: [PASS],
      reviews: options.app ? [APPROVE] : [],
      ...options.state,
    })
  }
  const needsConfig = (name: string | undefined) => name === 'merge-gate' || name === 'merge'
  const cli = (...args: string[]) =>
    runCli([...args, '--repo', REPO, '--pr', '13', ...(needsConfig(args[0]) ? ['--config', configPath] : [])], { env })
  const state = async () => JSON.parse((await runCli(['run-state', 'read', '--pr', '13'], { env })).stdout)
  return { dir, gh, cli, state, env, configPath, api }
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
  { name: 'only the contract-reviewer/gate status is go, with ci none', pr: { statusCheckRollup: [GATE_STATUS] }, gate: 'go', ci: 'none' },
  {
    name: 'the contract-reviewer/gate status and a failed check run is stop, with ci red',
    pr: { statusCheckRollup: [GATE_STATUS, RED_RUN] }, gate: 'stop', ci: 'red', problem: /CI failed: test$/,
  },
  { name: 'a merge conflict is stop', pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, gate: 'stop', ci: 'green', problem: /conflict/ },
  { name: 'mergeable not yet computed is wait', pr: { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, gate: 'wait', ci: 'green', problem: /UNKNOWN/ },
  { name: 'branch protection blocking is stop', pr: { mergeStateStatus: 'BLOCKED' }, gate: 'stop', ci: 'green', problem: /BLOCKED/ },
  { name: 'a branch behind its base is stop', pr: { mergeStateStatus: 'BEHIND' }, gate: 'stop', ci: 'green', problem: /BEHIND/ },
  { name: 'a draft PR is stop', pr: { isDraft: true, mergeStateStatus: 'DRAFT' }, gate: 'stop', ci: 'green', problem: /draft/ },
  { name: 'a head the re-checker did not see is stop', pr: { headRefOid: OTHER }, gate: 'stop', ci: 'green', problem: /head moved.*run-state supersede --pr 13/ },
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

// The re-check gate is part of the merge gate on both paths: the latest gate
// result recorded at the head must be a pass.
const RECHECKS: { name: string; gates: unknown[]; problem: string }[] = [
  { name: 'no re-check recorded at all', gates: [], problem: `no re-check is recorded at the head ${SHA}: run the re-check first` },
  { name: 'a re-check that passed only at an older head', gates: [{ ...PASS, commit: OTHER }],
    problem: `no re-check is recorded at the head ${SHA}: run the re-check first` },
  { name: 'a re-check at the head that failed', gates: [{ ...PASS, result: 'fail' }],
    problem: `the latest re-check at the head ${SHA} failed: the PR cannot merge` },
  { name: 'a pass, then a later fail at the head', gates: [PASS, { ...PASS, round: 2, result: 'fail' }],
    problem: `the latest re-check at the head ${SHA} failed: the PR cannot merge` },
]

for (const app of [false, true]) {
  for (const c of RECHECKS) {
    test(`merge-gate ${app ? 'with' : 'without'} the App: ${c.name} is stop`, async (t) => {
      const s = await setup(t, { app, state: { gates: c.gates } })
      await s.gh.respond([
        { match: 'mergeStateStatus', stdout: pr() },
        { match: 'pulls/13/reviews', stdout: `${JSON.stringify({ id: 601, state: 'APPROVED', commit_id: SHA, login: BOT })}\n` },
      ])
      const { code, stdout, stderr } = await s.cli('merge-gate')
      assert.equal(code, 0, stderr)
      const out = JSON.parse(stdout)
      assert.equal(out.gate, 'stop')
      assert.deepEqual(out.problems, [c.problem])
    })
  }
}

// The config, not the run state, says whether the reviewer App is in play.
test('merge-gate stops when the config enables the App but the run state has no reviewer login', async (t) => {
  const s = await setup(t, { config: APP_CONFIG })
  await s.gh.respond([{ match: 'mergeStateStatus', stdout: pr() }])
  const out = JSON.parse((await s.cli('merge-gate')).stdout)
  assert.equal(out.gate, 'stop')
  assert.deepEqual(out.problems, ['the config enables the reviewer App, but the run state has reviewer_login none: the App approval cannot be checked'])
})

test('merge-gate stops when the run state names an App the config does not enable', async (t) => {
  const s = await setup(t, { app: true, config: CONFIG })
  await s.gh.respond([{ match: 'mergeStateStatus', stdout: pr() }])
  const out = JSON.parse((await s.cli('merge-gate')).stdout)
  assert.equal(out.gate, 'stop')
  assert.deepEqual(out.problems, [`the config does not enable the reviewer App, but the run state has reviewer_login ${BOT}`])
})

// With the reviewer App, its APPROVE on the re-checked head is part of the
// gate, in the run state and on GitHub: the bot's latest review that is not a
// COMMENT must be APPROVED, on the head commit.
const review = (state: string, over: Record<string, unknown> = {}) =>
  `${JSON.stringify({ id: 700, state, commit_id: SHA, login: BOT, ...over })}\n`
const LOCAL_NOT_APPROVED = `the reviewer App ${BOT} has not approved the re-checked head ${SHA}: post its APPROVE verdict first`
const APPROVALS: { name: string; reviews?: unknown[]; github: string; gate: string; problem?: string }[] = [
  { name: 'an App approval of the re-checked head is go', github: review('APPROVED'), gate: 'go' },
  { name: 'a bot COMMENT after its approval is still go', github: review('APPROVED') + review('COMMENTED', { id: 701 }), gate: 'go' },
  { name: 'no App verdict in the run state is stop', reviews: [], github: review('APPROVED'), gate: 'stop', problem: LOCAL_NOT_APPROVED },
  { name: 'a recorded REQUEST_CHANGES at the head is stop', reviews: [{ ...APPROVE, event: 'REQUEST_CHANGES' }], github: review('APPROVED'),
    gate: 'stop', problem: LOCAL_NOT_APPROVED },
  { name: 'a recorded APPROVE, then a REQUEST_CHANGES at the head, is stop',
    reviews: [APPROVE, { ...APPROVE, id: 602, event: 'REQUEST_CHANGES' }], github: review('APPROVED'), gate: 'stop', problem: LOCAL_NOT_APPROVED },
  { name: 'a recorded approval of an older head is stop', reviews: [{ ...APPROVE, commit: OTHER }], github: review('APPROVED'),
    gate: 'stop', problem: LOCAL_NOT_APPROVED },
  { name: 'an approval of an older head recorded again at the head (a restack, by an older version) is stop',
    reviews: [{ ...APPROVE, commit: OTHER }, APPROVE], github: review('APPROVED'), gate: 'stop', problem: LOCAL_NOT_APPROVED },
  { name: 'a verdict recorded by another poster is stop', reviews: [{ ...APPROVE, as: 'user' }], github: review('APPROVED'),
    gate: 'stop', problem: LOCAL_NOT_APPROVED },
  { name: 'no approval on GitHub is stop', github: '', gate: 'stop',
    problem: `GitHub shows no review by ${BOT} that approves the head ${SHA}` },
  { name: 'a later CHANGES_REQUESTED on GitHub is stop', github: review('APPROVED') + review('CHANGES_REQUESTED', { id: 701 }), gate: 'stop',
    problem: `on GitHub, the latest review by ${BOT} is CHANGES_REQUESTED on ${SHA}, not APPROVED on the head ${SHA}` },
  { name: 'a dismissed approval on GitHub is stop', github: review('DISMISSED'), gate: 'stop',
    problem: `on GitHub, the latest review by ${BOT} is DISMISSED on ${SHA}, not APPROVED on the head ${SHA}` },
  { name: 'a GitHub approval of an older commit is stop', github: review('APPROVED', { commit_id: OTHER }), gate: 'stop',
    problem: `on GitHub, the latest review by ${BOT} is APPROVED on ${OTHER}, not APPROVED on the head ${SHA}` },
  { name: 'an approval by someone else on GitHub is stop', github: review('APPROVED', { login: 'mallory' }), gate: 'stop',
    problem: `GitHub shows no review by ${BOT} that approves the head ${SHA}` },
]

for (const c of APPROVALS) {
  test(`merge-gate with the App: ${c.name}`, async (t) => {
    const s = await setup(t, { app: true, state: c.reviews === undefined ? {} : { reviews: c.reviews } })
    await s.gh.respond([{ match: 'mergeStateStatus', stdout: pr() }, { match: 'pulls/13/reviews', stdout: c.github }])
    const { code, stdout, stderr } = await s.cli('merge-gate')
    assert.equal(code, 0, stderr)
    const out = JSON.parse(stdout)
    assert.equal(out.gate, c.gate)
    assert.deepEqual(out.problems, c.problem === undefined ? [] : [c.problem])
    assert.deepEqual((await s.gh.calls()).map((call) => call.argv), [VIEW, APP_REVIEWS])
  })
}

// The bot login the gate checks comes from the App's own credentials, never
// from the run state alone, which an agent with a shell can edit.
test('merge-gate with the App stops when the run state names a login that is not the App', async (t) => {
  const forged = 'mallory[bot]'
  const s = await setup(t, { app: true, state: { reviewer_login: forged, reviews: [{ ...APPROVE, as: forged }] } })
  await s.gh.respond([
    { match: 'mergeStateStatus', stdout: pr() },
    { match: 'pulls/13/reviews', stdout: review('APPROVED', { login: forged }) },
  ])
  const { code, stdout, stderr } = await s.cli('merge-gate')
  assert.equal(code, 0, stderr)
  const out = JSON.parse(stdout)
  assert.equal(out.gate, 'stop')
  assert.deepEqual(out.problems, [
    `the run state names reviewer_login ${forged}, but the reviewer App's credentials say its login is ${BOT}`,
  ])
})

test('merge with the App never merges on an APPROVE by a login that is not the App', async (t) => {
  const forged = 'mallory[bot]'
  const s = await setup(t, { app: true, state: { reviewer_login: forged, reviews: [{ ...APPROVE, as: forged }] } })
  await s.gh.respond([
    { match: 'mergeStateStatus', stdout: pr() },
    { match: 'pulls/13/reviews', stdout: review('APPROVED', { login: forged }) },
  ])
  const { code, stderr } = await s.cli('merge')
  assert.equal(code, 1)
  assert.match(stderr, /gate stop.*credentials say its login is hero-reviewer\[bot\]/)
  assert.ok((await s.gh.calls()).every((c) => c.argv[1] !== 'merge'))
})

test('merge-gate with an App whose credentials fail exits 4 before it reads the PR', async (t) => {
  const s = await setup(t, { app: true, routes: { ...APP_ROUTES, 'GET /app': { status: 500, body: { message: 'boom' } } } })
  const { code, stdout, stderr } = await s.cli('merge-gate')
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts merge-gate: read the App failed: HTTP 500/)
  assert.deepEqual(await s.gh.calls(), [])
})

test('merge-gate without the App never asks the App API', async (t) => {
  const s = await setup(t)
  await s.gh.respond([{ match: 'mergeStateStatus', stdout: pr() }])
  assert.equal(JSON.parse((await s.cli('merge-gate')).stdout).gate, 'go')
  assert.deepEqual(s.api.requests, [])
})

test('merge-gate with the App reports gh failing to list the reviews', async (t) => {
  const s = await setup(t, { app: true })
  await s.gh.respond([{ match: 'mergeStateStatus', stdout: pr() }, { match: 'pulls/13/reviews', stderr: 'HTTP 502', exit: 1 }])
  const { code, stderr } = await s.cli('merge-gate')
  assert.equal(code, 1)
  assert.match(stderr, /cannot list the reviews of PR #13: HTTP 502/)
})

test('merge-gate with a missing config exits 4', async (t) => {
  const s = await setup(t)
  await rm(s.configPath)
  const { code, stderr } = await s.cli('merge-gate')
  assert.equal(code, 4)
  assert.match(stderr, /no review config/)
  assert.deepEqual(await s.gh.calls(), [])
})

test('merge-gate with no run state exits 3', async (t) => {
  const s = await setup(t, { noState: true })
  const { code, stderr } = await s.cli('merge-gate')
  assert.equal(code, 3)
  assert.match(stderr, /no run state for PR #13/)
  assert.deepEqual(await s.gh.calls(), [])
})

test('merge-gate refuses a repo that is not the run state repo', async (t) => {
  const s = await setup(t)
  const { code, stderr } = await runCli(['merge-gate', '--repo', 'someone/else', '--pr', '13', '--config', s.configPath], {
    env: { ...s.gh.env, HERO_FORGE_STATE_DIR: join(s.dir, 'state') },
  })
  assert.equal(code, 1)
  assert.match(stderr, /contract-hero\/hero-forge/)
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

test('merge with the App confirms the App approval on GitHub before it merges', async (t) => {
  const s = await setup(t, { app: true })
  await s.gh.respond([
    { match: 'mergeStateStatus', stdout: pr() },
    { match: 'pulls/13/reviews', stdout: review('APPROVED') },
    { match: 'state,mergeCommit', stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: OTHER } }) },
  ])
  const { code, stderr } = await s.cli('merge')
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [VIEW, APP_REVIEWS, MERGE, VERIFY])
})

test('merge with the App refuses a later CHANGES_REQUESTED on GitHub and calls no merge', async (t) => {
  const s = await setup(t, { app: true })
  await s.gh.respond([
    { match: 'mergeStateStatus', stdout: pr() },
    { match: 'pulls/13/reviews', stdout: review('APPROVED') + review('CHANGES_REQUESTED', { id: 701 }) },
  ])
  const { code, stderr } = await s.cli('merge')
  assert.equal(code, 1)
  assert.match(stderr, /gate stop.*CHANGES_REQUESTED/)
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [VIEW, APP_REVIEWS])
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
const EXPLAINER_MARKER = '<!-- hero-forge:review-pipeline pr=13 kind=explainer -->'

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

test('an explainer path that holds a token is refused before any gh call and is not recorded', async (t) => {
  const s = await setup(t, { phase: 'ready' })
  const dir = join(s.dir, `ghp_${'A1b2'.repeat(9)}`)
  await mkdir(dir)
  const file = join(dir, 'explainer.html')
  await writeFile(file, '<!doctype html>')
  const { code, stdout, stderr } = await s.cli('explainer', '--file', file)
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts explainer: the explainer comment contains what looks like a GitHub token\. Nothing was posted/)
  assert.deepEqual(await s.gh.calls(), [])
  assert.equal((await s.state()).explainer, null)
})

test('an explainer path that holds the pipeline marker is refused before any gh call', async (t) => {
  const s = await setup(t, { phase: 'ready' })
  const dir = join(s.dir, 'hero-forge:review-pipeline')
  await mkdir(dir)
  const file = join(dir, 'explainer.html')
  await writeFile(file, '<!doctype html>')
  const { code, stderr } = await s.cli('explainer', '--file', file)
  assert.equal(code, 1)
  assert.match(stderr, /--file contains the marker "hero-forge:review-pipeline"/)
  assert.deepEqual(await s.gh.calls(), [])
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
