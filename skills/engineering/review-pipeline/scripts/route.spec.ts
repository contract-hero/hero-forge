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

// The repo's default branch: its review.md (null: the file is not there).
type Remote = { review: string | null }

function responses({ review }: Remote): FakeGhResponse[] {
  return [
    review === null
      ? { match: 'contents/docs/agents/review.md', stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)\n', exit: 1 }
      : { match: 'contents/docs/agents/review.md', stdout: review },
    { match: 'api user', stdout: `${MAINTAINER}\n` },
  ]
}

// A router with its own run-state dir, cap dir and fake gh.
// `caps` shares one cap dir between routers (two repos on one machine).
async function router(t: Parameters<typeof tempDir>[0], remote: Remote = { review: reviewMd() }, shared?: { caps: string }) {
  const dir = await tempDir(t)
  const state = join(dir, 'state')
  const caps = shared?.caps ?? join(dir, 'caps')
  const gh = await fakeGh(dir, responses(remote))
  const env = { ...gh.env, HERO_FORGE_STATE_DIR: state, HERO_FORGE_CAP_DIR: caps }
  return {
    dir,
    state,
    caps,
    gh,
    // `fixture` is a file in fixtures/route/; its name up to the first dot is the event.
    route: (fixture: string, delivery: string) =>
      runCli(
        ['route', '--app', 'reviewer', '--event', fixture.split('.')[0] ?? '', '--delivery', delivery, '--payload', join(FIXTURES, fixture)],
        { env },
      ),
    // A recorded payload with `change` applied, for another PR or repo.
    routeChanged: async (fixture: string, delivery: string, change: (payload: Payload) => void) => {
      const payload = JSON.parse(await readFile(join(FIXTURES, fixture), 'utf8')) as Payload
      change(payload)
      const file = join(dir, `payload-${delivery}.json`)
      await writeFile(file, JSON.stringify(payload))
      return runCli(['route', '--app', 'reviewer', '--event', 'pull_request', '--delivery', delivery, '--payload', file], { env })
    },
  }
}

type Payload = { number: number; pull_request: { number: number }; repository: { full_name: string } }

const prNumber = (n: number) => (payload: Payload) => {
  payload.number = n
  payload.pull_request.number = n
}

type Decision = { action: 'review' | 'ignore'; repo: string | null; pr: number | null; reason: string | null }

const review = (pr = 42): Decision => ({ action: 'review', repo: REPO, pr, reason: null })
const ignore = (reason: string, pr: number | null = 42): Decision => ({ action: 'ignore', repo: REPO, pr, reason })

// Each case: the test name, the recorded payload, the default branch, and the
// decision a fresh router prints for it.
const cases: [string, string, Remote, Decision][] = [
  ['a draft PR opened by the maintainer', 'pull_request.opened.draft.json', { review: reviewMd() }, ignore('action:opened')],
  ['a PR opened by the maintainer, not a draft', 'pull_request.opened.json', { review: reviewMd() }, review()],
  ['a maintainer PR marked ready for review', 'pull_request.ready_for_review.json', { review: reviewMd() }, review()],
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
  assert.deepEqual(other, { action: 'ignore', repo: 'contract-hero/other', pr: 42, reason: 'cap' })
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
  ['an App other than reviewer', ['--app', 'implementer', '--event', 'pull_request', '--delivery', D1, '--payload', 'p.json'], '--app must be reviewer'],
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
