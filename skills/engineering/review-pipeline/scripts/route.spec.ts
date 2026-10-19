// `review.ts route`: recorded GitHub webhook payloads in, one decision out.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeGh, runCli, seedState, tempDir, type FakeGhResponse } from './test-helpers.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'route')
const REPO = 'contract-hero/hero-forge'
const MAINTAINER = 'alilloig'

// A review.md on the default branch, with the given lines in its YAML block.
function reviewMd(...yaml: string[]): string {
  return `# Review pipeline\n\n\`\`\`yaml\n${['runtime: codex', 'app: enabled', ...yaml].join('\n')}\n\`\`\`\n`
}

// The same, with the Implementer App switched on.
const implementerMd = (...yaml: string[]) => reviewMd('implementer:', '  app: enabled', ...yaml)

// The repo's default branch: its review.md (null: the file is not there), and
// what GitHub says of the labelled issue: whether it has a parent, how many
// sub-issues it has, and who wrote each sub-issue (by default the maintainer,
// numbered from 24).
type Sub = { number: number; author: string }
type Remote = { review: string | null; issue?: { parent: boolean; subIssues: number; subs?: Sub[] } }

const TICKET = { parent: false, subIssues: 0 }
const SPEC = { parent: false, subIssues: 9 }
const CHILD = { parent: true, subIssues: 0 }

function responses({ review, issue = TICKET }: Remote): FakeGhResponse[] {
  return [
    review === null
      ? { match: 'contents/docs/agents/review.md', stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)\n', exit: 1 }
      : { match: 'contents/docs/agents/review.md', stdout: review },
    { match: 'api user', stdout: `${MAINTAINER}\n` },
    {
      match: '/sub_issues',
      stdout: (issue.subs ?? Array.from({ length: issue.subIssues }, (_, i) => ({ number: 24 + i, author: MAINTAINER })))
        .map((sub) => `${JSON.stringify(sub)}\n`)
        .join(''),
    },
    {
      match: `repos/${REPO}/issues/`,
      stdout: `${JSON.stringify({
        parent_issue_url: issue.parent ? `https://api.github.com/repos/${REPO}/issues/23` : null,
        sub_issues_summary: { total: issue.subIssues, completed: 0, percent_completed: 0 },
      })}\n`,
    },
  ]
}

type App = 'reviewer' | 'implementer'

// A router with its own run-state dir, cap dir and fake gh.
// `caps` shares one cap dir between routers (two repos on one machine).
async function router(t: Parameters<typeof tempDir>[0], remote: Remote = { review: reviewMd() }, shared?: { caps: string }) {
  const dir = await tempDir(t)
  const state = join(dir, 'state')
  const caps = shared?.caps ?? join(dir, 'caps')
  const gh = await fakeGh(dir, responses(remote))
  const env = { ...gh.env, HERO_FORGE_STATE_DIR: state, HERO_FORGE_CAP_DIR: caps }
  // `file` is the payload; `fixture` names its event: the name up to the first dot.
  const call = (app: App, fixture: string, file: string, delivery: string) =>
    runCli(['route', '--app', app, '--event', fixture.split('.')[0] ?? '', '--delivery', delivery, '--payload', file], { env })
  return {
    dir,
    state,
    caps,
    gh,
    env,
    // `fixture` is a file in fixtures/route/.
    route: (fixture: string, delivery: string, app: App = 'reviewer') => call(app, fixture, join(FIXTURES, fixture), delivery),
    // A recorded payload with `change` applied, for another PR, repo or body.
    routeChanged: async (fixture: string, delivery: string, change: (payload: Payload) => void, app: App = 'reviewer') => {
      const payload = JSON.parse(await readFile(join(FIXTURES, fixture), 'utf8')) as Payload
      change(payload)
      const file = join(dir, `payload-${delivery}.json`)
      await writeFile(file, JSON.stringify(payload))
      return call(app, fixture, file, delivery)
    },
  }
}

type Payload = {
  number: number
  pull_request: { number: number }
  repository: { full_name: string }
  issue: { number: number; user: { login: string }; labels: { name: string }[]; pull_request?: unknown }
  comment: { body: string }
  label: { name: string }
}

const prNumber = (n: number) => (payload: Payload) => {
  payload.number = n
  payload.pull_request.number = n
}

const issueNumber = (n: number) => (payload: Payload) => {
  payload.issue.number = n
}

const commentBody = (body: string) => (payload: Payload) => {
  payload.comment.body = body
}

type Action = 'review' | 'recheck' | 'build-ticket' | 'build-spec' | 'adjudicate' | 'resume' | 'ignore'
type Decision = { action: Action; repo: string | null; pr: number | null; issue: number | null; reason: string | null }

const review = (pr = 42): Decision => ({ action: 'review', repo: REPO, pr, issue: null, reason: null })
const ignore = (reason: string, pr: number | null = 42): Decision => ({ action: 'ignore', repo: REPO, pr, issue: null, reason })
// A decision on PR #42.
const onPr = (action: Action, reason: string | null = null, pr = 42): Decision => ({ action, repo: REPO, pr, issue: null, reason })
// A decision on issue #28 (a ticket, not a PR).
const onIssue = (action: Action, reason: string | null = null, issue = 28): Decision => ({ action, repo: REPO, pr: null, issue, reason })

// Each case: the test name, the recorded payload, the default branch, and the
// decision a fresh router prints for it.
const cases: [string, string, Remote, Decision][] = [
  ['a draft PR opened by the maintainer', 'pull_request.opened.draft.json', { review: reviewMd() }, ignore('action:opened')],
  ['a PR opened by the maintainer, not a draft', 'pull_request.opened.json', { review: reviewMd() }, review()],
  ['a maintainer PR marked ready for review', 'pull_request.ready_for_review.json', { review: reviewMd() }, review()],
  ['a maintainer PR reopened, not a draft', 'pull_request.reopened.maintainer.json', { review: reviewMd() }, review()],
  ['a maintainer draft PR reopened', 'pull_request.reopened.maintainer.draft.json', { review: reviewMd() }, ignore('action:reopened')],
  ['a draft PR opened by contract-implementer[bot]', 'pull_request.opened.implementer.json', { review: reviewMd() }, review()],
  ['a PR by contract-implementer[bot] reopened', 'pull_request.reopened.json', { review: reviewMd() }, review()],
  [
    'a contract-implementer[bot] PR marked ready for review',
    'pull_request.ready_for_review.implementer.json',
    { review: reviewMd() },
    ignore('action:ready_for_review'),
  ],
  ['a push to a pull request (synchronize)', 'pull_request.synchronize.json', { review: reviewMd() }, ignore('action:synchronize')],
  ['a merged PR (closed)', 'pull_request.closed.json', { review: reviewMd() }, ignore('action:closed')],
  ['a push event', 'push.json', { review: reviewMd() }, ignore('event:push', null)],
  ['a PR by another author', 'pull_request.opened.stranger.json', { review: reviewMd() }, ignore('author')],
  ['a PR in a repo with no docs/agents/review.md', 'pull_request.opened.json', { review: null }, ignore('no-config')],
  ['a PR opened in a paused repo', 'pull_request.opened.json', { review: reviewMd('paused: true') }, ignore('paused')],
  ['a synchronize in a paused repo', 'pull_request.synchronize.json', { review: reviewMd('paused: true') }, ignore('paused')],
  ['a push in a paused repo', 'push.json', { review: reviewMd('paused: true') }, ignore('paused', null)],
  ['a PR opened with paused: false', 'pull_request.opened.json', { review: reviewMd('paused: false') }, review()],
]

for (const [name, fixture, remote, expected] of cases) {
  test(`route: ${name} is ${expected.action}${expected.reason === null ? '' : ` (${expected.reason})`}`, async (t) => {
    const r = await router(t, remote)
    const { code, stdout, stderr } = await r.route(fixture, '6f1e2d3c-0000-11f0-8a1b-0123456789ab')
    assert.equal(stderr, '')
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), expected)
  })
}

// Delivery ids, as GitHub sends them in X-GitHub-Delivery.
const D1 = '11111111-aaaa-11f0-8a1b-0123456789ab'
const D2 = '22222222-bbbb-11f0-8a1b-0123456789ab'
const D3 = '33333333-cccc-11f0-8a1b-0123456789ab'

async function decision(result: Promise<{ code: number | null; stdout: string; stderr: string }>): Promise<Decision> {
  const { code, stdout, stderr } = await result
  assert.equal(stderr, '')
  assert.equal(code, 0)
  return JSON.parse(stdout) as Decision
}

test('route: a second event for a PR whose lock is held is ignore (locked)', async (t) => {
  const r = await router(t)
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), review())
  assert.deepEqual(await decision(r.route('pull_request.ready_for_review.json', D2)), ignore('locked'))
})

test('route: two route calls at once for one PR give one review', async (t) => {
  const r = await router(t)
  const both = await Promise.all([r.route('pull_request.opened.json', D1), r.route('pull_request.ready_for_review.json', D2)].map(decision))
  assert.deepEqual(both.map((d) => d.reason).sort(), [null, 'locked'].sort())
})

test('route: a lock older than its TTL is free again', async (t) => {
  const r = await router(t)
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), review())
  const old = new Date(Date.now() - (3 * 60 + 1) * 60 * 1000)
  await utimes(join(r.state, 'locks', 'pr-42.lock'), old, old)
  assert.deepEqual(await decision(r.route('pull_request.ready_for_review.json', D2)), review())
  assert.deepEqual(await decision(r.route('pull_request.reopened.json', D3)), ignore('locked'))
})

test('route: a PR with a run state that is not terminal is ignore (locked)', async (t) => {
  const r = await router(t)
  await seedState(r.state, { pr: 42, phase: 'review-posted' })
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), ignore('locked'))
})

test('route: a PR whose last run is terminal gets a review', async (t) => {
  const r = await router(t)
  await seedState(r.state, { pr: 42, phase: 'complete' })
  assert.deepEqual(await decision(r.route('pull_request.reopened.json', D1)), review())
})

test('route: a corrupt run state exits 4', async (t) => {
  const r = await router(t)
  await mkdir(join(r.state, 'pr-42'), { recursive: true })
  await writeFile(join(r.state, 'pr-42', 'state.json'), '{ not json')
  const { code, stdout, stderr } = await r.route('pull_request.opened.json', D1)
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts route: corrupt state file .*pr-42\/state\.json/)
})

test('route: a repeat delivery id is ignore (duplicate), before the lock rule', async (t) => {
  const r = await router(t)
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), review())
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), ignore('duplicate'))
})

test('route: a delivery that was ignored is not a duplicate when GitHub sends it again', async (t) => {
  const r = await router(t, { review: reviewMd('paused: true') })
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), ignore('paused'))
  await r.gh.respond(responses({ review: reviewMd() }))
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), review())
})

test('route: paused comes before duplicate', async (t) => {
  const r = await router(t)
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), review())
  await r.gh.respond(responses({ review: reviewMd('paused: true') }))
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), ignore('paused'))
})

const D4 = '44444444-dddd-11f0-8a1b-0123456789ab'

test('route: once the daily cap is reached, events are ignore (cap), and a cap ignore holds no lock', async (t) => {
  const r = await router(t, { review: reviewMd('app_daily_runs: 2') })
  assert.deepEqual(await decision(r.routeChanged('pull_request.opened.json', D1, prNumber(42))), review(42))
  assert.deepEqual(await decision(r.routeChanged('pull_request.opened.json', D2, prNumber(43))), review(43))
  assert.deepEqual(await decision(r.routeChanged('pull_request.opened.json', D3, prNumber(44))), ignore('cap', 44))
  await r.gh.respond(responses({ review: reviewMd('app_daily_runs: 3') }))
  assert.deepEqual(await decision(r.routeChanged('pull_request.opened.json', D3, prNumber(44))), review(44))
})

test('route: a held lock is reported before the cap', async (t) => {
  const r = await router(t, { review: reviewMd('app_daily_runs: 1') })
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), review())
  assert.deepEqual(await decision(r.route('pull_request.ready_for_review.json', D2)), ignore('locked'))
})

test('route: the daily cap counts the runs of every repo on the machine', async (t) => {
  const a = await router(t, { review: reviewMd('app_daily_runs: 1') })
  const b = await router(t, { review: reviewMd('app_daily_runs: 1') }, { caps: a.caps })
  assert.deepEqual(await decision(a.route('pull_request.opened.json', D1)), review())
  const other = await decision(
    b.routeChanged('pull_request.opened.json', D2, (p) => {
      p.repository.full_name = 'contract-hero/other'
    }),
  )
  assert.deepEqual(other, { action: 'ignore', repo: 'contract-hero/other', pr: 42, issue: null, reason: 'cap' })
})

test('route: the daily cap counts the runs of the last 24 hours only', async (t) => {
  const r = await router(t, { review: reviewMd('app_daily_runs: 2') })
  const hours = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString()
  await mkdir(r.caps, { recursive: true })
  await writeFile(join(r.caps, 'reviewer-app-runs.json'), JSON.stringify([hours(30), hours(25), hours(1)]))
  assert.deepEqual(await decision(r.routeChanged('pull_request.opened.json', D1, prNumber(42))), review(42))
  assert.deepEqual(await decision(r.routeChanged('pull_request.opened.json', D2, prNumber(43))), ignore('cap', 43))
})

test('route: with no app_daily_runs the cap is 20 runs', async (t) => {
  const r = await router(t)
  const hours = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString()
  await mkdir(r.caps, { recursive: true })
  await writeFile(join(r.caps, 'reviewer-app-runs.json'), JSON.stringify(Array.from({ length: 19 }, () => hours(2))))
  assert.deepEqual(await decision(r.routeChanged('pull_request.opened.json', D1, prNumber(42))), review(42))
  assert.deepEqual(await decision(r.routeChanged('pull_request.opened.json', D2, prNumber(43))), ignore('cap', 43))
})

test('route: a corrupt cap file exits 4', async (t) => {
  const r = await router(t)
  await mkdir(r.caps, { recursive: true })
  await writeFile(join(r.caps, 'reviewer-app-runs.json'), '{ not a list')
  const { code, stdout, stderr } = await r.route('pull_request.opened.json', D4)
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts route: corrupt run cap file .*reviewer-app-runs\.json/)
  // The failed call gave its PR lock back.
  await rm(join(r.caps, 'reviewer-app-runs.json'))
  assert.deepEqual(await decision(r.route('pull_request.ready_for_review.json', D1)), review())
})

test('route: two route calls at once for two PRs, one run under the cap, give one review', async (t) => {
  const r = await router(t, { review: reviewMd('app_daily_runs: 1') })
  const both = await Promise.all(
    [r.routeChanged('pull_request.opened.json', D1, prNumber(42)), r.routeChanged('pull_request.opened.json', D2, prNumber(43))].map(decision),
  )
  assert.deepEqual(both.map((d) => d.reason).sort(), [null, 'cap'].sort())
  const runs = JSON.parse(await readFile(join(r.caps, 'reviewer-app-runs.json'), 'utf8'))
  assert.equal(runs.length, 1)
})

test('route: it reads review.md from the default branch through gh, and asks for the maintainer only at the author rule', async (t) => {
  const r = await router(t)
  await decision(r.route('push.json', D1))
  assert.deepEqual(
    (await r.gh.calls()).map((c) => c.argv),
    [['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${REPO}/contents/docs/agents/review.md?ref=main`]],
  )
  await decision(r.route('pull_request.opened.json', D2))
  assert.deepEqual((await r.gh.calls()).slice(1).map((c) => c.argv[1]), ['-H', 'user'])
  // The bot's PR needs no maintainer lookup.
  await decision(r.route('pull_request.reopened.json', D3))
  assert.deepEqual((await r.gh.calls()).slice(3).map((c) => c.argv[1]), ['-H'])
})

test('route: an invalid review.md on the default branch exits 4 with its line', async (t) => {
  const r = await router(t, { review: reviewMd('paused: maybe') })
  const { code, stdout, stderr } = await r.route('pull_request.opened.json', D1)
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.equal(
    stderr,
    `review.ts route: ${REPO}:docs/agents/review.md:6: paused must be true or false, got "maybe". Edit the file or re-run /setup-forge.\n`,
  )
})

test('route: a gh failure other than a missing file exits 1', async (t) => {
  const r = await router(t)
  await r.gh.respond([{ match: 'contents/docs/agents/review.md', stderr: 'gh: Bad credentials (HTTP 401)\n', exit: 1 }])
  const { code, stdout, stderr } = await r.route('pull_request.opened.json', D1)
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, `review.ts route: cannot read docs/agents/review.md of ${REPO}: gh: Bad credentials (HTTP 401)\n`)
})

test('route: a payload that is not JSON exits 1', async (t) => {
  const r = await router(t)
  const file = join(r.dir, 'bad.json')
  await writeFile(file, 'not json')
  const { code, stderr } = await runCli(['route', '--app', 'reviewer', '--event', 'pull_request', '--delivery', D1, '--payload', file], {
    env: { ...r.gh.env, HERO_FORGE_STATE_DIR: r.state, HERO_FORGE_CAP_DIR: r.caps },
  })
  assert.equal(code, 1)
  assert.equal(stderr, `review.ts route: the payload ${file} is not JSON\n`)
})

const usageErrors: [string, string[], string][] = [
  ['an App other than reviewer or implementer', ['--app', 'tester', '--event', 'pull_request', '--delivery', D1, '--payload', 'p.json'], '--app must be reviewer or implementer'],
  ['no --app', ['--event', 'pull_request', '--delivery', D1, '--payload', 'p.json'], '--app must be reviewer or implementer'],
  ['no --event', ['--app', 'reviewer', '--delivery', D1, '--payload', 'p.json'], '--event must be the X-GitHub-Event name, such as pull_request'],
  ['a delivery id with a slash', ['--app', 'reviewer', '--event', 'pull_request', '--delivery', '../x', '--payload', 'p.json'], '--delivery must be the X-GitHub-Delivery id'],
  ['no --payload', ['--app', 'reviewer', '--event', 'pull_request', '--delivery', D1], 'route needs --payload'],
]

for (const [name, args, message] of usageErrors) {
  test(`route: ${name} is a usage error`, async () => {
    const { code, stdout, stderr } = await runCli(['route', ...args])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(stderr.split('\n')[0], `review.ts route: ${message}`)
  })
}

test('route: a delivery that fails to record counts no run, so a redelivery under app_daily_runs: 1 is review', async (t) => {
  const r = await router(t, { review: reviewMd('app_daily_runs: 1') })
  await mkdir(r.state, { recursive: true })
  // A file where the deliveries dir should be: recording the delivery fails.
  await writeFile(join(r.state, 'deliveries'), '')
  const failed = await r.route('pull_request.opened.json', D1)
  assert.equal(failed.code, 1)
  assert.equal(failed.stdout, '')
  await rm(join(r.state, 'deliveries'))
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), review())
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), ignore('duplicate'))
})

test('route: a breaker left over from a crash exits 1 with its path, and deletes nothing', async (t) => {
  const r = await router(t)
  const lock = join(r.state, 'locks', 'pr-42.lock')
  await mkdir(join(r.state, 'locks'), { recursive: true })
  const old = new Date(Date.now() - 2 * 60 * 1000)
  await writeFile(`${lock}.guard`, `${JSON.stringify({ token: 'crashed' })}\n`)
  await writeFile(`${lock}.guard.break`, '')
  await utimes(`${lock}.guard`, old, old)
  await utimes(`${lock}.guard.break`, old, old)
  const { code, stdout, stderr } = await r.route('pull_request.opened.json', D1)
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.ok(stderr.includes(`${lock}.guard.break`), stderr)
  assert.match(stderr, /Remove it by hand/)
  assert.equal(await readFile(`${lock}.guard`, 'utf8'), `${JSON.stringify({ token: 'crashed' })}\n`)
  assert.equal(await readFile(`${lock}.guard.break`, 'utf8'), '')
})

// A delivery record that a call killed between its record and its count left
// on disk: pending, with the PR lock token that call held.
async function pendingRecord(state: string, delivery: string, token: string) {
  await mkdir(join(state, 'deliveries', 'reviewer'), { recursive: true })
  await writeFile(join(state, 'deliveries', 'reviewer', delivery), JSON.stringify({ state: 'pending', pr: 42, token }))
}

async function heldLock(state: string, token: string) {
  await mkdir(join(state, 'locks'), { recursive: true })
  await writeFile(join(state, 'locks', 'pr-42.lock'), JSON.stringify({ pr: 42, token, taken_at: new Date().toISOString() }))
}

test('route: a pending delivery record whose lock is gone is decided again, and is a duplicate once done', async (t) => {
  const r = await router(t)
  await pendingRecord(r.state, D1, 'killed-call')
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), review())
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), ignore('duplicate'))
})

test('route: a pending delivery record whose token still holds a fresh lock is ignore (locked)', async (t) => {
  const r = await router(t)
  await pendingRecord(r.state, D1, 'live-call')
  await heldLock(r.state, 'live-call')
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), ignore('locked'))
})

test('route: a pending delivery record whose lock expired is decided again', async (t) => {
  const r = await router(t)
  await pendingRecord(r.state, D1, 'killed-call')
  await heldLock(r.state, 'killed-call')
  const old = new Date(Date.now() - (3 * 60 + 1) * 60 * 1000)
  await utimes(join(r.state, 'locks', 'pr-42.lock'), old, old)
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), review())
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D1)), ignore('duplicate'))
})

// --- The Implementer App, and the reviewer's re-check -------------------------

type Router = Awaited<ReturnType<typeof router>>

// A pause record, as #29 writes it when a run stops at a one-way door.
async function seedPause(r: Router, kind: 'issue' | 'pr', number: number, repo = REPO): Promise<void> {
  await mkdir(join(r.state, 'pauses'), { recursive: true })
  await writeFile(
    join(r.state, 'pauses', `${kind}-${number}.json`),
    `${JSON.stringify({ repo, kind, number, reason: 'Add a column to the runs table?', paused_at: '2026-10-19T09:00:00.000Z' })}\n`,
  )
}

const phase = (p: string) => (r: Router) => seedState(r.state, { pr: 42, phase: p }).then(() => {})
const paused = (kind: 'issue' | 'pr', n: number) => (r: Router) => seedPause(r, kind, n)

// Each case: the test name, the App, the recorded payload, the default
// branch, what the run state holds before the call, and the decision.
const flows: [string, App, string, Remote, ((r: Router) => Promise<void>) | null, Decision][] = [
  // build-ticket and build-spec
  ['the maintainer labels a ticket with no parent', 'implementer', 'issues.labeled.json', { review: implementerMd() }, null, onIssue('build-ticket')],
  ['the maintainer labels a spec', 'implementer', 'issues.labeled.spec.json', { review: implementerMd(), issue: SPEC }, null, onIssue('build-spec', null, 23)],
  ['the maintainer labels a ticket someone else wrote', 'implementer', 'issues.labeled.stranger-ticket.json', { review: implementerMd() }, null, onIssue('ignore', 'author', 31)],
  [
    'the maintainer labels a spec with one sub-issue someone else wrote',
    'implementer',
    'issues.labeled.spec.json',
    {
      review: implementerMd(),
      issue: {
        parent: false,
        subIssues: 3,
        subs: [
          { number: 24, author: MAINTAINER },
          { number: 25, author: 'mallory' },
          { number: 26, author: MAINTAINER },
        ],
      },
    },
    null,
    onIssue('ignore', 'author', 25),
  ],
  ['the maintainer labels a ticket that has a parent', 'implementer', 'issues.labeled.json', { review: implementerMd(), issue: CHILD }, null, onIssue('ignore', 'has-parent')],
  ['someone else adds ready-for-agent', 'implementer', 'issues.labeled.stranger.json', { review: implementerMd() }, null, onIssue('ignore', 'sender')],
  ['the maintainer adds another label', 'implementer', 'issues.labeled.other-label.json', { review: implementerMd() }, null, onIssue('ignore', 'label:needs-triage')],
  ['ready-for-agent on a pull request', 'implementer', 'issues.labeled.pull-request.json', { review: implementerMd() }, null, onPr('ignore', 'pull-request')],
  ['an issue opened', 'implementer', 'issues.opened.json', { review: implementerMd() }, null, onIssue('ignore', 'action:opened')],
  ['a label in a repo with no docs/agents/review.md', 'implementer', 'issues.labeled.json', { review: null }, null, onIssue('ignore', 'no-config')],
  ['a label with the Implementer App off', 'implementer', 'issues.labeled.json', { review: reviewMd() }, null, onIssue('ignore', 'disabled')],
  [
    'a label with implementer.app: disabled',
    'implementer',
    'issues.labeled.json',
    { review: reviewMd('implementer:', '  app: disabled') },
    null,
    onIssue('ignore', 'disabled'),
  ],
  ['a label in a paused repo', 'implementer', 'issues.labeled.json', { review: implementerMd('paused: true') }, null, onIssue('ignore', 'paused')],
  // adjudicate
  ['the review-posted hand-off', 'implementer', 'issue_comment.created.review-posted.json', { review: implementerMd() }, phase('review-posted'), onPr('adjudicate')],
  ['the recheck-failed hand-off', 'implementer', 'issue_comment.created.recheck-failed.json', { review: implementerMd() }, phase('review-posted'), onPr('adjudicate')],
  [
    'the review-posted hand-off before the run reached review-posted',
    'implementer',
    'issue_comment.created.review-posted.json',
    { review: implementerMd() },
    phase('review-dispatched'),
    onPr('ignore', 'phase'),
  ],
  ['the review-posted hand-off with no run state', 'implementer', 'issue_comment.created.review-posted.json', { review: implementerMd() }, null, onPr('ignore', 'phase')],
  [
    'a quoted hand-off from contract-reviewer[bot]',
    'implementer',
    'issue_comment.created.quoted-marker.json',
    { review: implementerMd() },
    phase('review-posted'),
    onPr('ignore', 'marker'),
  ],
  [
    'the adjudicated hand-off, to the Implementer',
    'implementer',
    'issue_comment.created.adjudicated.json',
    { review: implementerMd() },
    phase('adjudicated'),
    onPr('ignore', 'sender'),
  ],
  ['a /recheck from someone else, to the Implementer', 'implementer', 'issue_comment.created.stranger.json', { review: implementerMd() }, null, onPr('ignore', 'sender')],
  [
    'an edited hand-off comment',
    'implementer',
    'issue_comment.edited.json',
    { review: implementerMd() },
    phase('review-posted'),
    onPr('ignore', 'action:edited'),
  ],
  ['a pull request review', 'implementer', 'pull_request_review.submitted.json', { review: implementerMd() }, null, onPr('ignore', 'event:pull_request_review')],
  ['a pull request opened, to the Implementer', 'implementer', 'pull_request.opened.json', { review: implementerMd() }, null, onPr('ignore', 'event:pull_request')],
  // resume
  ['the maintainer answers a paused ticket', 'implementer', 'issue_comment.created.resume.json', { review: implementerMd() }, paused('issue', 28), onIssue('resume')],
  ['the maintainer answers a paused PR', 'implementer', 'issue_comment.created.resume-pr.json', { review: implementerMd() }, paused('pr', 42), onPr('resume')],
  [
    'the maintainer comments on a needs-info ticket with no pause record',
    'implementer',
    'issue_comment.created.resume.json',
    { review: implementerMd() },
    null,
    onIssue('ignore', 'no-pause-record'),
  ],
  // recheck (reviewer)
  ['the adjudicated hand-off', 'reviewer', 'issue_comment.created.adjudicated.json', { review: reviewMd() }, phase('adjudicated'), onPr('recheck')],
  ['the maintainer /recheck on their own PR', 'reviewer', 'issue_comment.created.recheck.json', { review: reviewMd() }, phase('adjudicated'), onPr('recheck')],
  [
    'the adjudicated hand-off before the run reached adjudicated',
    'reviewer',
    'issue_comment.created.adjudicated.json',
    { review: reviewMd() },
    phase('review-posted'),
    onPr('ignore', 'phase'),
  ],
  ['the maintainer /recheck with no run state', 'reviewer', 'issue_comment.created.recheck.json', { review: reviewMd() }, null, onPr('ignore', 'phase')],
  ['a /recheck from someone else', 'reviewer', 'issue_comment.created.stranger.json', { review: reviewMd() }, phase('adjudicated'), onPr('ignore', 'sender')],
  [
    'the review-posted hand-off, to the reviewer',
    'reviewer',
    'issue_comment.created.review-posted.json',
    { review: reviewMd() },
    phase('adjudicated'),
    onPr('ignore', 'sender'),
  ],
  ['an edited adjudicated hand-off', 'reviewer', 'issue_comment.edited.json', { review: reviewMd() }, phase('adjudicated'), onPr('ignore', 'action:edited')],
  ['a pull request review, to the reviewer', 'reviewer', 'pull_request_review.submitted.json', { review: reviewMd() }, null, onPr('ignore', 'event:pull_request_review')],
  ['a label, to the reviewer', 'reviewer', 'issues.labeled.json', { review: reviewMd() }, null, onIssue('ignore', 'event:issues')],
  ['a /recheck in a repo with no docs/agents/review.md', 'reviewer', 'issue_comment.created.recheck.json', { review: null }, phase('adjudicated'), onPr('ignore', 'no-config')],
  ['a /recheck in a paused repo', 'reviewer', 'issue_comment.created.recheck.json', { review: reviewMd('paused: true') }, phase('adjudicated'), onPr('ignore', 'paused')],
]

for (const [name, app, fixture, remote, before, expected] of flows) {
  test(`route --app ${app}: ${name} is ${expected.action}${expected.reason === null ? '' : ` (${expected.reason})`}`, async (t) => {
    const r = await router(t, remote)
    await before?.(r)
    const { code, stdout, stderr } = await r.route(fixture, '6f1e2d3c-0000-11f0-8a1b-0123456789ab', app)
    assert.equal(stderr, '')
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), expected)
  })
}

// Each case: the test name, the App, the recorded payload, a change to it,
// the run state phase of PR #42, and the decision.
const changed: [string, App, string, (p: Payload) => void, string | null, Decision][] = [
  [
    'a review-posted hand-off for another PR',
    'implementer',
    'issue_comment.created.review-posted.json',
    commentBody('<!-- hero-forge:handoff kind=review-posted pr=43 round=1 -->'),
    'review-posted',
    onPr('ignore', 'marker'),
  ],
  [
    'an adjudicated hand-off from contract-reviewer[bot]',
    'implementer',
    'issue_comment.created.review-posted.json',
    commentBody('<!-- hero-forge:handoff kind=adjudicated pr=42 round=1 -->'),
    'review-posted',
    onPr('ignore', 'marker'),
  ],
  [
    'a review-posted hand-off followed by more text',
    'implementer',
    'issue_comment.created.review-posted.json',
    commentBody('<!-- hero-forge:handoff kind=review-posted pr=42 round=1 -->\nand more'),
    'review-posted',
    onPr('ignore', 'marker'),
  ],
  [
    'a comment from contract-reviewer[bot] with no hand-off',
    'implementer',
    'issue_comment.created.review-posted.json',
    commentBody('Round 1 is posted.'),
    'review-posted',
    onPr('ignore', 'marker'),
  ],
  [
    'a review-posted hand-off on a PR the maintainer wrote',
    'implementer',
    'issue_comment.created.review-posted.json',
    (p) => {
      p.issue.user.login = MAINTAINER
    },
    'review-posted',
    onPr('ignore', 'author'),
  ],
  [
    'a contract-reviewer[bot] comment on an issue that is not a PR',
    'implementer',
    'issue_comment.created.review-posted.json',
    (p) => {
      delete p.issue.pull_request
    },
    'review-posted',
    onIssue('ignore', 'not-pull-request', 42),
  ],
  [
    'the maintainer comments on a ticket without needs-info',
    'implementer',
    'issue_comment.created.resume.json',
    (p) => {
      p.issue.labels = p.issue.labels.filter((l) => l.name !== 'needs-info')
    },
    null,
    onIssue('ignore', 'not-paused'),
  ],
  [
    'an adjudicated hand-off for another PR',
    'reviewer',
    'issue_comment.created.adjudicated.json',
    commentBody('<!-- hero-forge:handoff kind=adjudicated pr=43 round=1 -->'),
    'adjudicated',
    onPr('ignore', 'marker'),
  ],
  [
    'an adjudicated hand-off on a PR the maintainer wrote',
    'reviewer',
    'issue_comment.created.adjudicated.json',
    (p) => {
      p.issue.user.login = MAINTAINER
    },
    'adjudicated',
    onPr('ignore', 'author'),
  ],
  [
    'a /recheck by the maintainer on a PR contract-implementer[bot] wrote',
    'reviewer',
    'issue_comment.created.recheck.json',
    (p) => {
      p.issue.user.login = 'contract-implementer[bot]'
    },
    'adjudicated',
    onPr('ignore', 'author'),
  ],
  ['a /recheck that is not the whole first line', 'reviewer', 'issue_comment.created.recheck.json', commentBody('/recheck please'), 'adjudicated', onPr('ignore', 'not-recheck')],
  ['a /recheck after a space', 'reviewer', 'issue_comment.created.recheck.json', commentBody(' /recheck'), 'adjudicated', onPr('ignore', 'not-recheck')],
  ['a /recheck on the second line', 'reviewer', 'issue_comment.created.recheck.json', commentBody('Done.\n/recheck'), 'adjudicated', onPr('ignore', 'not-recheck')],
  ['a quoted /recheck', 'reviewer', 'issue_comment.created.recheck.json', commentBody('> /recheck'), 'adjudicated', onPr('ignore', 'not-recheck')],
  ['a /recheck with a CRLF line end', 'reviewer', 'issue_comment.created.recheck.json', commentBody('/recheck\r\nthanks'), 'adjudicated', onPr('recheck')],
  [
    'a /recheck on an issue that is not a PR',
    'reviewer',
    'issue_comment.created.recheck.json',
    (p) => {
      delete p.issue.pull_request
    },
    'adjudicated',
    onIssue('ignore', 'not-pull-request', 42),
  ],
]

for (const [name, app, fixture, change, before, expected] of changed) {
  test(`route --app ${app}: ${name} is ${expected.action}${expected.reason === null ? '' : ` (${expected.reason})`}`, async (t) => {
    const r = await router(t, { review: implementerMd() })
    if (before !== null) await seedState(r.state, { pr: 42, phase: before })
    if (fixture.includes('resume')) await seedPause(r, 'issue', 28)
    const { code, stdout, stderr } = await r.routeChanged(fixture, D1, change, app)
    assert.equal(stderr, '')
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), expected)
  })
}

const D5 = '55555555-eeee-11f0-8a1b-0123456789ab'
const D6 = '66666666-ffff-11f0-8a1b-0123456789ab'

// What a thread does at its end (#29): give its lock back. Here, by deleting
// the lock file.
const endRun = (r: Router, lock: string) => rm(join(r.state, 'locks', lock))

test('route --app implementer: a ticket at its attempt cap is ignore (attempts), and the decision names the ticket', async (t) => {
  const r = await router(t, { review: implementerMd('  attempts: 2') })
  assert.deepEqual(await decision(r.route('issues.labeled.json', D1, 'implementer')), onIssue('build-ticket'))
  await endRun(r, 'issue-28.lock')
  assert.deepEqual(await decision(r.route('issues.labeled.json', D2, 'implementer')), onIssue('build-ticket'))
  await endRun(r, 'issue-28.lock')
  assert.deepEqual(await decision(r.route('issues.labeled.json', D3, 'implementer')), onIssue('ignore', 'attempts'))
  // Another ticket has attempts of its own.
  assert.deepEqual(await decision(r.routeChanged('issues.labeled.json', D4, issueNumber(29), 'implementer')), onIssue('build-ticket', null, 29))
  // The count is per ticket, in the Implementer's own store.
  assert.deepEqual(JSON.parse(await readFile(join(r.caps, 'implementer-app-attempts.json'), 'utf8')), {
    [`${REPO}#28`]: 2,
    [`${REPO}#29`]: 1,
  })
})

test('route --app implementer: with no attempts the cap is 3 builds of a ticket, specs included', async (t) => {
  const r = await router(t, { review: implementerMd(), issue: SPEC })
  for (const delivery of [D1, D2, D3]) {
    assert.deepEqual(await decision(r.route('issues.labeled.spec.json', delivery, 'implementer')), onIssue('build-spec', null, 23))
    await endRun(r, 'issue-23.lock')
  }
  assert.deepEqual(await decision(r.route('issues.labeled.spec.json', D4, 'implementer')), onIssue('ignore', 'attempts', 23))
})

test('route --app implementer: an ignored label counts no attempt', async (t) => {
  const r = await router(t, { review: implementerMd('  attempts: 1', '  daily_runs: 1') })
  assert.deepEqual(await decision(r.routeChanged('issues.labeled.json', D1, issueNumber(29), 'implementer')), onIssue('build-ticket', null, 29))
  // The daily cap stops #28: no attempt of #28 is counted, and no lock held.
  assert.deepEqual(await decision(r.route('issues.labeled.json', D2, 'implementer')), onIssue('ignore', 'cap'))
  await r.gh.respond(responses({ review: implementerMd('  attempts: 1', '  daily_runs: 2') }))
  assert.deepEqual(await decision(r.route('issues.labeled.json', D3, 'implementer')), onIssue('build-ticket'))
})

test('route --app implementer: a second label while a build holds the ticket lock is ignore (locked)', async (t) => {
  const r = await router(t, { review: implementerMd() })
  assert.deepEqual(await decision(r.route('issues.labeled.json', D1, 'implementer')), onIssue('build-ticket'))
  assert.deepEqual(await decision(r.route('issues.labeled.json', D2, 'implementer')), onIssue('ignore', 'locked'))
  const lock = JSON.parse(await readFile(join(r.state, 'locks', 'issue-28.lock'), 'utf8'))
  assert.equal(lock.issue, 28)
  assert.equal(lock.app, 'implementer')
  assert.equal(lock.delivery, D1)
})

test('route --app implementer: two labels at once on one ticket give one build and one attempt', async (t) => {
  const r = await router(t, { review: implementerMd() })
  const both = await Promise.all([r.route('issues.labeled.json', D1, 'implementer'), r.route('issues.labeled.json', D2, 'implementer')].map(decision))
  assert.deepEqual(both.map((d) => d.reason).sort(), [null, 'locked'].sort())
  assert.deepEqual(JSON.parse(await readFile(join(r.caps, 'implementer-app-attempts.json'), 'utf8')), { [`${REPO}#28`]: 1 })
})

test('route --app implementer: the Implementer daily cap is its own, apart from the reviewer one', async (t) => {
  const r = await router(t, { review: implementerMd('  daily_runs: 1', 'app_daily_runs: 1') })
  assert.deepEqual(await decision(r.route('issues.labeled.json', D1, 'implementer')), onIssue('build-ticket'))
  assert.deepEqual(await decision(r.routeChanged('issues.labeled.json', D2, issueNumber(29), 'implementer')), onIssue('ignore', 'cap', 29))
  // The reviewer still has its one run.
  assert.deepEqual(await decision(r.route('pull_request.opened.json', D3)), review())
  assert.equal(JSON.parse(await readFile(join(r.caps, 'implementer-app-runs.json'), 'utf8')).length, 1)
  assert.equal(JSON.parse(await readFile(join(r.caps, 'reviewer-app-runs.json'), 'utf8')).length, 1)
})

test('route --app implementer: with no daily_runs the Implementer cap is 20 runs', async (t) => {
  const r = await router(t, { review: implementerMd() })
  const hours = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString()
  await mkdir(r.caps, { recursive: true })
  await writeFile(join(r.caps, 'implementer-app-runs.json'), JSON.stringify(Array.from({ length: 19 }, () => hours(2))))
  assert.deepEqual(await decision(r.route('issues.labeled.json', D1, 'implementer')), onIssue('build-ticket'))
  assert.deepEqual(await decision(r.routeChanged('issues.labeled.json', D2, issueNumber(29), 'implementer')), onIssue('ignore', 'cap', 29))
})

test('route --app implementer: a corrupt attempts file exits 4 and takes no lock', async (t) => {
  const r = await router(t, { review: implementerMd() })
  await mkdir(r.caps, { recursive: true })
  await writeFile(join(r.caps, 'implementer-app-attempts.json'), '["not", "a map"]')
  const { code, stdout, stderr } = await r.route('issues.labeled.json', D1, 'implementer')
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts route: corrupt attempts file .*implementer-app-attempts\.json/)
  await rm(join(r.caps, 'implementer-app-attempts.json'))
  assert.deepEqual(await decision(r.route('issues.labeled.json', D1, 'implementer')), onIssue('build-ticket'))
})

test('route --app implementer: a stranger label costs no lookup, and the issue is looked up only after the sender rule', async (t) => {
  const r = await router(t, { review: implementerMd() })
  await decision(r.route('issues.labeled.other-label.json', D1, 'implementer'))
  assert.deepEqual((await r.gh.calls()).map((c) => c.argv.join(' ')), [
    `api -H Accept: application/vnd.github.raw+json repos/${REPO}/contents/docs/agents/review.md?ref=main`,
  ])
  await decision(r.route('issues.labeled.stranger.json', D2, 'implementer'))
  assert.deepEqual((await r.gh.calls()).slice(1).map((c) => c.argv[1]), ['-H', 'user'])
  await decision(r.route('issues.labeled.json', D3, 'implementer'))
  assert.deepEqual(
    (await r.gh.calls()).slice(3).map((c) => c.argv),
    [
      ['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${REPO}/contents/docs/agents/review.md?ref=main`],
      ['api', 'user', '--jq', '.login'],
      ['api', `repos/${REPO}/issues/28`, '--jq', '{parent_issue_url, sub_issues_summary}'],
    ],
  )
})

test('route --app implementer: a failed issue lookup exits 1 and takes no lock', async (t) => {
  const r = await router(t, { review: implementerMd() })
  await r.gh.respond([...responses({ review: implementerMd() }).slice(0, 2), { match: `repos/${REPO}/issues/`, stderr: 'gh: Server Error (HTTP 502)\n', exit: 1 }])
  const { code, stdout, stderr } = await r.route('issues.labeled.json', D1, 'implementer')
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, `review.ts route: cannot read issue #28 of ${REPO}: gh: Server Error (HTTP 502)\n`)
  await r.gh.respond(responses({ review: implementerMd() }))
  assert.deepEqual(await decision(r.route('issues.labeled.json', D1, 'implementer')), onIssue('build-ticket'))
})

test('route: a delivery id is a duplicate only for the App that recorded it', async (t) => {
  const r = await router(t, { review: implementerMd() })
  await seedState(r.state, { pr: 42, phase: 'review-posted' })
  assert.deepEqual(await decision(r.route('issue_comment.created.review-posted.json', D1, 'implementer')), onPr('adjudicate'))
  assert.deepEqual(await decision(r.route('issue_comment.created.review-posted.json', D1, 'implementer')), onPr('ignore', 'duplicate'))
  // The reviewer route has never seen D1; it ignores the comment for its own reason.
  assert.deepEqual(await decision(r.route('issue_comment.created.review-posted.json', D1, 'reviewer')), onPr('ignore', 'sender'))
})

test('route --app implementer: a hand-off while the PR lock is held is ignore (locked), and adjudicate takes the per-PR lock', async (t) => {
  const r = await router(t, { review: implementerMd() })
  await seedState(r.state, { pr: 42, phase: 'review-posted' })
  assert.deepEqual(await decision(r.route('issue_comment.created.review-posted.json', D1, 'implementer')), onPr('adjudicate'))
  assert.deepEqual(await decision(r.route('issue_comment.created.recheck-failed.json', D2, 'implementer')), onPr('ignore', 'locked'))
  const lock = JSON.parse(await readFile(join(r.state, 'locks', 'pr-42.lock'), 'utf8'))
  assert.equal(lock.pr, 42)
  assert.equal(lock.app, 'implementer')
})

test('route --app implementer: two hand-offs at once for one PR give one adjudicate', async (t) => {
  const r = await router(t, { review: implementerMd() })
  await seedState(r.state, { pr: 42, phase: 'review-posted' })
  const both = await Promise.all(
    [r.route('issue_comment.created.review-posted.json', D1, 'implementer'), r.route('issue_comment.created.recheck-failed.json', D2, 'implementer')].map(
      decision,
    ),
  )
  assert.deepEqual(both.map((d) => d.reason).sort(), [null, 'locked'].sort())
})

test('route: the reviewer and the Implementer share the per-PR lock', async (t) => {
  const r = await router(t, { review: implementerMd() })
  await seedState(r.state, { pr: 42, phase: 'adjudicated' })
  assert.deepEqual(await decision(r.route('issue_comment.created.adjudicated.json', D1)), onPr('recheck'))
  await writeFile(join(r.state, 'pr-42', 'state.json'), JSON.stringify({ ...JSON.parse(await readFile(join(r.state, 'pr-42', 'state.json'), 'utf8')), phase: 'review-posted' }))
  assert.deepEqual(await decision(r.route('issue_comment.created.review-posted.json', D2, 'implementer')), onPr('ignore', 'locked'))
  await endRun(r, 'pr-42.lock')
  assert.deepEqual(await decision(r.route('issue_comment.created.review-posted.json', D3, 'implementer')), onPr('adjudicate'))
})

test('route --app reviewer: a re-check counts toward the reviewer daily cap', async (t) => {
  const r = await router(t, { review: reviewMd('app_daily_runs: 1') })
  assert.deepEqual(await decision(r.routeChanged('pull_request.opened.json', D1, prNumber(43))), review(43))
  await seedState(r.state, { pr: 42, phase: 'adjudicated' })
  assert.deepEqual(await decision(r.route('issue_comment.created.recheck.json', D2)), onPr('ignore', 'cap'))
})

test('route --app reviewer: a /recheck asks for the maintainer, the hand-off of contract-implementer[bot] does not', async (t) => {
  const r = await router(t)
  await seedState(r.state, { pr: 42, phase: 'adjudicated' })
  await decision(r.route('issue_comment.created.adjudicated.json', D1))
  assert.deepEqual((await r.gh.calls()).map((c) => c.argv[1]), ['-H'])
  await endRun(r, 'pr-42.lock')
  await decision(r.route('issue_comment.created.recheck.json', D2))
  assert.deepEqual((await r.gh.calls()).slice(1).map((c) => c.argv[1]), ['-H', 'user'])
})

test('route --app implementer: a pause record for another repo is no pause record here', async (t) => {
  const r = await router(t, { review: implementerMd() })
  await seedPause(r, 'issue', 28, 'contract-hero/other')
  assert.deepEqual(await decision(r.route('issue_comment.created.resume.json', D1, 'implementer')), onIssue('ignore', 'no-pause-record'))
})

test('route --app implementer: a pause record is per issue or PR, and a PR record does not resume the issue of the same number', async (t) => {
  const r = await router(t, { review: implementerMd() })
  await seedPause(r, 'pr', 28)
  assert.deepEqual(await decision(r.route('issue_comment.created.resume.json', D1, 'implementer')), onIssue('ignore', 'no-pause-record'))
})

test('route --app implementer: a resume takes the lock of the issue, and a second answer while it runs is ignore (locked)', async (t) => {
  const r = await router(t, { review: implementerMd() })
  await seedPause(r, 'issue', 28)
  assert.deepEqual(await decision(r.route('issue_comment.created.resume.json', D1, 'implementer')), onIssue('resume'))
  assert.deepEqual(await decision(r.route('issue_comment.created.resume.json', D2, 'implementer')), onIssue('ignore', 'locked'))
  const lock = JSON.parse(await readFile(join(r.state, 'locks', 'issue-28.lock'), 'utf8'))
  assert.equal(lock.app, 'implementer')
})

test('route --app implementer: a corrupt pause record exits 4', async (t) => {
  const r = await router(t, { review: implementerMd() })
  await mkdir(join(r.state, 'pauses'), { recursive: true })
  await writeFile(join(r.state, 'pauses', 'issue-28.json'), '{ not json')
  const { code, stdout, stderr } = await r.route('issue_comment.created.resume.json', D5, 'implementer')
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts route: corrupt pause record .*pauses\/issue-28\.json/)
})

test('route --app reviewer: a /recheck while the PR lock is held is ignore (locked)', async (t) => {
  const r = await router(t)
  await seedState(r.state, { pr: 42, phase: 'adjudicated' })
  assert.deepEqual(await decision(r.route('issue_comment.created.recheck.json', D5)), onPr('recheck'))
  assert.deepEqual(await decision(r.route('issue_comment.created.adjudicated.json', D6)), onPr('ignore', 'locked'))
})

test('route --app implementer: a spec someone else wrote is ignore (author), and no sub-issue is looked up', async (t) => {
  const r = await router(t, { review: implementerMd(), issue: SPEC })
  const got = await decision(
    r.routeChanged(
      'issues.labeled.spec.json',
      D1,
      (p) => {
        p.issue.user.login = 'mallory'
      },
      'implementer',
    ),
  )
  assert.deepEqual(got, onIssue('ignore', 'author', 23))
  assert.ok(!(await r.gh.calls()).some((c) => c.argv.join(' ').includes('/sub_issues')))
})

test('route --app implementer: a spec reads every page of its sub-issues as the maintainer', async (t) => {
  const r = await router(t, { review: implementerMd(), issue: SPEC })
  assert.deepEqual(await decision(r.route('issues.labeled.spec.json', D1, 'implementer')), onIssue('build-spec', null, 23))
  assert.deepEqual(
    (await r.gh.calls()).map((c) => c.argv).filter((argv) => argv.join(' ').includes('/sub_issues')),
    [['api', '--paginate', '--jq', '.[] | {number, author: .user.login}', `repos/${REPO}/issues/23/sub_issues?per_page=100`]],
  )
})
