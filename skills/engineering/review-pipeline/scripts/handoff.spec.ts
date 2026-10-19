// The hand-off marker that a thread posts as its last action (`review.ts
// handoff` posts it, `route` reads it). The first tests call handoff.ts's two
// exported functions: the format must stay the one that `route` parses. The
// rest drive `review.ts handoff` through its command line.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { handoffMarker, parseHandoff } from './handoff.ts'
import {
  fakeGh,
  IMPLEMENTER_TOKEN,
  implementerApp,
  REVIEWER_TOKEN,
  reviewerApp,
  runCli,
  seedState,
  tempDir,
  type FakeGhCall,
  type FakeGhResponse,
} from './test-helpers.ts'

test('handoff marker: the writer gives the one format, kind then pr then round', () => {
  assert.equal(handoffMarker({ kind: 'adjudicated', pr: 12, round: 1 }), '<!-- hero-forge:handoff kind=adjudicated pr=12 round=1 -->')
  assert.equal(handoffMarker({ kind: 'review-posted', pr: 7, round: 2 }), '<!-- hero-forge:handoff kind=review-posted pr=7 round=2 -->')
  assert.equal(handoffMarker({ kind: 'recheck-failed', pr: 40, round: 3 }), '<!-- hero-forge:handoff kind=recheck-failed pr=40 round=3 -->')
})

test('handoff marker: what the writer gives, as the last line of a comment, parses back', () => {
  for (const handoff of [
    { kind: 'review-posted', pr: 42, round: 1 },
    { kind: 'recheck-failed', pr: 42, round: 2 },
    { kind: 'adjudicated', pr: 9, round: 10 },
  ] as const) {
    assert.deepEqual(parseHandoff(handoffMarker(handoff)), handoff)
    assert.deepEqual(parseHandoff(`Round done.\n\n${handoffMarker(handoff)}\n`), handoff)
    assert.deepEqual(parseHandoff(`Round done.\r\n\r\n${handoffMarker(handoff)}\r\n`), handoff)
  }
})

const notMarkers: [string, string][] = [
  ['a marker that is not the last line', '<!-- hero-forge:handoff kind=adjudicated pr=12 round=1 -->\nmore text'],
  ['a quoted marker', '> <!-- hero-forge:handoff kind=adjudicated pr=12 round=1 -->'],
  ['a marker in a code span', '`<!-- hero-forge:handoff kind=adjudicated pr=12 round=1 -->`'],
  ['an unknown kind', '<!-- hero-forge:handoff kind=merged pr=12 round=1 -->'],
  ['fields in another order', '<!-- hero-forge:handoff pr=12 kind=adjudicated round=1 -->'],
  ['a missing round', '<!-- hero-forge:handoff kind=adjudicated pr=12 -->'],
  ['an extra field', '<!-- hero-forge:handoff kind=adjudicated pr=12 round=1 by=me -->'],
  ['a pr of 0', '<!-- hero-forge:handoff kind=adjudicated pr=0 round=1 -->'],
  ['a pr with a leading zero', '<!-- hero-forge:handoff kind=adjudicated pr=012 round=1 -->'],
  ['two spaces', '<!-- hero-forge:handoff  kind=adjudicated pr=12 round=1 -->'],
  ['another case', '<!-- HERO-FORGE:handoff kind=adjudicated pr=12 round=1 -->'],
  ['leading text on the line', 'done <!-- hero-forge:handoff kind=adjudicated pr=12 round=1 -->'],
  ['the review-pipeline marker', '<!-- hero-forge:review-pipeline pr=12 round=1 kind=review -->'],
  ['an empty body', ''],
]

for (const [name, body] of notMarkers) {
  test(`handoff marker: ${name} is no marker`, () => {
    assert.equal(parseHandoff(body), null)
  })
}

const REPO = 'contract-hero/hero-forge'
const BOTH_APPS = '```yaml\nruntime: claude\napp: enabled\nimplementer:\n  app: enabled\n```\n'
const NO_APPS = '```yaml\nruntime: claude\n```\n'

type App = 'reviewer' | 'implementer'
type Setup = { app: App; config?: string; state?: Record<string, unknown> | null; comments?: string; missing?: boolean; post?: FakeGhResponse }

// A temp dir with a config, one App, a run state for PR #13 and a fake gh.
// `cli` runs `review.ts handoff --repo REPO --pr 13 --config <config> <args>`.
async function setup(t: Parameters<typeof tempDir>[0], options: Setup) {
  const dir = await tempDir(t)
  const config = join(dir, 'review.md')
  await writeFile(config, options.config ?? BOTH_APPS)
  const root = join(dir, 'state')
  if (options.state !== null) await seedState(root, { reviewer_login: 'contract-reviewer[bot]', ...options.state })
  const app = options.app === 'reviewer'
    ? await reviewerApp(t, dir, REPO, { missing: options.missing })
    : await implementerApp(t, dir, REPO, { missing: options.missing })
  const gh = await fakeGh(dir, [
    { match: 'issues/13/comments --input', stdout: JSON.stringify({ id: 777 }), ...options.post },
    { match: 'issues/13/comments', stdout: options.comments ?? '' },
  ])
  const env = { ...gh.env, ...app.env, HERO_FORGE_STATE_DIR: root }
  const cli = (...args: string[]) => runCli(['handoff', '--repo', REPO, '--pr', '13', '--config', config, ...args], { env })
  return { gh, api: app.api, cli }
}

const posts = (calls: FakeGhCall[]) => calls.filter((c) => c.argv.includes('POST'))

const CASES: [App, string, Record<string, unknown>, number, string][] = [
  ['reviewer', 'review-posted', { phase: 'review-posted', round: 1 }, 1, REVIEWER_TOKEN],
  ['reviewer', 'recheck-failed', { phase: 'review-posted', round: 2 }, 2, REVIEWER_TOKEN],
  ['implementer', 'adjudicated', { phase: 'adjudicated', round: 1 }, 1, IMPLEMENTER_TOKEN],
]

for (const [app, kind, state, round, token] of CASES) {
  test(`handoff --app ${app} --kind ${kind} posts one PR comment as the App whose last line is the marker, and prints no token`, async (t) => {
    const s = await setup(t, { app, state })
    const result = await s.cli('--app', app, '--kind', kind, '--round', String(round))
    assert.equal(result.stderr, '')
    assert.equal(result.code, 0)
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token))
    assert.deepEqual(JSON.parse(result.stdout), { id: 777, kind, pr: 13, round, as: `contract-${app}[bot]`, already: false })
    const sent = posts(await s.gh.calls())
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0]!.argv, ['api', '-X', 'POST', `repos/${REPO}/issues/13/comments`, '--input', '-'])
    assert.equal(sent[0]!.gh_token, token)
    const body = (JSON.parse(sent[0]!.stdin) as { body: string }).body
    assert.deepEqual(parseHandoff(body), { kind, pr: 13, round })
    assert.equal(body.split('\n').at(-1), handoffMarker({ kind: kind as 'adjudicated', pr: 13, round }))
  })
}

// The run was created at CREATED; GitHub gives comment times in whole seconds.
const CREATED = '2026-10-19T12:00:00.400Z'
const lines = (...comments: object[]) => comments.map((c) => `${JSON.stringify(c)}\n`).join('')

test('handoff run again after its post landed posts nothing and says already', async (t) => {
  const mark = handoffMarker({ kind: 'adjudicated', pr: 13, round: 1 })
  const comments = lines(
    { id: 5, login: 'someone', body: `quoted\n\n${mark}`, created_at: '2026-10-19T13:00:00Z' },
    { id: 6, login: 'contract-implementer[bot]', body: `Adjudication of round 1 is done.\n\n${mark}`, created_at: '2026-10-19T12:00:00Z' },
  )
  const s = await setup(t, { app: 'implementer', state: { phase: 'adjudicated', round: 1, created_at: CREATED }, comments })
  const result = await s.cli('--app', 'implementer', '--kind', 'adjudicated', '--round', '1')
  assert.equal(result.stderr, '')
  assert.equal(result.code, 0)
  assert.deepEqual(JSON.parse(result.stdout), { id: 6, kind: 'adjudicated', pr: 13, round: 1, as: 'contract-implementer[bot]', already: true })
  assert.deepEqual(posts(await s.gh.calls()), [])
})

// A new run (after a supersede, or a terminal run created again) starts at
// round 1 again: the marker of an earlier run is not this run's hand-off.
test("the same marker from an earlier run of the PR, before this run's created_at, does not stop the post", async (t) => {
  const mark = handoffMarker({ kind: 'review-posted', pr: 13, round: 1 })
  const comments = lines({ id: 4, login: 'contract-reviewer[bot]', body: `Hand-off.\n\n${mark}`, created_at: '2026-10-19T11:59:59Z' })
  const s = await setup(t, { app: 'reviewer', state: { phase: 'review-posted', round: 1, created_at: CREATED }, comments })
  const result = await s.cli('--app', 'reviewer', '--kind', 'review-posted', '--round', '1')
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { id: 777, kind: 'review-posted', pr: 13, round: 1, as: 'contract-reviewer[bot]', already: false })
  assert.equal(posts(await s.gh.calls()).length, 1)
})

test('the same marker posted by another login does not count as already posted', async (t) => {
  const mark = handoffMarker({ kind: 'review-posted', pr: 13, round: 1 })
  const comments = lines({ id: 5, login: 'alilloig', body: mark, created_at: '2026-10-19T13:00:00Z' })
  const s = await setup(t, { app: 'reviewer', state: { phase: 'review-posted', round: 1, created_at: CREATED }, comments })
  const result = await s.cli('--app', 'reviewer', '--kind', 'review-posted', '--round', '1')
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).already, false)
  assert.equal(posts(await s.gh.calls()).length, 1)
})

// A marker posted before `run-state advance` would be routed against the old
// phase: handoff refuses it, before any token is minted.
for (const [kind, app, state, round, said] of [
  ['review-posted', 'reviewer', { phase: 'review-dispatched', round: 1 }, 1, /PR #13 is at phase review-dispatched, round 1: a review-posted hand-off needs phase review-posted at round 1/],
  ['review-posted', 'reviewer', { phase: 'review-posted', round: 2 }, 1, /needs phase review-posted at round 1/],
  ['recheck-failed', 'reviewer', { phase: 'rechecked', round: 1 }, 2, /a recheck-failed hand-off needs phase review-posted at round 2/],
  ['recheck-failed', 'reviewer', { phase: 'review-posted', round: 1 }, 1, /a recheck-failed hand-off needs round 2 or later/],
  ['adjudicated', 'implementer', { phase: 'review-posted', round: 1 }, 1, /an adjudicated hand-off needs phase adjudicated at round 1/],
] as const) {
  test(`handoff ${kind} at ${state.phase} round ${state.round} (asked round ${round}) exits 1 and posts nothing`, async (t) => {
    const s = await setup(t, { app, state })
    const result = await s.cli('--app', app, '--kind', kind, '--round', String(round))
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, said)
    assert.deepEqual(await s.gh.calls(), [])
    assert.deepEqual(s.api.requests, [])
  })
}

test('handoff for a run of another repo exits 1 and posts nothing', async (t) => {
  const s = await setup(t, { app: 'reviewer', state: { phase: 'review-posted', repo: 'someone/else' } })
  const result = await s.cli('--app', 'reviewer', '--kind', 'review-posted', '--round', '1')
  assert.equal(result.code, 1)
  assert.match(result.stderr, /the run state of PR #13 is for someone\/else, not contract-hero\/hero-forge/)
  assert.deepEqual(await s.gh.calls(), [])
})

test('handoff with no run state exits 3 and posts nothing', async (t) => {
  const s = await setup(t, { app: 'reviewer', state: null })
  const result = await s.cli('--app', 'reviewer', '--kind', 'review-posted', '--round', '1')
  assert.equal(result.code, 3)
  assert.deepEqual(await s.gh.calls(), [])
})

test('the reviewer App posting as another login than the run state names exits 1 and posts nothing', async (t) => {
  const s = await setup(t, { app: 'reviewer', state: { phase: 'review-posted', reviewer_login: 'other-reviewer[bot]' } })
  const result = await s.cli('--app', 'reviewer', '--kind', 'review-posted', '--round', '1')
  assert.equal(result.code, 1)
  assert.match(result.stderr, /the reviewer App posts as contract-reviewer\[bot\], but the run state for PR #13 expects other-reviewer\[bot\]/)
  assert.deepEqual(posts(await s.gh.calls()), [])
})

// Each kind belongs to one App: route ignores the other pairing, so it would
// be a hand-off nobody picks up.
for (const [app, kind] of [['implementer', 'review-posted'], ['implementer', 'recheck-failed'], ['reviewer', 'adjudicated']] as const) {
  test(`handoff --app ${app} --kind ${kind} is a usage error (exit 2) that mints nothing`, async (t) => {
    const s = await setup(t, { app, state: { phase: 'adjudicated' } })
    const result = await s.cli('--app', app, '--kind', kind, '--round', '1')
    assert.equal(result.code, 2)
    assert.match(result.stderr, new RegExp(`^review\\.ts handoff: an? ${kind} hand-off is posted by the ${app === 'reviewer' ? 'implementer' : 'reviewer'} App`))
    assert.deepEqual(s.api.requests, [])
  })
}

for (const [app, key] of [['reviewer', 'app: enabled'], ['implementer', 'implementer.app: enabled']] as const) {
  test(`handoff --app ${app} without "${key}" exits 3 and posts nothing`, async (t) => {
    const s = await setup(t, { app, config: NO_APPS, state: { phase: app === 'reviewer' ? 'review-posted' : 'adjudicated' } })
    const result = await s.cli('--app', app, '--kind', app === 'reviewer' ? 'review-posted' : 'adjudicated', '--round', '1')
    assert.equal(result.code, 3)
    assert.match(result.stderr, new RegExp(`no "${key.replace('.', '\\.')}" in the config`))
    assert.deepEqual(await s.gh.calls(), [])
  })

  test(`handoff --app ${app} with broken App credentials exits 4 and posts nothing, as the App or as the user`, async (t) => {
    const s = await setup(t, { app, missing: true, state: { phase: app === 'reviewer' ? 'review-posted' : 'adjudicated' } })
    const result = await s.cli('--app', app, '--kind', app === 'reviewer' ? 'review-posted' : 'adjudicated', '--round', '1')
    assert.equal(result.code, 4)
    assert.deepEqual(posts(await s.gh.calls()), [])
  })
}

test('GitHub refusing the hand-off comment exits 1 with its message and no token', async (t) => {
  const s = await setup(t, { app: 'implementer', state: { phase: 'adjudicated' }, post: { match: 'issues/13/comments --input', stderr: 'gh: Resource not accessible by integration (HTTP 403)\n', exit: 1 } })
  const result = await s.cli('--app', 'implementer', '--kind', 'adjudicated', '--round', '1')
  assert.equal(result.code, 1)
  assert.match(result.stderr, /^review\.ts handoff: GitHub rejected the hand-off comment on PR #13: gh: Resource not accessible by integration \(HTTP 403\)\n$/)
  assert.ok(!result.stderr.includes(IMPLEMENTER_TOKEN))
})

test('handoff with a bad kind, a missing round or an unknown app is a usage error', async (t) => {
  const s = await setup(t, { app: 'reviewer', state: { phase: 'review-posted' } })
  for (const args of [['--app', 'reviewer', '--kind', 'merged', '--round', '1'], ['--app', 'reviewer', '--kind', 'review-posted'], ['--app', 'other', '--kind', 'review-posted', '--round', '1']]) {
    const result = await s.cli(...args)
    assert.equal(result.code, 2, args.join(' '))
    assert.match(result.stderr, /^review\.ts handoff: .*\nusage: /, args.join(' '))
  }
  assert.deepEqual(await s.gh.calls(), [])
})
