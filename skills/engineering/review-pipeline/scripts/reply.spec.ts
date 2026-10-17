import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeGh, runCli, tempDir, type FakeGhResponse } from './test-helpers.ts'

const SHA = 'c'.repeat(40)
const REPO = 'contract-hero/hero-pocock'
const USER = ['api', 'user', '--jq', '.login']
const ME: FakeGhResponse = { match: 'api user', stdout: 'alilloig\n' }
const COMMENTS = [
  'api', '--paginate', '--jq', '.[] | {id, in_reply_to_id, pull_request_review_id, login: .user.login, body}',
  `repos/${REPO}/pulls/13/comments`,
]
const ISSUE_COMMENTS = ['api', '--paginate', '--jq', '.[] | {id, body, login: .user.login}', `repos/${REPO}/issues/13/comments`]
const replyTo = (comment: number) => ['api', '-X', 'POST', `repos/${REPO}/pulls/13/comments/${comment}/replies`, '--input', '-']
const COMMENT_POST = ['api', '-X', 'POST', `repos/${REPO}/issues/13/comments`, '--input', '-']
const marker = (round: number, kind: string) => `<!-- hero-pocock:review-pipeline pr=13 round=${round} kind=${kind} -->`

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
  marker(1, 'adjudication'),
].join('\n')

type Setup = { ledger?: unknown; recheck?: unknown; noState?: boolean }

// A PR with the pipeline's round 1 review (id 555) recorded in run state,
// and a ledger. `reply(round)` runs the subcommand.
async function setup(t: Parameters<typeof tempDir>[0], options: Setup = {}) {
  const dir = await tempDir(t)
  const gh = await fakeGh(dir, [{ match: '--input', stdout: JSON.stringify({ id: 555 }) }, ME])
  const env = { ...gh.env, HERO_POCOCK_STATE_DIR: join(dir, 'state') }
  if (options.noState !== true) {
    const config = join(dir, 'review.md')
    await writeFile(config, '```yaml\nruntime: claude\n```\n')
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
      { match: '/replies --input', stdout: JSON.stringify({ id: 300 }) },
      { match: 'pulls/13/comments', stdout: inline(...comments) },
      { match: 'issues/13/comments --input', stdout: JSON.stringify({ id: 900 }) },
      { match: 'issues/13/comments', stdout: issueComments },
      ME,
    ])
  await github(FINDINGS)
  const reply = (round: number, ...extra: string[]) =>
    runCli(['reply', '--repo', REPO, '--pr', '13', '--round', String(round), '--ledger', ledger,
      ...(options.recheck !== undefined ? ['--recheck', recheck] : []), ...extra], { env })
  const calls = async () => (await gh.calls()).slice(before)
  return { reply, calls, github }
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
    body: 'ACCEPT: sanitised in the fix commit\n\n<!-- hero-pocock:review-pipeline pr=13 round=1 kind=reply id=F1 -->',
  })
  assert.deepEqual(JSON.parse(calls[3]!.stdin), { body: 'REFUTE: out of scope | see #6\n\n<!-- hero-pocock:review-pipeline pr=13 round=1 kind=reply id=F2 -->' })
  assert.deepEqual(JSON.parse(calls[5]!.stdin), { body: SUMMARY_1 })
  assert.ok(calls.every((c) => c.gh_token === null))
})

test('a re-run posts nothing that is already on the PR', async (t) => {
  const s = await setup(t)
  await s.github(
    [
      ...FINDINGS,
      { id: 201, reply_to: 101, body: 'ACCEPT: ...\n\n<!-- hero-pocock:review-pipeline pr=13 round=1 kind=reply id=F1 -->' },
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

test('a copied marker from someone else does not count as our answer', async (t) => {
  const s = await setup(t)
  const copied = '<!-- hero-pocock:review-pipeline pr=13 round=1 kind=reply id=F1 -->'
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
    body: 'ACCEPT: handled the case after all\n\n<!-- hero-pocock:review-pipeline pr=13 round=2 kind=reply id=F2 -->',
  })
  assert.match(JSON.parse(calls[5]!.stdin).body, /^## Adjudication: round 2\n[^]*\| F2 \|[^]*\| F4 \|[^]*kind=adjudication -->$/)
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

test('bad arguments are a usage error (exit 2)', async (t) => {
  const s = await setup(t)
  for (const extra of [['--round', '0'], ['--bogus']]) {
    assert.equal((await s.reply(1, ...extra)).code, 2, extra.join(' '))
  }
  assert.equal((await runCli(['reply', '--repo', REPO, '--pr', '13', '--round', '1'])).code, 2)
  assert.deepEqual(await s.calls(), [])
})
