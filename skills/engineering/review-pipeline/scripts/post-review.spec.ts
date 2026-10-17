import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fakeGh, runCli, tempDir, type FakeGhResponse } from './test-helpers.ts'

const SHA = 'c'.repeat(40)
const MARKER = '<!-- hero-pocock:review-pipeline pr=13 round=1 kind=review -->'
const LIST = ['api', '--paginate', '--jq', '.[] | {id, body, commit_id, login: .user.login}', 'repos/contract-hero/hero-pocock/pulls/13/reviews']
const USER = ['api', 'user', '--jq', '.login']
const ME: FakeGhResponse = { match: 'api user', stdout: 'alilloig\n' }

// One line of the review list, as `gh api --paginate --jq` prints it.
function listed(...reviews: { id: number; body: string; commit_id?: string; login?: string }[]): string {
  return reviews.map((r) => `${JSON.stringify({ commit_id: SHA, login: 'alilloig', ...r })}\n`).join('')
}
const POST = ['api', '-X', 'POST', 'repos/contract-hero/hero-pocock/pulls/13/reviews', '--input', '-']

const PAYLOAD = {
  event: 'COMMENT',
  body: '## Review pipeline: round 1',
  comments: [
    {
      path: 'src/a.ts',
      line: 42,
      side: 'RIGHT',
      body: '**F1** (Standards, bug, high, 2/2 pairs) Untrusted input reaches the sink.\n\n```suggestion\nconst v = sanitize(input);\n```',
    },
    { path: 'src/b.ts', start_line: 10, start_side: 'RIGHT', line: 12, side: 'RIGHT', body: '**F2** (Spec, spec-missing, medium, 1/2 pairs) ...' },
  ],
}

const CONFIG = '# Review pipeline\n\n```yaml\nruntime: claude\n```\n'

type Setup = {
  responses?: FakeGhResponse[]
  payload?: unknown
  config?: string | null
  state?: Record<string, unknown> | string | null
}

// A temp dir with a config, a payload file, a fake gh and a state root.
async function setup(t: Parameters<typeof tempDir>[0], options: Setup = {}) {
  const dir = await tempDir(t)
  const gh = await fakeGh(dir, [...(options.responses ?? []), ME])
  const configPath = join(dir, 'review.md')
  if (options.config !== null) await writeFile(configPath, options.config ?? CONFIG)
  const payloadPath = join(dir, 'review-payload.json')
  const payload = options.payload ?? PAYLOAD
  await writeFile(payloadPath, typeof payload === 'string' ? payload : JSON.stringify(payload))
  const root = join(dir, 'state')
  const stateFile = join(root, 'pr-13', 'state.json')
  const env = { ...gh.env, HERO_POCOCK_STATE_DIR: root }
  if (options.state !== null) {
    if (typeof options.state === 'string') {
      await mkdir(join(root, 'pr-13'), { recursive: true })
      await writeFile(stateFile, options.state)
    } else {
      const created = await runCli(
        ['run-state', 'create', '--pr', '13', '--repo', 'contract-hero/hero-pocock', '--base', 'main', '--head', 'feature/x',
          '--head-sha', SHA, '--runtime', 'claude', '--reviewer-login', 'none'],
        { env },
      )
      assert.equal(created.code, 0, created.stderr)
    }
  }
  const post = (...extra: string[]) =>
    runCli(
      ['post-review', '--repo', 'contract-hero/hero-pocock', '--pr', '13', '--commit', SHA, '--round', '1',
        '--kind', 'review', '--payload', payloadPath, '--config', configPath, ...extra],
      { env },
    )
  const reviews = async () => JSON.parse(await readFile(stateFile, 'utf8')).reviews
  return { gh, post, reviews, stateFile, env, configPath, dir }
}

test('a COMMENT review with inline suggestions posts once, as the user, and is recorded', async (t) => {
  const s = await setup(t, {
    responses: [
      { match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 555, state: 'COMMENTED' }) },
      { match: '--paginate', stdout: listed({ id: 1, body: 'an older human review', login: 'someone' }) },
    ],
  })
  const { code, stdout, stderr } = await s.post()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { posted: true, id: 555, as: 'user', event: 'COMMENT', round: 1, kind: 'review' })

  const calls = await s.gh.calls()
  assert.deepEqual(calls.map((c) => c.argv), [USER, LIST, POST])
  assert.deepEqual(calls.map((c) => c.gh_token), [null, null, null])
  assert.deepEqual(JSON.parse(calls[2]!.stdin), {
    ...PAYLOAD,
    body: `${PAYLOAD.body}\n\n${MARKER}`,
    commit_id: SHA,
  })
  assert.deepEqual(await s.reviews(), [{ round: 1, kind: 'review', id: 555, commit: SHA, as: 'user' }])
})

test('a review the run state already records is not posted again, and gh is not called', async (t) => {
  const s = await setup(t, { responses: [{ match: '--input', stdout: JSON.stringify({ id: 555 }) }] })
  assert.equal((await s.post()).code, 0)
  const again = await s.post()
  assert.equal(again.code, 0)
  assert.deepEqual(JSON.parse(again.stdout), { posted: false, duplicate: true, id: 555 })
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [USER, LIST, POST])
  assert.equal((await s.reviews()).length, 1)
})

test('when the run state lost the record, our own marked review on the same commit is found and recorded', async (t) => {
  const s = await setup(t, {
    responses: [{ match: '--paginate', stdout: listed({ id: 777, body: `walkthrough\n\n${MARKER}` }) }],
  })
  const { code, stdout } = await s.post()
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { posted: false, duplicate: true, id: 777 })
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [USER, LIST])
  assert.deepEqual(await s.reviews(), [{ round: 1, kind: 'review', id: 777, commit: SHA, as: 'user' }])
})

const NOT_OURS = [
  ['a marker in a review by someone else', { login: 'mallory' }],
  ['a marker in our own review on another commit', { commit_id: 'd'.repeat(40) }],
  ['a marker for another round', { body: MARKER.replace('round=1', 'round=11') }],
] as const

for (const [name, change] of NOT_OURS) {
  test(`${name} does not count as a duplicate`, async (t) => {
    const s = await setup(t, {
      responses: [
        { match: '--input', stdout: JSON.stringify({ id: 556 }) },
        { match: '--paginate', stdout: listed({ id: 9, body: `copied\n\n${MARKER}`, ...change }) },
      ],
    })
    const { code, stdout } = await s.post()
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), { posted: true, id: 556, as: 'user', event: 'COMMENT', round: 1, kind: 'review' })
    assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [USER, LIST, POST])
  })
}

test('without a run state the review still posts, and no state is written', async (t) => {
  const s = await setup(t, { state: null, responses: [{ match: '--input', stdout: JSON.stringify({ id: 1 }) }] })
  const { code } = await s.post()
  assert.equal(code, 0)
  await assert.rejects(readFile(s.stateFile, 'utf8'), { code: 'ENOENT' })
})

test('GitHub rejecting the review exits 1 with its message and records nothing', async (t) => {
  const s = await setup(t, {
    responses: [{ match: '--input', stderr: 'gh: Pull request review thread line must be part of the diff (HTTP 422)\n', exit: 1 }],
  })
  const { code, stdout, stderr } = await s.post()
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts post-review: GitHub rejected the review: .*HTTP 422/)
  assert.deepEqual(await s.reviews(), [])
})

test('listing the existing reviews failing exits 1 and posts nothing', async (t) => {
  const s = await setup(t, { responses: [{ match: '--paginate', stderr: 'HTTP 404\n', exit: 1 }] })
  const { code, stderr } = await s.post()
  assert.equal(code, 1)
  assert.match(stderr, /cannot list the reviews of PR #13/)
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [USER, LIST])
})

for (const [kind, secret] of [
  ['a GitHub token', `ghp_${'A1b2'.repeat(9)}`],
  ['a GitHub fine-grained token', `github_pat_${'x9'.repeat(15)}`],
  ['a private key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
  ['an API key (sk-)', `sk-proj-${'q'.repeat(24)}`],
  ['a Slack token', 'xoxb-1234567890-abcdef'],
]) {
  test(`a payload that holds ${kind} is refused before any gh call`, async (t) => {
    const comment = { ...PAYLOAD.comments[0], body: `**F1** leaked: ${secret}` }
    const s = await setup(t, { payload: { ...PAYLOAD, comments: [comment, PAYLOAD.comments[1]] } })
    const { code, stdout, stderr } = await s.post()
    assert.equal(code, 1)
    assert.equal(stdout, '')
    assert.ok(stderr.includes(`contains what looks like ${kind}. Nothing was posted`), stderr)
    assert.ok(!stderr.includes(secret), 'the secret is echoed')
    assert.deepEqual(await s.gh.calls(), [])
  })
}

const TOKEN = `ghp_${'A1b2'.repeat(9)}`
for (const [name, text] of [
  ['after a newline', `Found it:\n${TOKEN}`],
  ['inside an HTML comment', `ok <!--${TOKEN}-->`],
  ['split by an HTML comment', `ghp<!-- hidden -->_${'A1b2'.repeat(9)}`],
  ['with a zero-width character in its prefix', `gh\u200Bp_${'A1b2'.repeat(9)}`],
  ['in a suggestion block', '**F1** fix\n\n```suggestion\nconst t = "' + TOKEN + '"\n```'],
]) {
  test(`a GitHub token ${name} is refused before any gh call`, async (t) => {
    const comment = { ...PAYLOAD.comments[0], body: text }
    const s = await setup(t, { payload: { ...PAYLOAD, body: name === 'after a newline' ? text : PAYLOAD.body, comments: [comment] } })
    const { code, stdout, stderr } = await s.post()
    assert.equal(code, 1)
    assert.equal(stdout, '')
    assert.ok(stderr.includes('contains what looks like a GitHub token. Nothing was posted'), stderr)
    assert.deepEqual(await s.gh.calls(), [])
  })
}

test('a payload that only names a token prefix still posts', async (t) => {
  const s = await setup(t, {
    payload: { ...PAYLOAD, body: 'Scan for ghp_ and sk- prefixes', comments: [] },
    responses: [{ match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 556 }) }],
  })
  const { code, stderr } = await s.post()
  assert.equal(stderr, '')
  assert.equal(code, 0)
})

test('not knowing who the gh user is exits 1 and posts nothing', async (t) => {
  const s = await setup(t, { responses: [{ match: 'api user', stderr: 'gh: not logged in\n', exit: 1 }] })
  const { code, stderr } = await s.post()
  assert.equal(code, 1)
  assert.match(stderr, /cannot read the gh user: gh: not logged in/)
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [USER])
})

const GATED = ['--ledger', 'findings.json', '--recheck', 'recheck-r1.json']

const REFUSED = [
  ['a review that approves', [], { ...PAYLOAD, event: 'APPROVE' }, /--kind review posts COMMENT only/],
  ['a recheck that requests changes', ['--kind', 'recheck', ...GATED], { ...PAYLOAD, event: 'REQUEST_CHANGES' }, /--kind recheck posts COMMENT only/],
  ['a verdict that only comments', ['--kind', 'verdict', ...GATED], PAYLOAD, /--kind verdict posts APPROVE or REQUEST_CHANGES only/],
  ['an unknown event', [], { ...PAYLOAD, event: 'LGTM' }, /payload\.event must be COMMENT, APPROVE or REQUEST_CHANGES/],
  ['a body that is not text', [], { ...PAYLOAD, body: 3 }, /payload\.body must be a string/],
  ['comments that are not a list', [], { ...PAYLOAD, comments: {} }, /payload\.comments must be an array/],
  ['a comment with no path', [], { ...PAYLOAD, comments: [{ line: 1, side: 'RIGHT', body: 'x' }] }, /payload\.comments\[0\]\.path must be a string/],
  ['a comment on line 0', [], { ...PAYLOAD, comments: [{ path: 'a', line: 0, side: 'RIGHT', body: 'x' }] }, /payload\.comments\[0\]\.line must be a positive whole number/],
  ['a comment on a bad side', [], { ...PAYLOAD, comments: [{ path: 'a', line: 1, side: 'UP', body: 'x' }] }, /payload\.comments\[0\]\.side must be RIGHT or LEFT/],
  ['a range that ends before it starts', [], { ...PAYLOAD, comments: [{ path: 'a', start_line: 5, start_side: 'RIGHT', line: 5, side: 'RIGHT', body: 'x' }] }, /payload\.comments\[0\]\.start_line must be less than line/],
  ['a range with no start_side', [], { ...PAYLOAD, comments: [{ path: 'a', start_line: 1, line: 5, side: 'RIGHT', body: 'x' }] }, /payload\.comments\[0\]\.start_side must be RIGHT or LEFT/],
  ['a payload that is not JSON', [], '{nope', /payload .* is not valid JSON/],
] as const

for (const [name, extra, payload, message] of REFUSED) {
  test(`${name} is refused with exit 1 before any gh call`, async (t) => {
    const s = await setup(t, { payload })
    const { code, stdout, stderr } = await s.post(...extra)
    assert.equal(code, 1)
    assert.equal(stdout, '')
    assert.match(stderr, /^review\.ts post-review: /)
    assert.match(stderr, message)
    assert.deepEqual(await s.gh.calls(), [])
  })
}

const BROKEN = [
  ['a missing config', null, /no review config/],
  ['an invalid config', '```yaml\nruntime: gemini\n```\n', /unknown runtime "gemini"/],
  ['an App identity (not built yet)', '```yaml\nruntime: claude\napp: enabled\n```\n', /App identity is not built yet/],
] as const

for (const [name, config, message] of BROKEN) {
  test(`${name} exits 4 and posts nothing`, async (t) => {
    const s = await setup(t, { config })
    const { code, stderr } = await s.post()
    assert.equal(code, 4)
    assert.match(stderr, /^review\.ts post-review: /)
    assert.match(stderr, message)
    assert.deepEqual(await s.gh.calls(), [])
  })
}

test('a corrupt run state exits 4 and posts nothing', async (t) => {
  const s = await setup(t, { state: '{not json' })
  const { code, stderr } = await s.post()
  assert.equal(code, 4)
  assert.match(stderr, /corrupt state file/)
  assert.deepEqual(await s.gh.calls(), [])
})

test('bad arguments are a usage error (exit 2)', async (t) => {
  const s = await setup(t)
  const usageErrors = [
    ['--kind', 'praise'], ['--round', '0'], ['--commit', 'abc'], ['--bogus'],
    ['--kind', 'recheck'], ['--kind', 'recheck', '--ledger', 'findings.json'], ['--kind', 'verdict', '--recheck', 'r.json'],
    GATED,
  ]
  for (const extra of usageErrors) {
    const { code } = await s.post(...extra)
    assert.equal(code, 2, extra.join(' '))
  }
  assert.equal((await runCli(['post-review'])).code, 2)
  assert.deepEqual(await s.gh.calls(), [])
})

// The gate: `--kind recheck` and `--kind verdict` check the re-check against
// the ledger and against the inline findings this pipeline posted.

const FIXED = 'e'.repeat(40)
const COMMENTS = [
  'api', '--paginate', '--jq', '.[] | {id, in_reply_to_id, pull_request_review_id, login: .user.login, body}',
  'repos/contract-hero/hero-pocock/pulls/13/comments',
]
const RECHECK_MARKER = '<!-- hero-pocock:review-pipeline pr=13 round=1 kind=recheck -->'

type Inline = { id: number; body: string; review?: number; reply_to?: number; login?: string }

// Lines of the inline comment list, as `gh api --paginate --jq` prints them.
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

// F1 and F2 are inline in review 555; F3 is a walkthrough item. A reply, and
// a human's comment in another review, are not findings.
const POSTED = inline(
  { id: 101, body: '**F1** (Standards, bug, high, 2/2 pairs) ...' },
  { id: 102, body: '**F2** (Spec, spec-missing, medium, 1/2 pairs) ...' },
  { id: 103, body: 'ACCEPT: fixed', reply_to: 101 },
  { id: 104, body: '**F9** looks off', review: 999, login: 'someone' },
)
const LEDGER = [
  { id: 'F1', where: 'src/a.ts:42', finding: 'unsanitised input', decision: 'ACCEPT', reason: 'sanitised' },
  { id: 'F2', where: 'src/b.ts:12', finding: 'missing case', decision: 'REFUTE', reason: 'out of scope per #6' },
  { id: 'F3', where: 'src/c.ts:3', finding: 'stale doc', decision: 'ACCEPT', reason: 'doc updated' },
]
const RECHECK = {
  items: [
    { id: 'F1', status: 'fixed', reason: 'sanitize() now wraps the input' },
    { id: 'F2', status: 'refutation_accepted', reason: '#6 leaves it out' },
    { id: 'F3', status: 'fixed', reason: 'doc matches' },
  ],
}
const TABLE = { event: 'COMMENT', body: '## Re-check: round 1', comments: [] }

type GateSetup = { ledger?: unknown; recheck?: unknown; posted?: string; noState?: boolean }

// A PR whose round 1 review (id 555) is posted and recorded, the ledger, and
// the re-check. `gated(kind)` posts that kind at the fix commit.
async function gateSetup(t: Parameters<typeof tempDir>[0], options: GateSetup = {}) {
  const s = await setup(t, {
    state: options.noState === true ? null : undefined,
    responses: [{ match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 555 }) }],
  })
  if (options.noState !== true) assert.equal((await s.post()).code, 0)
  const write = async (name: string, value: unknown) => {
    const path = join(s.dir, name)
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
    return path
  }
  const ledger = await write('findings.json', options.ledger ?? LEDGER)
  const recheck = await write('recheck-r1.json', options.recheck ?? RECHECK)
  const table = await write('recheck-payload.json', TABLE)
  const verdict = await write('verdict-payload.json', { ...TABLE, event: 'APPROVE' })
  await s.gh.respond([
    { match: 'pulls/13/comments', stdout: options.posted ?? POSTED },
    { match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 666 }) },
    ME,
  ])
  const before = (await s.gh.calls()).length
  const gated = (kind: string) =>
    runCli(
      ['post-review', '--repo', 'contract-hero/hero-pocock', '--pr', '13', '--commit', FIXED, '--round', '1',
        '--kind', kind, '--payload', kind === 'verdict' ? verdict : table, '--config', s.configPath,
        '--ledger', ledger, '--recheck', recheck],
      { env: s.env },
    )
  const calls = async () => (await s.gh.calls()).slice(before)
  return { ...s, gated, calls }
}

test('a passing re-check posts its COMMENT review at the fix commit and reports gate pass', async (t) => {
  const s = await gateSetup(t)
  const { code, stdout, stderr } = await s.gated('recheck')
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), {
    posted: true, id: 666, as: 'user', event: 'COMMENT', round: 1, kind: 'recheck', gate: 'pass', problems: [],
  })
  const calls = await s.calls()
  assert.deepEqual(calls.map((c) => c.argv), [COMMENTS, USER, LIST, POST])
  assert.deepEqual(JSON.parse(calls[3]!.stdin), { ...TABLE, body: `${TABLE.body}\n\n${RECHECK_MARKER}`, commit_id: FIXED })
  assert.deepEqual((await s.reviews()).map((r: { kind: string; id: number }) => [r.kind, r.id]), [['review', 555], ['recheck', 666]])
})

const FAILS = [
  ['an open item', {
    recheck: { items: [RECHECK.items[0], { id: 'F2', status: 'open', reason: 'the case still crashes' }, RECHECK.items[2]] },
  }, ['F2 is open: the case still crashes']],
  ['a posted finding the ledger lacks', {
    ledger: [LEDGER[0], LEDGER[2]],
    recheck: { items: [RECHECK.items[0], RECHECK.items[2], { id: 'MISSING-1', status: 'open', reason: 'F2 has no entry' }] },
  }, ['F2 is posted inline but is not in the ledger', 'MISSING-1 is in the re-check but not in the ledger', 'MISSING-1 is open: F2 has no entry']],
  ['a ledger entry the re-check skipped', {
    recheck: { items: [RECHECK.items[0], RECHECK.items[1]] },
  }, ['F3 is in the ledger but not in the re-check']],
  ['a finding with no decision', {
    ledger: [LEDGER[0], { ...LEDGER[1], decision: '' }, LEDGER[2]],
  }, ['F2 has no decision (ACCEPT or REFUTE)']],
  ['one ledger entry for two inline comments', {
    posted: inline({ id: 101, body: '**F1** a' }, { id: 105, body: '**F1** b' }, { id: 102, body: '**F2** c' }),
  }, ['F1 is posted inline 2 times']],
  ['an inline comment with no finding id', {
    posted: inline({ id: 101, body: '**F1** a' }, { id: 102, body: '**F2** c' }, { id: 106, body: 'a stray note' }),
  }, ['inline comment 106 starts with no **F<n>** finding id']],
] as const

for (const [name, options, problems] of FAILS) {
  test(`${name} fails the gate, and the re-check COMMENT still posts`, async (t) => {
    const s = await gateSetup(t, options)
    const { code, stdout, stderr } = await s.gated('recheck')
    assert.equal(stderr, '')
    assert.equal(code, 0)
    const out = JSON.parse(stdout)
    assert.equal(out.posted, true)
    assert.equal(out.gate, 'fail')
    assert.deepEqual(out.problems, problems)
  })
}

test('a re-run of a posted re-check posts nothing and reports the same gate', async (t) => {
  const s = await gateSetup(t)
  assert.equal((await s.gated('recheck')).code, 0)
  const again = await s.gated('recheck')
  assert.equal(again.code, 0)
  assert.deepEqual(JSON.parse(again.stdout), { posted: false, duplicate: true, id: 666, gate: 'pass', problems: [] })
  assert.equal((await s.calls()).filter((c) => c.argv.includes('POST')).length, 1)
})

test('an APPROVE verdict on a failing gate exits 1 and posts nothing', async (t) => {
  const s = await gateSetup(t, { recheck: { items: [RECHECK.items[0], RECHECK.items[1]] } })
  const { code, stdout, stderr } = await s.gated('verdict')
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts post-review: the gate fails, so the PR cannot be approved: F3 is in the ledger but not in the re-check$/m)
  assert.deepEqual((await s.calls()).map((c) => c.argv), [COMMENTS])
})

test('an APPROVE verdict on a passing gate still needs the reviewer App', async (t) => {
  const s = await gateSetup(t)
  const { code, stderr } = await s.gated('verdict')
  assert.equal(code, 1)
  assert.match(stderr, /APPROVE\/REQUEST_CHANGES need the reviewer App/)
  assert.deepEqual((await s.calls()).map((c) => c.argv), [COMMENTS])
})

const BAD_FILES = [
  ['a re-check that is not JSON', { recheck: '{nope' }, /re-check file .* is not valid JSON/],
  ['a re-check item with an unknown status', { recheck: { items: [{ id: 'F1', status: 'done', reason: '' }] } }, /re-check file .*: items\[0\]\.status must be fixed, refutation_accepted or open/],
  ['a ledger that is not a list', { ledger: { F1: 'ACCEPT' } }, /ledger .* must be a JSON array/],
  ['a ledger with a duplicate id', { ledger: [LEDGER[0], LEDGER[0]] }, /ledger .*: duplicate id "F1"/],
  ['a ledger with an unknown decision', { ledger: [{ ...LEDGER[0], decision: 'REJECT' }] }, /ledger .*: \[0\]\.decision must be ACCEPT, REFUTE or empty/],
] as const

for (const [name, options, message] of BAD_FILES) {
  test(`${name} exits 1 before any gh call`, async (t) => {
    const s = await gateSetup(t, options)
    const { code, stderr } = await s.gated('recheck')
    assert.equal(code, 1)
    assert.match(stderr, message)
    assert.deepEqual(await s.calls(), [])
  })
}

test('the gate needs the run state: without one it exits 3 and posts nothing', async (t) => {
  const s = await gateSetup(t, { noState: true })
  const { code, stderr } = await s.gated('recheck')
  assert.equal(code, 3)
  assert.match(stderr, /no run state for PR #13/)
  assert.deepEqual(await s.calls(), [])
})
