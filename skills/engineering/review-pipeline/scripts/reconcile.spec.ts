// `review.ts reconcile`: the open work on GitHub in, one route decision per
// item out. Each kind of missed work must get the decision that `route`
// gives the recorded event of that kind.
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { takeLock } from './lock.ts'
import { fakeGh, runCli, seedState, tempDir, type FakeGhResponse } from './test-helpers.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'route')
const REPO = 'contract-hero/hero-forge'
const MAINTAINER = 'alilloig'
const IMPLEMENTER_BOT = 'contract-implementer[bot]'
const REVIEWER_BOT = 'contract-reviewer[bot]'

// A review.md on the default branch, with the Implementer App on and the
// given lines in its YAML block.
function reviewMd(...yaml: string[]): string {
  return `# Review pipeline\n\n\`\`\`yaml\n${['runtime: codex', 'app: enabled', 'implementer:', '  app: enabled', ...yaml].join('\n')}\n\`\`\`\n`
}

// What GitHub holds, in the shape each list call prints, one JSON object a line.
type Listed = { number: number; author: string; labels: string[]; pull_request: boolean }
type LabelEvent = { id: number; label: string; actor: string }
type Pull = { number: number; author: string; draft: boolean; head_sha: string; labels: string[] }
type Comment = { id: number; author: string; body: string; created_at: string }
// `author` and `bot` as GraphQL gives them: a bot's login has no [bot] suffix.
type Closer = { number: number; author: string | null; bot: boolean; closes: { number: number; repo: string }[] }
type Sub = { number: number; author: string }

type GitHub = {
  review?: string | null
  labelled?: Listed[]
  events?: Record<number, LabelEvent[]>
  pulls?: Pull[]
  closers?: Closer[]
  comments?: Record<number, Comment[]>
  needsInfo?: Listed[]
  // The sub-issues of each issue (none when absent).
  subs?: Record<number, Sub[]>
  // The issues that block each issue, in any state and repo (none when absent).
  blockers?: Record<number, Blocker[]>
}
type Blocker = { number: number; state: 'open' | 'closed'; repo: string }

const lines = (items: unknown[]) => items.map((item) => `${JSON.stringify(item)}\n`).join('')

function responses(github: GitHub): FakeGhResponse[] {
  const { review = reviewMd() } = github
  const perIssue = (path: string, of: Record<number, unknown[]> | undefined): FakeGhResponse[] =>
    Object.entries(of ?? {}).map(([n, items]) => ({ match: `repos/${REPO}/issues/${n}/${path}`, stdout: lines(items) }))
  const relations = Object.entries(github.subs ?? {}).map(([n, subs]) => ({
    match: `repos/${REPO}/issues/${n} `,
    stdout: `${JSON.stringify({ parent_issue_url: null, sub_issues_summary: { total: subs.length, completed: 0, percent_completed: 0 }, labels: ['ready-for-agent'] })}\n`,
  }))
  return [
    review === null
      ? { match: 'contents/docs/agents/review.md', stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)\n', exit: 1 }
      : { match: 'contents/docs/agents/review.md', stdout: review },
    { match: 'api user', stdout: `${MAINTAINER}\n` },
    { match: 'labels=ready-for-agent', stdout: lines(github.labelled ?? []) },
    { match: 'labels=needs-info', stdout: lines(github.needsInfo ?? []) },
    { match: 'pulls?state=open', stdout: lines(github.pulls ?? []) },
    { match: 'closingIssuesReferences', stdout: lines(github.closers ?? []) },
    ...perIssue('events', github.events),
    ...perIssue('comments', github.comments),
    ...perIssue('sub_issues', github.subs),
    { match: '/sub_issues', stdout: '' },
    ...Object.entries(github.blockers ?? {}).map(([n, blockers]) => ({
      match: `repos/${REPO}/issues/${n}/dependencies/blocked_by`,
      stdout: lines(blockers.map(({ repo, ...b }) => ({ ...b, repository_url: `https://api.github.com/repos/${repo}` }))),
    })),
    { match: '/dependencies/blocked_by', stdout: '' },
    ...relations,
    // An issue with no sub-issues and no parent, labelled ready-for-agent: a ticket.
    { match: `repos/${REPO}/issues/`, stdout: `${JSON.stringify({ parent_issue_url: null, sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 }, labels: ['ready-for-agent'] })}\n` },
  ]
}

type Setup = Parameters<typeof tempDir>[0]

// A machine with its own run-state dir, cap dir and fake gh.
async function machine(t: Setup, github: GitHub = {}) {
  const dir = await tempDir(t)
  const state = join(dir, 'state')
  const caps = join(dir, 'caps')
  const gh = await fakeGh(dir, responses(github))
  const env = { ...gh.env, HERO_FORGE_STATE_DIR: state, HERO_FORGE_CAP_DIR: caps }
  return {
    dir,
    state,
    caps,
    gh,
    reconcile: (...extra: string[]) => runCli(['reconcile', '--repo', REPO, ...extra], { env }),
    // `route` on a recorded payload in fixtures/route/, for the same App.
    route: (app: string, fixture: string, delivery = '6f1e2d3c-0000-11f0-8a1b-0123456789ab') =>
      runCli(['route', '--app', app, '--event', fixture.split('.')[0] ?? '', '--delivery', delivery, '--payload', join(FIXTURES, fixture)], { env }),
  }
}

type Decision = { action: string; repo: string | null; pr: number | null; issue: number | null; reason: string | null; app?: string }

// A decision line without its lock_token, once the token has the right form:
// 32 hex for work, null on an ignore.
function decided(line: string): Decision {
  const { lock_token: token, ...rest } = JSON.parse(line) as Decision & { lock_token?: unknown }
  if (rest.action === 'ignore') assert.equal(token, null)
  else assert.match(String(token), /^[0-9a-f]{32}$/)
  return rest
}

// Every line a sweep printed, after it exited 0 with nothing on stderr.
async function swept(result: Promise<{ code: number | null; stdout: string; stderr: string }>): Promise<Decision[]> {
  const { code, stdout, stderr } = await result
  assert.equal(stderr, '')
  assert.equal(code, 0)
  return stdout.split('\n').filter((line) => line !== '').map(decided)
}

// What `route` prints for a recorded event, on a fresh machine set up as `before` says.
async function routed(t: Setup, github: GitHub, app: string, fixture: string, before?: (m: Awaited<ReturnType<typeof machine>>) => Promise<void>) {
  const m = await machine(t, github)
  await before?.(m)
  const { code, stdout, stderr } = await m.route(app, fixture)
  assert.equal(stderr, '')
  assert.equal(code, 0)
  return { ...decided(stdout), app }
}

// The open ticket #28 of issues.labeled.json, labelled by `actor`.
const ticket28 = (actor = MAINTAINER): GitHub => ({
  labelled: [{ number: 28, author: MAINTAINER, labels: ['enhancement', 'ready-for-agent'], pull_request: false }],
  events: {
    28: [
      { id: 9001, label: 'enhancement', actor: MAINTAINER },
      { id: 9002, label: 'ready-for-agent', actor: 'mallory' },
      { id: 9003, label: 'ready-for-agent', actor },
    ],
  },
})

test('reconcile: a missed label on a ticket is the build-ticket that route gives the labeled event', async (t) => {
  const m = await machine(t, ticket28())
  const expected = await routed(t, ticket28(), 'implementer', 'issues.labeled.json')
  assert.deepEqual(expected, { action: 'build-ticket', repo: REPO, pr: null, issue: 28, reason: null, app: 'implementer' })
  assert.deepEqual(await swept(m.reconcile()), [expected])
})

test('reconcile: a label whose latest adder is someone else is the ignore (sender) that route gives', async (t) => {
  const m = await machine(t, ticket28('mallory'))
  const expected = await routed(t, ticket28('mallory'), 'implementer', 'issues.labeled.stranger.json')
  assert.deepEqual(expected, { action: 'ignore', repo: REPO, pr: null, issue: 28, reason: 'sender', app: 'implementer' })
  assert.deepEqual(await swept(m.reconcile()), [expected])
})

// The open spec #23 of issues.labeled.spec.json, with sub-issues #24 to #26.
const spec23 = (over: GitHub = {}): GitHub => ({
  labelled: [{ number: 23, author: MAINTAINER, labels: ['ready-for-agent'], pull_request: false }],
  events: { 23: [{ id: 9101, label: 'ready-for-agent', actor: MAINTAINER }] },
  subs: { 23: [24, 25, 26].map((number) => ({ number, author: MAINTAINER })) },
  ...over,
})

test('reconcile: a missed label on a spec is the build-spec that route gives the labeled event', async (t) => {
  const m = await machine(t, spec23())
  const expected = await routed(t, spec23(), 'implementer', 'issues.labeled.spec.json')
  assert.deepEqual(expected, { action: 'build-spec', repo: REPO, pr: null, issue: 23, reason: null, app: 'implementer' })
  assert.deepEqual(await swept(m.reconcile()), [expected])
})

// An open PR #50 by `author`, that closes `closes` (and an issue of another repo).
const pr50 = (author: string, ...closes: number[]): Pick<GitHub, 'pulls' | 'closers'> => {
  const bot = author.endsWith('[bot]')
  return {
    pulls: [{ number: 50, author, draft: true, head_sha: 'b'.repeat(40), labels: [] }],
    closers: [
      {
        number: 50,
        author: bot ? author.slice(0, -'[bot]'.length) : author,
        bot,
        closes: [...closes.map((number) => ({ number, repo: REPO })), { number: 28, repo: 'contract-hero/other' }],
      },
    ],
  }
}

test('reconcile: a ticket that an open PR closes is ignore (has-pr), and takes no lock and no attempt', async (t) => {
  const m = await machine(t, { ...ticket28(), ...pr50(IMPLEMENTER_BOT, 28) })
  const lines = await swept(m.reconcile())
  assert.deepEqual(lines[0], { action: 'ignore', repo: REPO, pr: null, issue: 28, reason: 'has-pr', app: 'implementer' })
  await assert.rejects(readFile(join(m.caps, 'implementer-app-attempts.json')), { code: 'ENOENT' })
  // The build of #28 can still start once the PR is gone.
  await m.gh.respond(responses(ticket28()))
  assert.deepEqual((await swept(m.reconcile()))[0], { action: 'build-ticket', repo: REPO, pr: null, issue: 28, reason: null, app: 'implementer' })
})

test('reconcile: a spec one of whose sub-issues an open PR closes is ignore (has-pr)', async (t) => {
  const m = await machine(t, spec23(pr50(IMPLEMENTER_BOT, 25)))
  assert.deepEqual((await swept(m.reconcile()))[0], { action: 'ignore', repo: REPO, pr: null, issue: 23, reason: 'has-pr', app: 'implementer' })
})

test('reconcile: a ticket that an open maintainer PR closes is ignore (has-pr), the login matched in any case', async (t) => {
  const m = await machine(t, { ...ticket28(), ...pr50('AliLloig', 28) })
  assert.deepEqual((await swept(m.reconcile()))[0], { action: 'ignore', repo: REPO, pr: null, issue: 28, reason: 'has-pr', app: 'implementer' })
})

test('reconcile: an open PR by someone else that closes a ticket or a sub-issue does not hide it: route decides', async (t) => {
  const ticket = await machine(t, { ...ticket28(), ...pr50('octo-stranger', 28) })
  assert.deepEqual((await swept(ticket.reconcile()))[0], { action: 'build-ticket', repo: REPO, pr: null, issue: 28, reason: null, app: 'implementer' })
  const spec = await machine(t, spec23(pr50('octo-stranger', 25)))
  assert.deepEqual((await swept(spec.reconcile()))[0], { action: 'build-spec', repo: REPO, pr: null, issue: 23, reason: null, app: 'implementer' })
  // A human login that only looks like the bot's is someone else too.
  const lookalike = await machine(t, { ...ticket28(), closers: [{ number: 50, author: 'contract-implementer', bot: false, closes: [{ number: 28, repo: REPO }] }] })
  assert.deepEqual((await swept(lookalike.reconcile()))[0], { action: 'build-ticket', repo: REPO, pr: null, issue: 28, reason: null, app: 'implementer' })
})

test('reconcile: a PR that closes an issue of the same number in another repo is no PR for the ticket', async (t) => {
  const m = await machine(t, { ...ticket28(), ...pr50(IMPLEMENTER_BOT) })
  assert.deepEqual((await swept(m.reconcile()))[0], { action: 'build-ticket', repo: REPO, pr: null, issue: 28, reason: null, app: 'implementer' })
})

const HEAD = '3f1c2a9b8e7d6c5b4a39281706f5e4d3c2b1a090'

// The open PR #42 of the pull_request fixtures, at HEAD.
const pr42 = (author: string, draft: boolean): GitHub => ({ pulls: [{ number: 42, author, draft, head_sha: HEAD, labels: [] }] })

// Each case: the test name, the open PR, the recorded event route decides, and its decision.
const missedPrs: [string, GitHub, string, Partial<Decision>][] = [
  ['a maintainer PR that is not a draft', pr42(MAINTAINER, false), 'pull_request.ready_for_review.json', { action: 'review', reason: null }],
  ['a contract-implementer[bot] draft PR', pr42(IMPLEMENTER_BOT, true), 'pull_request.opened.implementer.json', { action: 'review', reason: null }],
  ['a maintainer draft PR', pr42(MAINTAINER, true), 'pull_request.opened.draft.json', { action: 'ignore', reason: 'action:opened' }],
  ['a PR by another author', pr42('octo-stranger', false), 'pull_request.opened.stranger.json', { action: 'ignore', reason: 'author' }],
]

for (const [name, github, fixture, outcome] of missedPrs) {
  test(`reconcile: ${name} with no run state is the decision route gives ${fixture}`, async (t) => {
    const m = await machine(t, github)
    const expected = await routed(t, github, 'reviewer', fixture)
    assert.deepEqual(expected, { repo: REPO, pr: 42, issue: null, app: 'reviewer', ...outcome })
    assert.deepEqual(await swept(m.reconcile()), [expected])
  })
}

test('reconcile: a PR whose run state is at its head is no missed work, whatever the phase', async (t) => {
  for (const phase of ['review-posted', 'stopped']) {
    const m = await machine(t, pr42(MAINTAINER, false))
    await seedState(m.state, { pr: 42, phase, head_sha: HEAD })
    assert.deepEqual(await swept(m.reconcile()), [])
  }
})

test('reconcile: a PR whose run is at another head and not over is the ignore (locked) route gives', async (t) => {
  const seed = (m: { state: string }) => seedState(m.state, { pr: 42, phase: 'review-posted' }).then(() => {})
  const m = await machine(t, pr42(MAINTAINER, false))
  await seed(m)
  const expected = await routed(t, {}, 'reviewer', 'pull_request.ready_for_review.json', seed)
  assert.deepEqual(expected, { action: 'ignore', repo: REPO, pr: 42, issue: null, reason: 'locked', app: 'reviewer' })
  assert.deepEqual(await swept(m.reconcile()), [expected])
})

test('reconcile: a completed layer of a stack, at another head, is the ignore (stack) route gives a late ready_for_review', async (t) => {
  const seed = (m: { state: string }) => seedState(m.state, { pr: 42, phase: 'complete', mode: 'layer' }).then(() => {})
  const m = await machine(t, pr42(MAINTAINER, false))
  await seed(m)
  const expected = await routed(t, {}, 'reviewer', 'pull_request.ready_for_review.json', seed)
  assert.deepEqual(expected, { action: 'ignore', repo: REPO, pr: 42, issue: null, reason: 'stack', app: 'reviewer' })
  assert.deepEqual(await swept(m.reconcile()), [expected])
})

test('reconcile: a PR whose last run is over at another head gets a review', async (t) => {
  const m = await machine(t, pr42(IMPLEMENTER_BOT, false))
  await seedState(m.state, { pr: 42, phase: 'complete' })
  assert.deepEqual(await swept(m.reconcile()), [{ action: 'review', repo: REPO, pr: 42, issue: null, reason: null, app: 'reviewer' }])
})

const marker = (kind: string, pr = 42, round = 1) => `<!-- hero-forge:handoff kind=${kind} pr=${pr} round=${round} -->`

// The open contract-implementer[bot] PR #42, at a run at its head, with these comments.
const handoffs = (...comments: Comment[]): GitHub => ({ ...pr42(IMPLEMENTER_BOT, true), comments: { 42: comments } })

const reviewPosted: Comment = { id: 3456000001, author: REVIEWER_BOT, body: marker('review-posted'), created_at: '2026-10-19T10:00:00Z' }
const recheckFailed: Comment = { id: 3456000002, author: REVIEWER_BOT, body: marker('recheck-failed', 42, 2), created_at: '2026-10-19T11:00:00Z' }
const adjudicated: Comment = { id: 3456000003, author: IMPLEMENTER_BOT, body: marker('adjudicated'), created_at: '2026-10-19T12:00:00Z' }

// The run on PR #42 began at RUN. A part that reached a phase owing a
// hand-off posted it: atPhase records that hand-off of this run in
// handoffs.json, as `review.ts handoff` does.
const RUN = '2026-10-19T09:00:00.000Z'
type Posted = { run: string; kind: string; round: number; id: number }
const owes: Record<string, (round: number) => string | undefined> = {
  'review-posted': (round) => (round === 1 ? 'review-posted' : 'recheck-failed'),
  adjudicated: () => 'adjudicated',
}

async function seedRun(state: string, over: Record<string, unknown>, posted: Posted[]): Promise<void> {
  await seedState(state, { pr: 42, head_sha: HEAD, created_at: RUN, ...over })
  await writeFile(join(state, 'pr-42', 'handoffs.json'), `${JSON.stringify(posted)}\n`)
}

// The comment id of each kind's marker above, as handoffs.json records it.
const markerId: Record<string, number> = { 'review-posted': reviewPosted.id, 'recheck-failed': recheckFailed.id, adjudicated: adjudicated.id }

// The records of these markers, as this run posted them.
const recorded = (...comments: Comment[]): Posted[] =>
  comments.map((c) => {
    const [, kind, round] = /kind=(\S+) pr=\d+ round=(\d+)/.exec(c.body) ?? []
    return { run: RUN, kind: kind ?? '', round: Number(round), id: c.id }
  })

const atPhase = (phase: string, round = 1) => async (m: { state: string }) => {
  const kind = owes[phase]?.(round)
  await seedRun(m.state, { phase, round }, kind === undefined ? [] : [{ run: RUN, kind, round, id: markerId[kind] ?? 0 }])
}

// Each case: the test name, the comments on PR #42, the run phase, the App and
// recorded event that route decides, and its decision.
const missedHandoffs: [string, Comment[], string, string, string, Partial<Decision>][] = [
  ['a review-posted hand-off', [reviewPosted], 'review-posted', 'implementer', 'issue_comment.created.review-posted.json', { action: 'adjudicate', reason: null }],
  ['a recheck-failed hand-off', [reviewPosted, recheckFailed], 'review-posted', 'implementer', 'issue_comment.created.recheck-failed.json', { action: 'adjudicate', reason: null }],
  ['an adjudicated hand-off', [reviewPosted, adjudicated], 'adjudicated', 'reviewer', 'issue_comment.created.adjudicated.json', { action: 'recheck', reason: null }],
  ['a review-posted hand-off before the run reached review-posted', [reviewPosted], 'review-dispatched', 'implementer', 'issue_comment.created.review-posted.json', { action: 'ignore', reason: 'phase' }],
  ['an adjudicated hand-off after the re-check started', [reviewPosted, adjudicated], 'rechecked', 'reviewer', 'issue_comment.created.adjudicated.json', { action: 'ignore', reason: 'phase' }],
]

for (const [name, comments, phase, app, fixture, outcome] of missedHandoffs) {
  test(`reconcile: ${name} at phase ${phase} is the decision route gives ${fixture}`, async (t) => {
    const m = await machine(t, handoffs(...comments))
    // The run is at the round of its newest marker, which it recorded with the others.
    const records = recorded(...comments)
    await seedRun(m.state, { phase, round: records.at(-1)?.round ?? 1 }, records)
    const expected = await routed(t, {}, app, fixture, atPhase(phase))
    assert.deepEqual(expected, { repo: REPO, pr: 42, issue: null, app, ...outcome })
    assert.deepEqual(await swept(m.reconcile()), [expected])
  })
}

test('reconcile: only the newest hand-off of an App counts: plain comments and text from others do not hide it', async (t) => {
  const m = await machine(
    t,
    handoffs(
      reviewPosted,
      { id: 3456000010, author: MAINTAINER, body: 'Looks fine to me.', created_at: '2026-10-19T10:30:00Z' },
      { id: 3456000011, author: 'mallory', body: marker('adjudicated'), created_at: '2026-10-19T10:40:00Z' },
      { id: 3456000012, author: REVIEWER_BOT, body: 'Round 1 is posted.', created_at: '2026-10-19T10:50:00Z' },
    ),
  )
  await atPhase('review-posted')(m)
  assert.deepEqual(await swept(m.reconcile()), [{ action: 'adjudicate', repo: REPO, pr: 42, issue: null, reason: null, app: 'implementer' }])
})

test('reconcile: a review-posted hand-off on a PR whose Adjudication is paused is the ignore (paused-run) route gives: only resume goes on', async (t) => {
  const m = await machine(t, handoffs(reviewPosted))
  await atPhase('review-posted')(m)
  await seedPause(m.state, 'pr', 42)
  const expected = await routed(t, {}, 'implementer', 'issue_comment.created.review-posted.json', async (r) => {
    await atPhase('review-posted')(r)
    await seedPause(r.state, 'pr', 42)
  })
  assert.deepEqual(expected, { action: 'ignore', repo: REPO, pr: 42, issue: null, reason: 'paused-run', app: 'implementer' })
  assert.deepEqual(await swept(m.reconcile()), [expected])
})

test('reconcile: a PR with no hand-off prints no hand-off line', async (t) => {
  const m = await machine(t, handoffs({ id: 3456000010, author: MAINTAINER, body: 'Hi', created_at: '2026-10-19T10:30:00Z' }))
  await atPhase('review-posted')(m)
  assert.deepEqual(await swept(m.reconcile()), [])
})

// A pause record, as #29 writes it when a run stops at a one-way door.
async function seedPause(state: string, kind: 'issue' | 'pr', number: number, repo = REPO): Promise<void> {
  await mkdir(join(state, 'pauses'), { recursive: true })
  await writeFile(
    join(state, 'pauses', `${kind}-${number}.json`),
    `${JSON.stringify({ repo, kind, number, reason: 'Add a column to the runs table?', paused_at: '2026-10-19T09:00:00.000Z' })}\n`,
  )
}

const answer = (id: number, author: string, at: string): Comment => ({ id, author, body: 'Add the column as nullable. No backfill.', created_at: at })

// The paused ticket #28, or the paused PR #42 by contract-implementer[bot], with these comments.
const pausedTicket = (...comments: Comment[]): GitHub => ({
  needsInfo: [{ number: 28, author: MAINTAINER, labels: ['enhancement', 'needs-info'], pull_request: false }],
  comments: { 28: comments },
})
const pausedPr = (...comments: Comment[]): GitHub => ({
  needsInfo: [{ number: 42, author: IMPLEMENTER_BOT, labels: ['needs-info'], pull_request: true }],
  comments: { 42: comments },
})

const missedAnswers: [string, GitHub, 'issue' | 'pr', number, string, Partial<Decision>][] = [
  ['the maintainer answers a paused ticket', pausedTicket(answer(3456000008, MAINTAINER, '2026-10-19T10:00:00Z')), 'issue', 28, 'issue_comment.created.resume.json', { action: 'resume', pr: null, issue: 28 }],
  ['the maintainer answers a paused PR', pausedPr(answer(3456000009, MAINTAINER, '2026-10-19T10:00:00Z')), 'pr', 42, 'issue_comment.created.resume-pr.json', { action: 'resume', pr: 42, issue: null }],
  // GitHub gives whole seconds: an answer in the second the pause began counts.
  ['the maintainer answers a paused ticket in the second the pause began', pausedTicket(answer(3456000010, MAINTAINER, '2026-10-19T09:00:00Z')), 'issue', 28, 'issue_comment.created.resume.json', { action: 'resume', pr: null, issue: 28 }],
]

for (const [name, github, kind, number, fixture, outcome] of missedAnswers) {
  test(`reconcile: ${name} is the resume route gives ${fixture}`, async (t) => {
    const m = await machine(t, github)
    await seedPause(m.state, kind, number)
    const expected = await routed(t, {}, 'implementer', fixture, (r) => seedPause(r.state, kind, number))
    assert.deepEqual(expected, { repo: REPO, reason: null, app: 'implementer', ...outcome })
    assert.deepEqual(await swept(m.reconcile()), [expected])
  })
}

test('reconcile: a paused ticket with no maintainer comment after its pause is no missed work', async (t) => {
  const m = await machine(
    t,
    pausedTicket(answer(3456000006, MAINTAINER, '2026-10-19T08:59:59Z'), answer(3456000007, 'mallory', '2026-10-19T10:00:00Z')),
  )
  await seedPause(m.state, 'issue', 28)
  assert.deepEqual(await swept(m.reconcile()), [])
})

test('reconcile: a needs-info ticket with no pause record is no missed work', async (t) => {
  const m = await machine(t, pausedTicket(answer(3456000008, MAINTAINER, '2026-10-19T10:00:00Z')))
  assert.deepEqual(await swept(m.reconcile()), [])
})

test('reconcile: a pause record for another repo is the ignore (no-pause-record) that route gives', async (t) => {
  const m = await machine(t, pausedTicket(answer(3456000008, MAINTAINER, '2026-10-19T10:00:00Z')))
  await seedPause(m.state, 'issue', 28, 'contract-hero/other')
  const expected = await routed(t, {}, 'implementer', 'issue_comment.created.resume.json', (r) => seedPause(r.state, 'issue', 28, 'contract-hero/other'))
  assert.deepEqual(expected, { action: 'ignore', repo: REPO, pr: null, issue: 28, reason: 'no-pause-record', app: 'implementer' })
  assert.deepEqual(await swept(m.reconcile()), [expected])
})

// Every kind of missed work at once: a label on ticket #28, the bot's PR #43
// with no run, a review-posted hand-off on the bot's PR #42 (its run at its
// head), and the maintainer's answer on the paused ticket #29.
const everyKind = (review = reviewMd()): GitHub => ({
  review,
  ...ticket28(),
  pulls: [
    { number: 42, author: IMPLEMENTER_BOT, draft: true, head_sha: HEAD, labels: [] },
    { number: 43, author: IMPLEMENTER_BOT, draft: true, head_sha: 'd'.repeat(40), labels: [] },
  ],
  comments: { 42: [reviewPosted], 29: [answer(3456000020, MAINTAINER, '2026-10-19T10:00:00Z')] },
  needsInfo: [{ number: 29, author: MAINTAINER, labels: ['needs-info'], pull_request: false }],
})

async function everyKindMachine(t: Setup, review?: string) {
  const m = await machine(t, everyKind(review))
  await atPhase('review-posted')(m)
  await seedPause(m.state, 'issue', 29)
  return m
}

const line = (action: string, app: string, at: { pr?: number; issue?: number }, reason: string | null = null): Decision => ({
  action,
  repo: REPO,
  pr: at.pr ?? null,
  issue: at.issue ?? null,
  reason,
  app,
})

test('reconcile: every kind of missed work starts once, in a fixed order', async (t) => {
  const m = await everyKindMachine(t)
  assert.deepEqual(await swept(m.reconcile()), [
    line('build-ticket', 'implementer', { issue: 28 }),
    line('review', 'reviewer', { pr: 43 }),
    line('adjudicate', 'implementer', { pr: 42 }),
    line('resume', 'implementer', { issue: 29 }),
  ])
})

test('reconcile: two sweeps in a row start nothing the second time, and count nothing more', async (t) => {
  const m = await everyKindMachine(t)
  const first = await swept(m.reconcile())
  assert.equal(first.filter((d) => d.action !== 'ignore').length, 4)
  const caps = async () =>
    Object.fromEntries(
      await Promise.all(
        ['reviewer-app-runs.json', 'implementer-app-runs.json', 'implementer-app-attempts.json'].map(async (f) => [f, await readFile(join(m.caps, f), 'utf8')]),
      ),
    )
  const before = await caps()
  const second = await swept(m.reconcile())
  assert.deepEqual(
    second,
    first.map((d) => ({ ...d, action: 'ignore', reason: 'duplicate' })),
  )
  assert.deepEqual(await caps(), before)
})

test('reconcile: in a paused repo every item is the ignore (paused) route gives', async (t) => {
  const m = await everyKindMachine(t, reviewMd('paused: true'))
  const expected = await routed(t, { review: reviewMd('paused: true') }, 'implementer', 'issues.labeled.json')
  assert.equal(expected.reason, 'paused')
  assert.deepEqual(await swept(m.reconcile()), [
    line('ignore', 'implementer', { issue: 28 }, 'paused'),
    line('ignore', 'reviewer', { pr: 43 }, 'paused'),
    line('ignore', 'implementer', { pr: 42 }, 'paused'),
    line('ignore', 'implementer', { issue: 29 }, 'paused'),
  ])
})

test('reconcile: an App at its daily cap is the ignore (cap) route gives, and holds no lock', async (t) => {
  const full = async (m: { caps: string }) => {
    await mkdir(m.caps, { recursive: true })
    await writeFile(join(m.caps, 'reviewer-app-runs.json'), JSON.stringify([new Date().toISOString()]))
  }
  const github = { review: reviewMd('app_daily_runs: 1'), ...pr42(MAINTAINER, false) }
  const m = await machine(t, github)
  await full(m)
  const expected = await routed(t, github, 'reviewer', 'pull_request.ready_for_review.json', full)
  assert.deepEqual(expected, { action: 'ignore', repo: REPO, pr: 42, issue: null, reason: 'cap', app: 'reviewer' })
  assert.deepEqual(await swept(m.reconcile()), [expected])
  // The cap made no record and held no lock: once the cap allows it, the same item starts.
  await m.gh.respond(responses({ ...github, review: reviewMd('app_daily_runs: 2') }))
  assert.deepEqual(await swept(m.reconcile()), [{ ...expected, action: 'review', reason: null }])
})

test('reconcile: an item that fails prints its error, and the other items still start', async (t) => {
  const m = await everyKindMachine(t)
  await m.gh.respond([{ match: `repos/${REPO}/issues/42/comments`, stderr: 'gh: Server Error (HTTP 502)\n', exit: 1 }, ...responses(everyKind())])
  const { code, stdout, stderr } = await m.reconcile()
  assert.equal(code, 1)
  // Both items of PR #42 that read its comments (the hand-off and the /recheck) fail.
  assert.equal(stderr, `review.ts reconcile: cannot list the comments of #42: gh: Server Error (HTTP 502)\n`.repeat(2))
  assert.deepEqual(stdout.split('\n').filter((l) => l !== '').map(decided), [
    line('build-ticket', 'implementer', { issue: 28 }),
    line('review', 'reviewer', { pr: 43 }),
    line('resume', 'implementer', { issue: 29 }),
  ])
})

test('reconcile: a failed blockers lookup fails that item only, with no lock and no attempt', async (t) => {
  const m = await everyKindMachine(t)
  await m.gh.respond([{ match: `repos/${REPO}/issues/28/dependencies/blocked_by`, stderr: 'gh: Server Error (HTTP 502)\n', exit: 1 }, ...responses(everyKind())])
  const { code, stdout, stderr } = await m.reconcile()
  assert.equal(code, 1)
  assert.equal(stderr, 'review.ts reconcile: cannot list the blockers of #28: gh: Server Error (HTTP 502)\n')
  // The ticket starts nothing; the other items still start.
  assert.deepEqual(stdout.split('\n').filter((l) => l !== '').map(decided), [
    line('review', 'reviewer', { pr: 43 }),
    line('adjudicate', 'implementer', { pr: 42 }),
    line('resume', 'implementer', { issue: 29 }),
  ])
  await assert.rejects(readFile(join(m.caps, 'implementer-app-attempts.json')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(m.state, 'locks', 'issue-28.lock')), { code: 'ENOENT' })
})

test('reconcile: a list that fails exits 1 and starts nothing', async (t) => {
  const m = await everyKindMachine(t)
  await m.gh.respond([{ match: 'pulls?state=open', stderr: 'gh: Bad credentials (HTTP 401)\n', exit: 1 }, ...responses(everyKind())])
  const { code, stdout, stderr } = await m.reconcile()
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, 'review.ts reconcile: cannot list the open PRs: gh: Bad credentials (HTTP 401)\n')
  await m.gh.respond(responses(everyKind()))
  assert.equal((await swept(m.reconcile())).filter((d) => d.action !== 'ignore').length, 4)
})

test('reconcile: an invalid review.md exits 4 before any item', async (t) => {
  const m = await machine(t, { ...ticket28(), review: reviewMd('paused: maybe') })
  const { code, stdout, stderr } = await m.reconcile()
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts reconcile: contract-hero\/hero-forge:docs\/agents\/review\.md:\d+: paused must be true or false/)
  assert.ok(!(await m.gh.calls()).some((c) => c.argv.join(' ').includes('labels=')))
})

test('reconcile: it lists only open issues and PRs, and reads each list once', async (t) => {
  const m = await everyKindMachine(t)
  await swept(m.reconcile())
  const lists = (await m.gh.calls()).map((c) => c.argv.at(-1) ?? '').filter((path) => /issues\?|pulls\?/.test(path))
  assert.deepEqual(lists.sort(), [
    `repos/${REPO}/issues?state=open&labels=needs-info&per_page=100`,
    `repos/${REPO}/issues?state=open&labels=ready-for-agent&per_page=100`,
    `repos/${REPO}/pulls?state=open&per_page=100`,
  ])
})

const usageErrors: [string, string[], string][] = [
  ['no --repo', [], '--repo must be OWNER/REPO'],
  ['a --repo that is not OWNER/REPO', ['--repo', 'hero-forge'], '--repo must be OWNER/REPO'],
]

for (const [name, args, message] of usageErrors) {
  test(`reconcile: ${name} is a usage error`, async () => {
    const { code, stdout, stderr } = await runCli(['reconcile', ...args])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(stderr.split('\n')[0], `review.ts reconcile: ${message}`)
  })
}

test('reconcile: a ticket at its attempt cap is the ignore (attempts) route gives, and counts no run', async (t) => {
  const used = async (m: { caps: string }) => {
    await mkdir(m.caps, { recursive: true })
    await writeFile(join(m.caps, 'implementer-app-attempts.json'), JSON.stringify({ [`${REPO}#28`]: 1 }))
  }
  const github = { ...ticket28(), review: reviewMd('  attempts: 1') }
  const m = await machine(t, github)
  await used(m)
  const expected = await routed(t, github, 'implementer', 'issues.labeled.json', used)
  assert.deepEqual(expected, { action: 'ignore', repo: REPO, pr: null, issue: 28, reason: 'attempts', app: 'implementer' })
  assert.deepEqual(await swept(m.reconcile()), [expected])
  await assert.rejects(readFile(join(m.caps, 'implementer-app-runs.json')), { code: 'ENOENT' })
})

// --- Review round 1 ------------------------------------------------------------

// Ticket #28 still has ready-for-agent, and its build paused with needs-info.
const pausedBuild = (...comments: Comment[]): GitHub => ({
  ...ticket28(),
  labelled: [{ number: 28, author: MAINTAINER, labels: ['enhancement', 'ready-for-agent', 'needs-info'], pull_request: false }],
  needsInfo: [{ number: 28, author: MAINTAINER, labels: ['enhancement', 'ready-for-agent', 'needs-info'], pull_request: false }],
  comments: { 28: comments },
})

test('reconcile: a labelled ticket whose build paused and has no answer prints no line: no build, no attempt', async (t) => {
  const m = await machine(t, pausedBuild(answer(3456000006, MAINTAINER, '2026-10-19T08:00:00Z')))
  await seedPause(m.state, 'issue', 28)
  assert.deepEqual(await swept(m.reconcile()), [])
  await assert.rejects(readFile(join(m.caps, 'implementer-app-attempts.json')), { code: 'ENOENT' })
})

test('reconcile: a labelled ticket whose build paused and has an answer is resume, not a build', async (t) => {
  const m = await machine(t, pausedBuild(answer(3456000008, MAINTAINER, '2026-10-19T10:00:00Z')))
  await seedPause(m.state, 'issue', 28)
  assert.deepEqual(await swept(m.reconcile()), [line('resume', 'implementer', { issue: 28 })])
  await assert.rejects(readFile(join(m.caps, 'implementer-app-attempts.json')), { code: 'ENOENT' })
})

test('reconcile: a pause record of another repo does not stop the build of a labelled ticket', async (t) => {
  const m = await machine(t, ticket28())
  await seedPause(m.state, 'issue', 28, 'contract-hero/other')
  assert.deepEqual(await swept(m.reconcile()), [line('build-ticket', 'implementer', { issue: 28 })])
})

test('reconcile: a ticket that an open issue of this repo blocks is ignore (blocked), takes no lock and no attempt, and builds once the blocker closes', async (t) => {
  const blocked = (state: 'open' | 'closed'): GitHub => ({ ...ticket28(), blockers: { 28: [{ number: 27, state, repo: REPO }, { number: 9, state: 'open', repo: 'contract-hero/other' }] } })
  const m = await machine(t, blocked('open'))
  assert.deepEqual(await swept(m.reconcile()), [line('ignore', 'implementer', { issue: 28 }, 'blocked')])
  await assert.rejects(readFile(join(m.caps, 'implementer-app-attempts.json')), { code: 'ENOENT' })
  await assert.rejects(readdir(join(m.state, 'locks')), { code: 'ENOENT' })
  await m.gh.respond(responses(blocked('closed')))
  assert.deepEqual(await swept(m.reconcile()), [line('build-ticket', 'implementer', { issue: 28 })])
})

test('reconcile: a spec that an open issue blocks is still build-spec: only a single ticket is checked', async (t) => {
  const m = await machine(t, spec23({ blockers: { 23: [{ number: 20, state: 'open', repo: REPO }] } }))
  assert.deepEqual(await swept(m.reconcile()), [{ action: 'build-spec', repo: REPO, pr: null, issue: 23, reason: null, app: 'implementer' }])
})

test('reconcile: blocked comes after paused, duplicate and has-pr, and before the sender rule', async (t) => {
  const blockers = { 28: [{ number: 27, state: 'open' as const, repo: REPO }] }
  const paused = await machine(t, { ...ticket28(), blockers, review: reviewMd('paused: true') })
  assert.deepEqual((await swept(paused.reconcile()))[0], line('ignore', 'implementer', { issue: 28 }, 'paused'))
  const withPr = await machine(t, { ...ticket28(), ...pr50(IMPLEMENTER_BOT, 28), blockers })
  assert.deepEqual((await swept(withPr.reconcile()))[0], line('ignore', 'implementer', { issue: 28 }, 'has-pr'))
  // A ready-for-agent label that a stranger added last is still blocked first.
  const stranger = await machine(t, { ...ticket28('mallory'), blockers })
  assert.deepEqual((await swept(stranger.reconcile()))[0], line('ignore', 'implementer', { issue: 28 }, 'blocked'))
})

test('reconcile: has-pr comes after paused and duplicate, as route orders its rules', async (t) => {
  const paused = await machine(t, { ...ticket28(), ...pr50(IMPLEMENTER_BOT, 28), review: reviewMd('paused: true') })
  assert.deepEqual((await swept(paused.reconcile()))[0], line('ignore', 'implementer', { issue: 28 }, 'paused'))
  // A build that started from this item before its PR opened is a duplicate.
  const started = await machine(t, ticket28())
  assert.deepEqual((await swept(started.reconcile()))[0], line('build-ticket', 'implementer', { issue: 28 }))
  await started.gh.respond(responses({ ...ticket28(), ...pr50(IMPLEMENTER_BOT, 28) }))
  assert.deepEqual((await swept(started.reconcile()))[0], line('ignore', 'implementer', { issue: 28 }, 'duplicate'))
})

// The maintainer's PR #42 of issue_comment.created.recheck.json, its run at
// its head, with these comments.
const ownPr = (...comments: Comment[]): GitHub => ({ ...pr42(MAINTAINER, false), comments: { 42: comments } })
const recheck = (id: number, at: string, body = '/recheck'): Comment => ({ id, author: MAINTAINER, body, created_at: at })

test('reconcile: a missed /recheck on a maintainer PR at adjudicated is the recheck route gives', async (t) => {
  const github = ownPr(reviewPosted, recheck(3456000004, '2026-10-19T12:00:00Z'))
  const m = await machine(t, github)
  await seedRun(m.state, { phase: 'adjudicated' }, recorded(reviewPosted))
  const expected = await routed(t, {}, 'reviewer', 'issue_comment.created.recheck.json', atPhase('adjudicated'))
  assert.deepEqual(expected, { action: 'recheck', repo: REPO, pr: 42, issue: null, reason: null, app: 'reviewer' })
  const lines = await swept(m.reconcile())
  // The review-posted hand-off on the maintainer's PR is route's ignore (author), for the Implementer.
  assert.deepEqual(lines, [line('ignore', 'implementer', { pr: 42 }, 'author'), expected])
})

test('reconcile: only a /recheck newer than the last review hand-off counts, and only as the whole first line', async (t) => {
  const m = await machine(
    t,
    ownPr(
      recheck(3456000004, '2026-10-19T09:00:00Z'),
      { ...reviewPosted, created_at: '2026-10-19T10:00:00Z' },
      recheck(3456000005, '2026-10-19T11:00:00Z', '/recheck please'),
      { ...recheck(3456000006, '2026-10-19T11:30:00Z'), author: 'mallory' },
    ),
  )
  await seedRun(m.state, { phase: 'adjudicated' }, recorded(reviewPosted))
  assert.deepEqual(await swept(m.reconcile()), [line('ignore', 'implementer', { pr: 42 }, 'author')])
})

// --- A hand-off lost between advance and post ------------------------------

// The bot's PR #42 with the markers of the hand-offs that did land.
const landed = (...comments: Comment[]): GitHub => handoffs(...comments)
const posted = (kind: string, round = 1, run = RUN): Posted => ({ run, kind, round, id: markerId[kind] ?? 0 })

// Each case: the test name, the run, the hand-offs it posted (comments and
// records), the marker item's ignore (the newest marker is for an earlier
// step), and the part that starts again.
const lostHandoffs: [string, { phase: string; round: number }, Comment[], Posted[], Decision[], Decision][] = [
  ['a review-posted hand-off in round 1', { phase: 'review-posted', round: 1 }, [], [], [], line('review', 'reviewer', { pr: 42 })],
  [
    'an adjudicated hand-off',
    { phase: 'adjudicated', round: 1 },
    [reviewPosted],
    [posted('review-posted')],
    [line('ignore', 'implementer', { pr: 42 }, 'phase')],
    line('adjudicate', 'implementer', { pr: 42 }),
  ],
  [
    'a recheck-failed hand-off in round 2',
    { phase: 'review-posted', round: 2 },
    [reviewPosted, adjudicated],
    [posted('review-posted'), posted('adjudicated')],
    // The newest marker is round 1's: it hands off nothing of round 2.
    [],
    line('recheck', 'reviewer', { pr: 42 }),
  ],
]

for (const [name, run, comments, records, before, relaunched] of lostHandoffs) {
  test(`reconcile: ${name} that never landed, with no lock held, starts its part again once`, async (t) => {
    const m = await machine(t, landed(...comments))
    await seedRun(m.state, run, records)
    assert.deepEqual(await swept(m.reconcile()), [...before, relaunched])
    // The part holds the PR lock it took, and its delivery is done.
    await assert.doesNotReject(readFile(join(m.state, 'locks', 'pr-42.lock')))
    assert.deepEqual(await swept(m.reconcile()), [...before, { ...relaunched, action: 'ignore', reason: 'duplicate' }])
    // Once the part posted its hand-off, the run owes none: no line.
    const kind = owes[run.phase]?.(run.round) ?? ''
    await writeFile(join(m.state, 'pr-42', 'handoffs.json'), `${JSON.stringify([...records, posted(kind, run.round)])}\n`)
    assert.deepEqual(await swept(m.reconcile()), before)
  })
}

test('reconcile: a hand-off recorded by an earlier run of the PR does not count for this run', async (t) => {
  const m = await machine(t, landed())
  await seedRun(m.state, { phase: 'review-posted' }, [posted('review-posted', 1, '2026-10-01T09:00:00.000Z')])
  assert.deepEqual(await swept(m.reconcile()), [line('review', 'reviewer', { pr: 42 })])
})

test('reconcile: a new run at the same head is a new item, not a duplicate of the last run', async (t) => {
  const m = await machine(t, landed())
  await seedRun(m.state, { phase: 'review-posted', created_at: '2026-10-01T09:00:00.000Z' }, [])
  assert.deepEqual(await swept(m.reconcile()), [line('review', 'reviewer', { pr: 42 })])
  await rm(join(m.state, 'locks'), { recursive: true })
  await seedRun(m.state, { phase: 'review-posted' }, [])
  assert.deepEqual(await swept(m.reconcile()), [line('review', 'reviewer', { pr: 42 })])
})

test('reconcile: a lost hand-off whose PR lock is held is the ignore (locked), and starts on the next sweep', async (t) => {
  const m = await machine(t, landed())
  await seedRun(m.state, { phase: 'review-posted' }, [])
  const lock = join(m.state, 'locks', 'pr-42.lock')
  await mkdir(dirname(lock), { recursive: true })
  assert.notEqual(await takeLock(lock, 60 * 60 * 1000, { app: 'reviewer', delivery: 'still-running' }), null)
  assert.deepEqual(await swept(m.reconcile()), [line('ignore', 'reviewer', { pr: 42 }, 'locked')])
  await rm(lock)
  assert.deepEqual(await swept(m.reconcile()), [line('review', 'reviewer', { pr: 42 })])
})

test('reconcile: no hand-off is due for a zero-finding round, a run at another head, a stack, or a maintainer PR', async (t) => {
  const zero = await machine(t, landed())
  await seedRun(zero.state, { phase: 'adjudicated', gates: [{ round: 1, commit: HEAD, result: 'pass' }] }, [])
  assert.deepEqual(await swept(zero.reconcile()), [])
  // The PR head moved: the review of the new head is pull's item (locked by the run), no relaunch.
  const moved = await machine(t, landed())
  await seedRun(moved.state, { phase: 'review-posted', head_sha: 'e'.repeat(40) }, [])
  assert.deepEqual(await swept(moved.reconcile()), [line('ignore', 'reviewer', { pr: 42 }, 'locked')])
  const layer = await machine(t, landed())
  await seedRun(layer.state, { phase: 'review-posted', mode: 'layer' }, [])
  assert.deepEqual(await swept(layer.reconcile()), [])
  // A maintainer PR: its hand-off would start no part, so none is due.
  const own = await machine(t, pr42(MAINTAINER, false))
  await seedRun(own.state, { phase: 'adjudicated' }, [])
  assert.deepEqual(await swept(own.reconcile()), [])
})

test('reconcile: a lost hand-off of an App that is off is the ignore (disabled), and takes no lock', async (t) => {
  const m = await machine(t, { ...landed(reviewPosted), review: '# Review pipeline\n\n```yaml\nruntime: codex\napp: enabled\n```\n' })
  await seedRun(m.state, { phase: 'adjudicated' }, [posted('review-posted')])
  assert.deepEqual(await swept(m.reconcile()), [
    line('ignore', 'implementer', { pr: 42 }, 'disabled'),
    line('ignore', 'implementer', { pr: 42 }, 'disabled'),
  ])
  await assert.rejects(readFile(join(m.state, 'locks', 'pr-42.lock')), { code: 'ENOENT' })
})

test('reconcile: a relaunch whose part gave up its lock with the hand-off still lost starts again on the next sweep', async (t) => {
  const m = await machine(t, landed())
  await seedRun(m.state, { phase: 'review-posted' }, [])
  assert.deepEqual(await swept(m.reconcile()), [line('review', 'reviewer', { pr: 42 })])
  // The part released its lock, then died before its hand-off landed.
  await rm(join(m.state, 'locks', 'pr-42.lock'))
  assert.deepEqual(await swept(m.reconcile()), [line('review', 'reviewer', { pr: 42 })])
  // The part died holding its lock: once the lock expires, the next sweep starts it again.
  const lock = join(m.state, 'locks', 'pr-42.lock')
  await utimes(lock, new Date(0), new Date(0))
  assert.deepEqual(await swept(m.reconcile()), [line('review', 'reviewer', { pr: 42 })])
})

test('reconcile: a sweep forgets a stale relaunch record only under the PR lock guard, so it keeps the record of an overlapping relaunch', async (t) => {
  const m = await machine(t, landed())
  await seedRun(m.state, { phase: 'review-posted' }, [])
  assert.deepEqual(await swept(m.reconcile()), [line('review', 'reviewer', { pr: 42 })])
  const lock = join(m.state, 'locks', 'pr-42.lock')
  const stale = (JSON.parse(await readFile(lock, 'utf8')) as { token: string }).token
  const dir = join(m.state, 'deliveries', 'reviewer')
  const recordOf = async (token: string) => {
    for (const name of await readdir(dir)) {
      const file = join(dir, name)
      if ((JSON.parse(await readFile(file, 'utf8')) as { token?: unknown }).token === token) return file
    }
    return null
  }
  const file = await recordOf(stale)
  assert.notEqual(file, null)
  // The part released its lock with the hand-off still lost. An overlapping
  // relaunch holds the guard while it takes the lock: this sweep waits.
  await rm(lock)
  await writeFile(`${lock}.guard`, `${JSON.stringify({ token: 'overlapping', pid: process.pid })}\n`)
  const sweep = swept(m.reconcile())
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.equal(await recordOf(stale), file)
  // The overlapping relaunch takes the lock and writes its record, then frees the guard.
  const fresh = 'a'.repeat(32)
  await writeFile(lock, `${JSON.stringify({ pr: 42, token: fresh, taken_at: new Date().toISOString() })}\n`)
  await writeFile(file as string, `${JSON.stringify({ state: 'done', pr: 42, token: fresh })}\n`)
  await rm(`${lock}.guard`)
  assert.deepEqual(await sweep, [line('ignore', 'reviewer', { pr: 42 }, 'duplicate')])
  // The record of the relaunch stays, so `route undo` can find its token.
  assert.equal(await recordOf(fresh), file)
})

test('reconcile: a hand-off marker of an earlier run does not hand off the run at the head', async (t) => {
  // An aborted run posted its review-posted marker (with no reconcile record);
  // the new run reached review-posted in round 1 and lost its own hand-off.
  const m = await machine(t, landed(reviewPosted))
  await seedRun(m.state, { phase: 'review-posted', created_at: '2026-10-19T10:30:00.000Z' }, [posted('review-posted')])
  assert.deepEqual(await swept(m.reconcile()), [line('review', 'reviewer', { pr: 42 })])
})

test('reconcile: a marker of an earlier run posted in the second this run began does not hand off this run', async (t) => {
  const m = await machine(t, landed({ ...reviewPosted, created_at: '2026-10-19T10:30:00Z' }))
  await seedRun(m.state, { phase: 'review-posted', created_at: '2026-10-19T10:30:00.900Z' }, [posted('review-posted', 1, '2026-10-19T09:00:00.000Z')])
  assert.deepEqual(await swept(m.reconcile()), [line('review', 'reviewer', { pr: 42 })])
})

test('reconcile: a marker of an earlier round of this run does not hand off the round the run is at', async (t) => {
  // Round 2 lost its recheck-failed hand-off, and round 1's review-posted marker is the newest on the PR.
  const m = await machine(t, landed(reviewPosted))
  await seedRun(m.state, { phase: 'review-posted', round: 2 }, [posted('review-posted'), posted('adjudicated')])
  assert.deepEqual(await swept(m.reconcile()), [line('recheck', 'reviewer', { pr: 42 })])
})
