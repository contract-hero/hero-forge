import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeGh, IMPLEMENTER_TOKEN, implementerApp, runCli, tempDir, type FakeApiRequest, type FakeGhResponse } from './test-helpers.ts'

const SHA = 'c'.repeat(40)
const REPO = 'contract-hero/hero-forge'
const USER = ['api', 'user', '--jq', '.login']
const ME: FakeGhResponse = { match: 'api user', stdout: 'alilloig\n' }
const COMMENTS = [
  'api', '--paginate', '--jq', '.[] | {id, in_reply_to_id, pull_request_review_id, login: .user.login, body}',
  `repos/${REPO}/pulls/13/comments`,
]
const ISSUE_COMMENTS = ['api', '--paginate', '--jq', '.[] | {id, body, login: .user.login}', `repos/${REPO}/issues/13/comments`]
const replyTo = (comment: number) => ['api', '-X', 'POST', `repos/${REPO}/pulls/13/comments/${comment}/replies`, '--input', '-']
const COMMENT_POST = ['api', '-X', 'POST', `repos/${REPO}/issues/13/comments`, '--input', '-']
const marker = (round: number, kind: string) => `<!-- hero-forge:review-pipeline pr=13 round=${round} kind=${kind} -->`
const adjudicationMarker = (round: number, review = 555) => `<!-- hero-forge:review-pipeline pr=13 round=${round} kind=adjudication review=${review} -->`
const replyMarker = (round: number, id: string) => `<!-- hero-forge:review-pipeline pr=13 round=${round} kind=reply id=${id} -->`

type Inline = { id: number; body: string; review?: number; reply_to?: number; login?: string }

function inline(...comments: Inline[]): string {
  return comments
    .map((c) => `${JSON.stringify({
      id: c.id,
      in_reply_to_id: c.reply_to ?? null,
      pull_request_review_id: c.review ?? 555,
      login: c.login ?? 'alilloig',
      body: c.body,
    })}\n`)
    .join('')
}

// F1 and F2 are inline in the pipeline's review 555. A human's comment in
// another review is not a finding.
const FINDINGS: Inline[] = [
  { id: 101, body: '**F1** (Standards, bug, high, 2/2 pairs) ...' },
  { id: 102, body: '**F2** (Spec, spec-missing, medium, 1/2 pairs) ...' },
  { id: 104, body: '**F9** looks off', review: 999, login: 'someone' },
]
const LEDGER = [
  { id: 'F1', where: 'src/a.ts:42', finding: 'unsanitised input', decision: 'ACCEPT', reason: 'sanitised in the fix commit' },
  { id: 'F2', where: 'src/b.ts:12', finding: 'missing case', decision: 'REFUTE', reason: 'out of scope | see #6' },
  { id: 'F3', where: 'src/c.ts:3', finding: 'stale doc', decision: 'ACCEPT', reason: 'doc updated' },
]

const SUMMARY_1 = [
  '## Adjudication: round 1',
  '',
  '| ID | Where | Decision | Reason |',
  '| --- | --- | --- | --- |',
  '| F1 | src/a.ts:42 | ACCEPT | sanitised in the fix commit |',
  '| F2 | src/b.ts:12 | REFUTE | out of scope \\| see #6 |',
  '| F3 | src/c.ts:3 | ACCEPT | doc updated |',
  '',
  'Each inline finding also has this answer in its thread.',
  '',
  adjudicationMarker(1),
].join('\n')

// `app`: the config has `app: enabled` and the machine has the Implementer
// App (`broken`: its env file is missing). `author`: the PR author GitHub
// reports, read only with `app`.
type Setup = { ledger?: unknown; recheck?: unknown; noState?: boolean; app?: { broken?: boolean }; author?: string }

// A PR with the pipeline's round 1 review (id 555) recorded in run state,
// and a ledger. `reply(round)` runs the subcommand.
async function setup(t: Parameters<typeof tempDir>[0], options: Setup = {}) {
  const dir = await tempDir(t)
  const gh = await fakeGh(dir, [{ match: '--input', stdout: JSON.stringify({ id: 555 }) }, ME])
  const app = options.app === undefined ? undefined : await implementerApp(t, dir, REPO, options.app)
  const env = { ...gh.env, ...app?.env, HERO_FORGE_STATE_DIR: join(dir, 'state') }
  const config = join(dir, 'review.md')
  await writeFile(config, '```yaml\nruntime: claude\n```\n')
  const replyConfig = join(dir, 'reply-review.md')
  await writeFile(replyConfig, options.app === undefined ? '```yaml\nruntime: claude\n```\n' : '```yaml\nruntime: claude\napp: enabled\n```\n')
  if (options.noState !== true) {
    const payload = join(dir, 'review-payload.json')
    await writeFile(payload, JSON.stringify({ event: 'COMMENT', body: 'walkthrough', comments: [] }))
    const created = await runCli(
      ['run-state', 'create', '--pr', '13', '--repo', REPO, '--base', 'main', '--head', 'feature/x', '--head-sha', SHA,
        '--runtime', 'claude', '--reviewer-login', 'none'],
      { env },
    )
    assert.equal(created.code, 0, created.stderr)
    const posted = await runCli(
      ['post-review', '--repo', REPO, '--pr', '13', '--commit', SHA, '--round', '1', '--kind', 'review',
        '--payload', payload, '--config', config],
      { env },
    )
    assert.equal(posted.code, 0, posted.stderr)
  }
  const ledger = join(dir, 'findings.json')
  await writeFile(ledger, JSON.stringify(options.ledger ?? LEDGER))
  const recheck = join(dir, 'recheck-r1.json')
  if (options.recheck !== undefined) await writeFile(recheck, JSON.stringify(options.recheck))
  const before = (await gh.calls()).length
  // Answer the calls that follow: the PR's comments as listed, and new ids.
  const github = (comments: Inline[], issueComments = '', extra: FakeGhResponse[] = []) =>
    gh.respond([
      ...extra,
      { match: 'pulls/13 --jq .user.login', stdout: `${options.author ?? 'alilloig'}\n` },
      { match: '/replies --input', stdout: JSON.stringify({ id: 300 }) },
      { match: 'pulls/13/comments', stdout: inline(...comments) },
      { match: 'issues/13/comments --input', stdout: JSON.stringify({ id: 900 }) },
      { match: 'issues/13/comments', stdout: issueComments },
      ME,
    ])
  await github(FINDINGS)
  const reply = (round: number, ...extra: string[]) =>
    runCli(['reply', '--repo', REPO, '--pr', '13', '--round', String(round), '--ledger', ledger, '--config', replyConfig,
      ...(options.recheck !== undefined ? ['--recheck', recheck] : []), ...extra], { env })
  const calls = async () => (await gh.calls()).slice(before)
  const requests = (): FakeApiRequest[] => app?.api.requests ?? []
  return { reply, calls, github, requests }
}

test('round 1 answers each inline finding in its thread and every finding in one PR comment', async (t) => {
  const s = await setup(t)
  const { code, stdout, stderr } = await s.reply(1)
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), {
    round: 1, replied: ['F1', 'F2'], skipped: [], walkthrough: ['F3'], comment: { id: 900, posted: true },
  })
  const calls = await s.calls()
  assert.deepEqual(calls.map((c) => c.argv), [USER, COMMENTS, replyTo(101), replyTo(102), ISSUE_COMMENTS, COMMENT_POST])
  assert.deepEqual(JSON.parse(calls[2]!.stdin), {
    body: 'ACCEPT: sanitised in the fix commit\n\n<!-- hero-forge:review-pipeline pr=13 round=1 kind=reply id=F1 -->',
  })
  assert.deepEqual(JSON.parse(calls[3]!.stdin), { body: 'REFUTE: out of scope | see #6\n\n<!-- hero-forge:review-pipeline pr=13 round=1 kind=reply id=F2 -->' })
  assert.deepEqual(JSON.parse(calls[5]!.stdin), { body: SUMMARY_1 })
  assert.ok(calls.every((c) => c.gh_token === null))
})

test('a re-run posts nothing that is already on the PR', async (t) => {
  const s = await setup(t)
  await s.github(
    [
      ...FINDINGS,
      { id: 201, reply_to: 101, body: 'ACCEPT: ...\n\n<!-- hero-forge:review-pipeline pr=13 round=1 kind=reply id=F1 -->' },
    ],
    `${JSON.stringify({ id: 777, login: 'alilloig', body: SUMMARY_1 })}\n`,
  )
  const { code, stdout } = await s.reply(1)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), {
    round: 1, replied: ['F2'], skipped: ['F1'], walkthrough: ['F3'], comment: { id: 777, posted: false },
  })
  assert.deepEqual((await s.calls()).map((c) => c.argv), [USER, COMMENTS, replyTo(102), ISSUE_COMMENTS])
})

test("the adjudication comment of an earlier run on the same PR (another review) does not count: this run posts its own", async (t) => {
  const s = await setup(t)
  const earlier = SUMMARY_1.replace(adjudicationMarker(1), adjudicationMarker(1, 444))
  await s.github(FINDINGS, `${JSON.stringify({ id: 777, login: 'alilloig', body: earlier })}\n`)
  const { code, stdout } = await s.reply(1)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout).comment, { id: 900, posted: true })
  assert.deepEqual(JSON.parse((await s.calls()).at(-1)!.stdin), { body: SUMMARY_1 })
})

test('a copied marker from someone else does not count as our answer', async (t) => {
  const s = await setup(t)
  const copied = '<!-- hero-forge:review-pipeline pr=13 round=1 kind=reply id=F1 -->'
  await s.github(
    [...FINDINGS, { id: 201, reply_to: 101, login: 'mallory', body: copied }],
    `${JSON.stringify({ id: 778, login: 'mallory', body: SUMMARY_1 })}\n`,
  )
  const { stdout } = await s.reply(1)
  assert.deepEqual(JSON.parse(stdout).replied, ['F1', 'F2'])
  assert.deepEqual(JSON.parse(stdout).comment, { id: 900, posted: true })
})

test('round 2 answers only what the round 1 re-check left open, plus new ledger entries', async (t) => {
  const s = await setup(t, {
    ledger: [
      LEDGER[0],
      { ...LEDGER[1], decision: 'ACCEPT', reason: 'handled the case after all' },
      LEDGER[2],
      { id: 'F4', where: 'src/d.ts:7', finding: 'leak', decision: 'ACCEPT', reason: 'closed the handle' },
    ],
    recheck: {
      items: [
        { id: 'F1', status: 'fixed', reason: 'ok' },
        { id: 'F2', status: 'open', reason: 'the refutation does not hold' },
        { id: 'F3', status: 'fixed', reason: 'ok' },
        { id: 'MISSING-1', status: 'open', reason: 'F4 has no ledger entry' },
      ],
    },
  })
  await s.github([...FINDINGS, { id: 105, body: '**F4** (Standards, bug, high, 1/2 pairs) ...' }])
  const { code, stdout, stderr } = await s.reply(2)
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), {
    round: 2, replied: ['F2', 'F4'], skipped: [], walkthrough: [], comment: { id: 900, posted: true },
  })
  const calls = await s.calls()
  assert.deepEqual(calls.map((c) => c.argv), [USER, COMMENTS, replyTo(102), replyTo(105), ISSUE_COMMENTS, COMMENT_POST])
  assert.deepEqual(JSON.parse(calls[2]!.stdin), {
    body: 'ACCEPT: handled the case after all\n\n<!-- hero-forge:review-pipeline pr=13 round=2 kind=reply id=F2 -->',
  })
  assert.match(JSON.parse(calls[5]!.stdin).body, /^## Adjudication: round 2\n[^]*\| F2 \|[^]*\| F4 \|[^]*kind=adjudication review=555 -->$/)
  assert.doesNotMatch(JSON.parse(calls[5]!.stdin).body, /\| F1 \|/)
})

test('a finding with no decision or no reason is refused before any gh call', async (t) => {
  const s = await setup(t, { ledger: [LEDGER[0], { ...LEDGER[1], decision: '' }, { ...LEDGER[2], reason: '' }] })
  const { code, stdout, stderr } = await s.reply(1)
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, 'review.ts reply: every finding needs a decision (ACCEPT or REFUTE) and a reason first: F2, F3\n')
  assert.deepEqual(await s.calls(), [])
})

test('a ledger reason that holds a token is refused before any gh call', async (t) => {
  const token = `ghs_${'Z9'.repeat(18)}`
  const s = await setup(t, { ledger: [LEDGER[0], { ...LEDGER[1], reason: `token ${token}` }, LEDGER[2]] })
  const { code, stdout, stderr } = await s.reply(1)
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.ok(stderr.includes('contains what looks like a GitHub token. Nothing was posted'), stderr)
  assert.ok(!stderr.includes(token))
  assert.deepEqual(await s.calls(), [])
})

for (const [name, reason] of [
  ['after a newline', `see\nghs_${'Z9'.repeat(18)}`],
  ['inside an HTML comment', `ok <!--ghs_${'Z9'.repeat(18)}-->`],
  ['with a zero-width character in its prefix', `gh\uFEFFs_${'Z9'.repeat(18)}`],
]) {
  test(`a ledger reason with a token ${name} is refused before any gh call`, async (t) => {
    const s = await setup(t, { ledger: [LEDGER[0], { ...LEDGER[1], reason }, LEDGER[2]] })
    const { code, stdout, stderr } = await s.reply(1)
    assert.equal(code, 1)
    assert.equal(stdout, '')
    assert.ok(stderr.includes('contains what looks like a GitHub token. Nothing was posted'), stderr)
    assert.deepEqual(await s.calls(), [])
  })
}

test('a ledger where that holds a token is refused before any gh call', async (t) => {
  const s = await setup(t, { ledger: [LEDGER[0], { ...LEDGER[1], where: `src/b.ts:12\nghp_${'Q1'.repeat(18)}` }, LEDGER[2]] })
  const { code, stderr } = await s.reply(1)
  assert.equal(code, 1)
  assert.ok(stderr.includes('looks like a GitHub token'), stderr)
  assert.deepEqual(await s.calls(), [])
})

test('a ledger reason that holds the pipeline marker is refused before any gh call', async (t) => {
  const s = await setup(t, {
    ledger: [LEDGER[0], { ...LEDGER[1], reason: `fine ${adjudicationMarker(1)}` }, LEDGER[2]],
  })
  const { code, stderr } = await s.reply(1)
  assert.equal(code, 1)
  assert.match(stderr, /contains the marker "hero-forge:review-pipeline", which only the helper CLI writes/)
  assert.deepEqual(await s.calls(), [])
})

test('a reply marker that is not the last line of a comment does not count as our answer', async (t) => {
  const s = await setup(t)
  const copied = { id: 401, body: `${replyMarker(1, 'F1')}\nquoted above my own words`, reply_to: 101 }
  await s.github([...FINDINGS, copied])
  const { code, stdout } = await s.reply(1)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout).replied, ['F1', 'F2'])
})

test('a posted finding the ledger lacks is refused before any reply posts', async (t) => {
  const s = await setup(t, { ledger: [LEDGER[0], LEDGER[2]] })
  const { code, stderr } = await s.reply(1)
  assert.equal(code, 1)
  assert.match(stderr, /^review\.ts reply: F2 is posted inline \(comment 102\) but is not in the ledger: add its entry/)
  assert.deepEqual((await s.calls()).map((c) => c.argv), [USER, COMMENTS])
})

test('GitHub rejecting a reply exits 1; the replies before it stay, so a re-run continues', async (t) => {
  const s = await setup(t)
  await s.github(FINDINGS, '', [{ match: 'comments/102/replies', stderr: 'HTTP 404\n', exit: 1 }])
  const { code, stderr } = await s.reply(1)
  assert.equal(code, 1)
  assert.match(stderr, /^review\.ts reply: GitHub rejected the reply to F2 \(comment 102\): HTTP 404/)
  assert.deepEqual((await s.calls()).map((c) => c.argv), [USER, COMMENTS, replyTo(101), replyTo(102)])
})

test('without a run state it exits 3 and posts nothing', async (t) => {
  const s = await setup(t, { noState: true })
  const { code, stderr } = await s.reply(1)
  assert.equal(code, 3)
  assert.match(stderr, /no run state for PR #13/)
  assert.deepEqual(await s.calls(), [])
})

test('round 2 without the last re-check is refused before any gh call: it would answer every finding again', async (t) => {
  const s = await setup(t)
  const { code, stdout, stderr } = await s.reply(2)
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(
    stderr,
    /^review\.ts reply: --round 2 needs --recheck <recheck-r1\.json>: a later round answers only what the last re-check left open\n/,
  )
  assert.deepEqual(await s.calls(), [])
})

test('round 1 with a re-check is refused: there is no earlier re-check in round 1', async (t) => {
  const s = await setup(t, { recheck: { items: [] } })
  const { code, stderr } = await s.reply(1)
  assert.equal(code, 2)
  assert.match(stderr, /^review\.ts reply: --recheck goes with round 2 and later \(round 1 answers the whole ledger\)\n/)
  assert.deepEqual(await s.calls(), [])
})

test('bad arguments are a usage error (exit 2)', async (t) => {
  const s = await setup(t)
  for (const extra of [['--round', '0'], ['--bogus']]) {
    assert.equal((await s.reply(1, ...extra)).code, 2, extra.join(' '))
  }
  assert.equal((await runCli(['reply', '--repo', REPO, '--pr', '13', '--round', '1'])).code, 2)
  assert.deepEqual(await s.calls(), [])
})

const AUTHOR = ['api', `repos/${REPO}/pulls/13`, '--jq', '.user.login']
const BOT = 'contract-implementer[bot]'

test('on a PR the Implementer App opened, every reply and the comment post as the App, with no token printed', async (t) => {
  const s = await setup(t, { app: {}, author: BOT })
  // F1 already has the App's own answer: a re-run of an AFK reply skips it.
  await s.github([...FINDINGS, { id: 201, reply_to: 101, login: BOT, body: `ACCEPT: ...\n\n${replyMarker(1, 'F1')}` }])
  const { code, stdout, stderr } = await s.reply(1)
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.ok(!stdout.includes(IMPLEMENTER_TOKEN))
  assert.deepEqual(JSON.parse(stdout), {
    round: 1, replied: ['F2'], skipped: ['F1'], walkthrough: ['F3'], comment: { id: 900, posted: true },
  })
  const calls = await s.calls()
  assert.deepEqual(calls.map((c) => c.argv), [AUTHOR, COMMENTS, replyTo(102), ISSUE_COMMENTS, COMMENT_POST])
  assert.equal(calls[0]!.gh_token, null)
  assert.ok(calls.slice(1).every((c) => c.gh_token === IMPLEMENTER_TOKEN))
  assert.deepEqual(JSON.parse(calls[4]!.stdin), { body: SUMMARY_1 })
})

test('on a PR a human opened, reply posts as the user and mints no App token, also with "app: enabled"', async (t) => {
  const s = await setup(t, { app: {} })
  const { code } = await s.reply(1)
  assert.equal(code, 0)
  const calls = await s.calls()
  assert.deepEqual(calls.map((c) => c.argv), [AUTHOR, USER, COMMENTS, replyTo(101), replyTo(102), ISSUE_COMMENTS, COMMENT_POST])
  assert.ok(calls.every((c) => c.gh_token === null))
  assert.deepEqual(s.requests(), [])
})

test("on a PR another App opened, reply posts as the user", async (t) => {
  const s = await setup(t, { app: {}, author: 'dependabot[bot]' })
  const { code } = await s.reply(1)
  assert.equal(code, 0)
  const calls = await s.calls()
  assert.deepEqual(calls.map((c) => c.argv), [AUTHOR, USER, COMMENTS, replyTo(101), replyTo(102), ISSUE_COMMENTS, COMMENT_POST])
  assert.ok(calls.every((c) => c.gh_token === null))
})

test('on a PR an App opened, a broken Implementer App exits 4 and posts nothing, as the App or as the user', async (t) => {
  const s = await setup(t, { app: { broken: true }, author: BOT })
  const { code, stdout, stderr } = await s.reply(1)
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts reply: the implementer App is enabled but its env file .*implementer-app\.env does not exist/)
  assert.deepEqual((await s.calls()).map((c) => c.argv), [AUTHOR])
})
