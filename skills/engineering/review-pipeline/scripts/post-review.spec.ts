import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  appKey,
  fakeGh,
  fakeGitHubApi,
  runCli,
  tempDir,
  type FakeApiRoute,
  type FakeGhResponse,
  type FakeGitHubApi,
} from './test-helpers.ts'

const SHA = 'c'.repeat(40)
const MARKER = '<!-- hero-forge:review-pipeline pr=13 round=1 kind=review -->'
const LIST = ['api', '--paginate', '--jq', '.[] | {id, state, body, commit_id, login: .user.login}', 'repos/contract-hero/hero-forge/pulls/13/reviews']
const USER = ['api', 'user', '--jq', '.login']
const ME: FakeGhResponse = { match: 'api user', stdout: 'alilloig\n' }

// One line of the review list, as `gh api --paginate --jq` prints it.
function listed(...reviews: { id: number; body: string; commit_id?: string; login?: string; state?: string }[]): string {
  return reviews.map((r) => `${JSON.stringify({ state: 'COMMENTED', commit_id: SHA, login: 'alilloig', ...r })}\n`).join('')
}
const POST = ['api', '-X', 'POST', 'repos/contract-hero/hero-forge/pulls/13/reviews', '--input', '-']

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
const APP_CONFIG = '# Review pipeline\n\n```yaml\nruntime: claude\napp: enabled\n```\n'
const TOKEN = 'ghs_faketoken0123456789'
const BOT = 'hero-reviewer[bot]'

// GitHub's answers for a working reviewer App installed on the repo.
const APP_ROUTES: Record<string, FakeApiRoute> = {
  'GET /repos/contract-hero/hero-forge/installation': { status: 200, body: { id: 4242 } },
  'POST /app/installations/4242/access_tokens': { status: 201, body: { token: TOKEN } },
  'GET /app': { status: 200, body: { slug: 'hero-reviewer' } },
}

type Setup = {
  responses?: FakeGhResponse[]
  payload?: unknown
  config?: string | null
  state?: Record<string, unknown> | string | null
  // A reviewer App (config `app: enabled`, credentials, a fake GitHub API).
  app?: { routes?: Record<string, FakeApiRoute> }
}

// A temp dir with a config, a payload file, a fake gh and a state root, and
// with `app`, App credentials and a fake GitHub API that trusts their key.
async function setup(t: Parameters<typeof tempDir>[0], options: Setup = {}) {
  const dir = await tempDir(t)
  const gh = await fakeGh(dir, [...(options.responses ?? []), ME])
  const configPath = join(dir, 'review.md')
  if (options.config !== null) await writeFile(configPath, options.config ?? (options.app ? APP_CONFIG : CONFIG))
  const payloadPath = join(dir, 'review-payload.json')
  const payload = options.payload ?? PAYLOAD
  await writeFile(payloadPath, typeof payload === 'string' ? payload : JSON.stringify(payload))
  const root = join(dir, 'state')
  const stateFile = join(root, 'pr-13', 'state.json')
  const env: Record<string, string | undefined> = { ...gh.env, HERO_FORGE_STATE_DIR: root }
  let api: FakeGitHubApi | undefined
  if (options.app !== undefined) {
    const key = await appKey(dir)
    api = await fakeGitHubApi(t, key.publicKey, options.app.routes ?? APP_ROUTES)
    const envFile = join(dir, 'reviewer-app.env')
    await writeFile(envFile, `HERO_FORGE_REVIEWER_APP_ID=123456\nHERO_FORGE_REVIEWER_APP_KEY=${key.pem}\n`)
    env.HERO_FORGE_REVIEWER_APP_ENV = envFile
    env.HERO_FORGE_GITHUB_API_URL = api.url
  }
  if (options.state !== null) {
    if (typeof options.state === 'string') {
      await mkdir(join(root, 'pr-13'), { recursive: true })
      await writeFile(stateFile, options.state)
    } else {
      const created = await runCli(
        ['run-state', 'create', '--pr', '13', '--repo', 'contract-hero/hero-forge', '--base', 'main', '--head', 'feature/x',
          '--head-sha', SHA, '--runtime', 'claude', '--reviewer-login', options.app === undefined ? 'none' : BOT],
        { env },
      )
      assert.equal(created.code, 0, created.stderr)
    }
  }
  const post = (...extra: string[]) =>
    runCli(
      ['post-review', '--repo', 'contract-hero/hero-forge', '--pr', '13', '--commit', SHA, '--round', '1',
        '--kind', 'review', '--payload', payloadPath, '--config', configPath, ...extra],
      { env },
    )
  const reviews = async () => JSON.parse(await readFile(stateFile, 'utf8')).reviews
  const gates = async () => JSON.parse(await readFile(stateFile, 'utf8')).gates
  // Change fields of the state file in place (a run further on than `create`).
  const patch = async (over: Record<string, unknown>) => {
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    await writeFile(stateFile, JSON.stringify({ ...state, ...over }))
  }
  return { gh, post, reviews, gates, patch, stateFile, env, configPath, dir, api }
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
  assert.deepEqual(await s.reviews(), [{ round: 1, kind: 'review', id: 555, commit: SHA, as: 'user', event: 'COMMENT' }])
  assert.deepEqual(await s.gates(), [])
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
  assert.deepEqual(await s.reviews(), [{ round: 1, kind: 'review', id: 777, commit: SHA, as: 'user', event: 'COMMENT' }])
})

const NOT_OURS = [
  ['a marker in a review by someone else', { login: 'mallory' }],
  ['a marker in our own review on another commit', { commit_id: 'd'.repeat(40) }],
  ['a marker for another round', { body: MARKER.replace('round=1', 'round=11') }],
  ['a marker that is not the last line', { body: `${MARKER}\n\nmore text below the copied marker` }],
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

test('a gh that refuses a large review without reading it is a clean exit 1, not an EPIPE crash', async (t) => {
  const big = { ...PAYLOAD, body: `## Review pipeline: round 1\n\n${'A long walkthrough line.\n'.repeat(200000)}` }
  const s = await setup(t, {
    payload: big,
    responses: [{ match: '-X POST', stderr: 'HTTP 422: body too long', exit: 1, ignore_stdin: true }],
  })
  const { code, stdout, stderr } = await s.post()
  assert.equal(stdout, '')
  assert.equal(code, 1)
  assert.match(stderr, /^review\.ts post-review: GitHub rejected the review: HTTP 422: body too long\n$/)
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
  ['a JWT', `eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.${'s'.repeat(30)}`],
  ['an OAuth token in a credential file', `"refresh_token": "${'r'.repeat(12)}-${'Q7'.repeat(10)}"`],
  ['an OAuth token in a credential file', `access_token=ya29.${'a0Bc'.repeat(8)}`],
  ['an OAuth token in a credential file', `refresh_token: 1//${'0gXy'.repeat(8)}`],
] as [string, string][]) {
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

const LEAK = `ghp_${'A1b2'.repeat(9)}`
for (const [name, text] of [
  ['after a newline', `Found it:\n${LEAK}`],
  ['inside an HTML comment', `ok <!--${LEAK}-->`],
  ['split by an HTML comment', `ghp<!-- hidden -->_${'A1b2'.repeat(9)}`],
  ['with a zero-width character in its prefix', `gh\u200Bp_${'A1b2'.repeat(9)}`],
  ['in a suggestion block', '**F1** fix\n\n```suggestion\nconst t = "' + LEAK + '"\n```'],
  ['split by a soft hyphen', `gh\u00ADp_${'A1b2'.repeat(9)}`],
  ['split by a word joiner and a bidi mark', `g\u2060h\u200Fp_${'A1b2'.repeat(9)}`],
  ['in fullwidth letters', `\uFF47\uFF48\uFF50_${'A1b2'.repeat(9)}`],
  ['written with HTML entities', `&#103;&#x68;p&lowbar;${'A1b2'.repeat(9)}`],
  ['written with double-encoded entities', `&amp;#103;hp_${'A1b2'.repeat(9)}`],
  ['with a markdown backslash escape', `ghp\\_${'A1b2'.repeat(9)}`],
  ['split by an HTML tag', `gh<b></b>p_${'A1b2'.repeat(4)}<span>${'A1b2'.repeat(5)}</span>`],
  ['split by a tag with attributes', `ghp_<i class="x">${'A1b2'.repeat(9)}</i>`],
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

// Only the helper CLI writes the pipeline marker. A marker in agent-written
// text could pass for an earlier post, so it is refused wherever it appears.
for (const [name, change] of [
  ['the walkthrough body', (m: string) => ({ ...PAYLOAD, body: `## Review\n\n${m}` })],
  ['an inline comment body', (m: string) => ({ ...PAYLOAD, comments: [{ ...PAYLOAD.comments[0], body: `**F1** x ${m}` }] })],
] as const) {
  test(`a pipeline marker in ${name} is refused before any gh call`, async (t) => {
    const s = await setup(t, { payload: change(MARKER.replace('round=1', 'round=2')) })
    const { code, stdout, stderr } = await s.post()
    assert.equal(code, 1)
    assert.equal(stdout, '')
    assert.match(stderr, /contains the marker "hero-forge:review-pipeline", which only the helper CLI writes\. Nothing was posted/)
    assert.deepEqual(await s.gh.calls(), [])
  })
}

test('a marker tag written in another case is refused too', async (t) => {
  const s = await setup(t, { payload: { ...PAYLOAD, body: 'x <!-- HERO-FORGE:Review-Pipeline pr=13 -->' } })
  const { code, stderr } = await s.post()
  assert.equal(code, 1)
  assert.match(stderr, /contains the marker/)
})

test('a payload with an unknown top-level key is refused before any gh call', async (t) => {
  const s = await setup(t, { payload: { ...PAYLOAD, commit_id: 'd'.repeat(40) } })
  const { code, stdout, stderr } = await s.post()
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /payload has unknown keys: commit_id \(allowed: event, body, comments\)/)
  assert.deepEqual(await s.gh.calls(), [])
})

test('a token in an unexpected comment field is refused before any gh call', async (t) => {
  const comment = { ...PAYLOAD.comments[0], note: `ghp_${'A1b2'.repeat(9)}` }
  const s = await setup(t, { payload: { ...PAYLOAD, comments: [comment] } })
  const { code, stderr } = await s.post()
  assert.equal(code, 1)
  assert.match(stderr, /payload\.comments\[0\] has unknown keys: note/)
  assert.deepEqual(await s.gh.calls(), [])
})

test('the review sent to GitHub holds only the allowed fields', async (t) => {
  const s = await setup(t, { responses: [{ match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 557 }) }] })
  const { code, stderr } = await s.post()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const sent = JSON.parse((await s.gh.calls()).find((c) => c.argv.includes('POST'))!.stdin)
  assert.deepEqual(Object.keys(sent).sort(), ['body', 'comments', 'commit_id', 'event'])
  assert.deepEqual(Object.keys(sent.comments[0]).sort(), ['body', 'line', 'path', 'side'])
  assert.deepEqual(Object.keys(sent.comments[1]).sort(), ['body', 'line', 'path', 'side', 'start_line', 'start_side'])
})

test('a payload that only names a token prefix still posts', async (t) => {
  const s = await setup(t, {
    payload: {
      ...PAYLOAD,
      body: 'Scan for ghp_ and sk- prefixes, read access_token: process.env.REVIEWER_APP_TOKEN_NAME, and set refresh_token=${REFRESH_TOKEN_FROM_THE_VAULT}',
      comments: [],
    },
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
  'repos/contract-hero/hero-forge/pulls/13/comments',
]
const RECHECK_MARKER = '<!-- hero-forge:review-pipeline pr=13 round=1 kind=recheck -->'

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

type GateSetup = {
  ledger?: unknown
  recheck?: unknown
  posted?: string
  noState?: boolean
  app?: boolean
  verdict?: 'APPROVE' | 'REQUEST_CHANGES'
  // The run state after the review posted: the fix commit is pinned, and
  // the phase is this (default adjudicated).
  phase?: string
  mode?: string
}

// A PR whose round 1 review (id 555) is posted and recorded, the ledger, and
// the re-check. `gated(kind)` posts that kind at the fix commit.
async function gateSetup(t: Parameters<typeof tempDir>[0], options: GateSetup = {}) {
  const s = await setup(t, {
    state: options.noState === true ? null : undefined,
    responses: [{ match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 555 }) }],
    app: options.app ? {} : undefined,
  })
  if (options.noState !== true) {
    assert.equal((await s.post()).code, 0)
    await s.patch({ head_sha: FIXED, phase: options.phase ?? 'adjudicated', mode: options.mode ?? 'single' })
  }
  const write = async (name: string, value: unknown) => {
    const path = join(s.dir, name)
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
    return path
  }
  const ledger = await write('findings.json', options.ledger ?? LEDGER)
  const recheck = await write('recheck-r1.json', options.recheck ?? RECHECK)
  const table = await write('recheck-payload.json', TABLE)
  const verdict = await write('verdict-payload.json', { ...TABLE, event: options.verdict ?? 'APPROVE' })
  await s.gh.respond([
    { match: 'pulls/13/comments', stdout: options.posted ?? POSTED },
    { match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 666 }) },
    ME,
  ])
  const before = (await s.gh.calls()).length
  const gated = (kind: string) =>
    runCli(
      ['post-review', '--repo', 'contract-hero/hero-forge', '--pr', '13', '--commit', FIXED, '--round', '1',
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
  assert.deepEqual(await s.gates(), [{ round: 1, commit: FIXED, result: 'pass' }])
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
    assert.deepEqual(await s.gates(), [{ round: 1, commit: FIXED, result: 'fail' }])
  })
}

test('a re-run of a posted re-check posts nothing and reports the same gate', async (t) => {
  const s = await gateSetup(t)
  assert.equal((await s.gated('recheck')).code, 0)
  const again = await s.gated('recheck')
  assert.equal(again.code, 0)
  assert.deepEqual(JSON.parse(again.stdout), { posted: false, duplicate: true, id: 666, gate: 'pass', problems: [] })
  assert.equal((await s.calls()).filter((c) => c.argv.includes('POST')).length, 1)
  assert.deepEqual(await s.gates(), [{ round: 1, commit: FIXED, result: 'pass' }])
})

test('a gate that changes on a re-run is recorded again, so the latest result counts', async (t) => {
  const s = await gateSetup(t)
  assert.equal((await s.gated('recheck')).code, 0)
  await writeFile(join(s.dir, 'recheck-r1.json'), JSON.stringify({ items: [RECHECK.items[0], RECHECK.items[1]] }))
  const again = await s.gated('recheck')
  assert.equal(JSON.parse(again.stdout).gate, 'fail')
  assert.deepEqual(await s.gates(), [{ round: 1, commit: FIXED, result: 'pass' }, { round: 1, commit: FIXED, result: 'fail' }])
})

test('without the reviewer App, a verdict is refused before any gh call: the PR author cannot approve their own PR', async (t) => {
  const s = await gateSetup(t, { phase: 'ready' })
  const { code, stderr } = await s.gated('verdict')
  assert.equal(code, 1)
  assert.match(stderr, /APPROVE\/REQUEST_CHANGES need the reviewer App: the PR author cannot approve their own PR/)
  assert.deepEqual(await s.calls(), [])
})

// The run state pins what a post may be: its head, its round, its App.
const PINNED = [
  ['a commit that is not the pinned head', { head_sha: 'd'.repeat(40) },
    `--commit ${FIXED} is not the head the run pinned (${'d'.repeat(40)}): pin it with run-state set head_sha first`],
  ['a round that is not the run round', { round: 2 }, "--round 1 is not the run's round (2)"],
  ['a run state that names the App when the config has none', { reviewer_login: BOT },
    'the config does not enable the reviewer App, but the run state for PR #13 has reviewer_login hero-reviewer[bot]: re-create the run with the reviewer login the config implies'],
  ['a run state for another repo', { repo: 'someone/else' }, 'the run state for PR #13 is for someone/else, not contract-hero/hero-forge'],
] as const

for (const [name, over, message] of PINNED) {
  test(`${name} is refused before any gh call`, async (t) => {
    const s = await gateSetup(t)
    await s.patch(over)
    const { code, stdout, stderr } = await s.gated('recheck')
    assert.equal(code, 1)
    assert.equal(stdout, '')
    assert.equal(stderr, `review.ts post-review: ${message}\n`)
    assert.deepEqual(await s.calls(), [])
  })
}

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

// The reviewer App: with `app: enabled`, post-review mints an installation
// token itself and gives it to gh as GH_TOKEN, so the review shows the bot.

test('with the App, the review posts with the minted token as GH_TOKEN and records the bot', async (t) => {
  const s = await setup(t, {
    app: {},
    responses: [{ match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 555, state: 'COMMENTED' }) }],
  })
  const { code, stdout, stderr } = await s.post()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { posted: true, id: 555, as: BOT, event: 'COMMENT', round: 1, kind: 'review' })

  const calls = await s.gh.calls()
  assert.deepEqual(calls.map((c) => c.argv), [LIST, POST])
  assert.deepEqual(calls.map((c) => c.gh_token), [TOKEN, TOKEN])
  assert.deepEqual(JSON.parse(calls[1]!.stdin), { ...PAYLOAD, body: `${PAYLOAD.body}\n\n${MARKER}`, commit_id: SHA })
  assert.deepEqual(await s.reviews(), [{ round: 1, kind: 'review', id: 555, commit: SHA, as: BOT, event: 'COMMENT' }])
  assert.doesNotMatch(stdout, new RegExp(TOKEN))
})

test('with the App, the duplicate check counts only the bot reviews', async (t) => {
  const s = await setup(t, {
    app: {},
    state: null,
    responses: [
      { match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 556 }) },
      { match: '--paginate', stdout: listed({ id: 9, body: `walkthrough\n\n${MARKER}` }) },
    ],
  })
  // The user's own marked review is not the App's review: post.
  assert.deepEqual(JSON.parse((await s.post()).stdout).posted, true)

  await s.gh.respond([{ match: '--paginate', stdout: listed({ id: 556, body: `walkthrough\n\n${MARKER}`, login: BOT }) }])
  const again = await s.post()
  assert.equal(again.code, 0)
  assert.deepEqual(JSON.parse(again.stdout), { posted: false, duplicate: true, id: 556 })
  assert.equal((await s.gh.calls()).filter((c) => c.argv.includes('POST')).length, 1)
})

test('a broken App exits 4, posts nothing, and never falls back to the user', async (t) => {
  const s = await setup(t, {
    app: { routes: { ...APP_ROUTES, 'GET /repos/contract-hero/hero-forge/installation': { status: 404, body: { message: 'Not Found' } } } },
  })
  const { code, stdout, stderr } = await s.post()
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts post-review: the reviewer App is not installed on contract-hero\/hero-forge \(HTTP 404\)/)
  assert.deepEqual(await s.gh.calls(), [])
  assert.deepEqual(await s.reviews(), [])
})

test('with the App, a config that the run state does not match is refused before any token is minted', async (t) => {
  const s = await gateSetup(t, { app: true })
  await s.patch({ reviewer_login: 'none' })
  const minted = s.api!.requests.length
  const { code, stderr } = await s.gated('recheck')
  assert.equal(code, 1)
  assert.match(stderr, /the config enables the reviewer App, but the run state for PR #13 has reviewer_login none/)
  assert.deepEqual(await s.calls(), [])
  assert.equal(s.api!.requests.length, minted)
})

test('with the App, a bot login that is not the run state reviewer_login posts nothing', async (t) => {
  const s = await gateSetup(t, { app: true })
  await s.patch({ reviewer_login: 'other-reviewer[bot]' })
  const { code, stderr } = await s.gated('recheck')
  assert.equal(code, 1)
  assert.match(stderr, /the reviewer App posts as hero-reviewer\[bot\], but the run state for PR #13 expects other-reviewer\[bot\]/)
  assert.ok((await s.calls()).every((c) => !c.argv.includes('POST')))
})

for (const phase of ['adjudicated', 'rechecked', 'body-rewritten']) {
  test(`with the App, an APPROVE at phase ${phase} (before the ready flip) is refused before any gh call`, async (t) => {
    const s = await gateSetup(t, { app: true, phase })
    const { code, stderr } = await s.gated('verdict')
    assert.equal(code, 1)
    assert.equal(
      stderr,
      `review.ts post-review: an APPROVE goes on a PR that is ready for review, but PR #13 is at ${phase} (single mode): flip it to ready first, then approve\n`,
    )
    assert.deepEqual(await s.calls(), [])
  })
}

test('with the App, a stack-final run can never be approved: its PR stays a draft', async (t) => {
  const s = await gateSetup(t, { app: true, phase: 'body-rewritten', mode: 'stack-final' })
  const { code, stderr } = await s.gated('verdict')
  assert.equal(code, 1)
  assert.match(stderr, /an APPROVE goes on a PR that is ready for review, but PR #13 is at body-rewritten \(stack-final mode\)/)
})

test('with the App, a landed stack layer (layer mode, complete) can be approved again at its new head', async (t) => {
  const s = await gateSetup(t, { app: true, phase: 'complete', mode: 'layer' })
  const { code, stdout, stderr } = await s.gated('verdict')
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout).event, 'APPROVE')
})

test('with the App, a REQUEST_CHANGES before the run stopped is refused', async (t) => {
  const s = await gateSetup(t, { app: true, verdict: 'REQUEST_CHANGES', phase: 'rechecked' })
  const { code, stderr } = await s.gated('verdict')
  assert.equal(code, 1)
  assert.match(stderr, /a REQUEST_CHANGES goes on a run that ran out of rounds, but PR #13 is at rechecked: run next-round first/)
  assert.deepEqual(await s.calls(), [])
})

test('with the App, a passing gate posts the APPROVE verdict as the bot at the fix commit', async (t) => {
  const s = await gateSetup(t, { app: true, phase: 'ready' })
  const { code, stdout, stderr } = await s.gated('verdict')
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), {
    posted: true, id: 666, as: BOT, event: 'APPROVE', round: 1, kind: 'verdict', gate: 'pass', problems: [],
  })
  const calls = await s.calls()
  assert.deepEqual(calls.map((c) => c.argv), [COMMENTS, LIST, POST])
  assert.equal(calls[2]!.gh_token, TOKEN)
  assert.deepEqual(JSON.parse(calls[2]!.stdin), {
    ...TABLE,
    event: 'APPROVE',
    body: `${TABLE.body}\n\n<!-- hero-forge:review-pipeline pr=13 round=1 kind=verdict -->`,
    commit_id: FIXED,
  })
  assert.deepEqual(
    (await s.reviews()).map((r: { kind: string; id: number; as: string; commit: string }) => [r.kind, r.id, r.as, r.commit]),
    [['review', 555, BOT, SHA], ['verdict', 666, BOT, FIXED]],
  )
  assert.equal((await s.reviews())[1].event, 'APPROVE')
  assert.deepEqual(await s.gates(), [{ round: 1, commit: FIXED, result: 'pass' }])
})

test('with the App, a failing gate after the last round posts REQUEST_CHANGES as the bot', async (t) => {
  const s = await gateSetup(t, {
    app: true,
    verdict: 'REQUEST_CHANGES',
    phase: 'stopped',
    recheck: { items: [RECHECK.items[0], { id: 'F2', status: 'open', reason: 'still crashes' }, RECHECK.items[2]] },
  })
  const { code, stdout, stderr } = await s.gated('verdict')
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const out = JSON.parse(stdout)
  assert.deepEqual([out.posted, out.as, out.event, out.gate, out.problems], [true, BOT, 'REQUEST_CHANGES', 'fail', ['F2 is open: still crashes']])
  assert.equal((await s.calls()).at(-1)!.gh_token, TOKEN)
})

test('with the App, an APPROVE on a failing gate is still refused before any token is minted', async (t) => {
  const s = await gateSetup(t, { app: true, phase: 'ready', recheck: { items: [RECHECK.items[0], RECHECK.items[1]] } })
  const minted = s.api!.requests.length
  const { code, stderr } = await s.gated('verdict')
  assert.equal(code, 1)
  assert.match(stderr, /the gate fails, so the PR cannot be approved/)
  assert.deepEqual((await s.calls()).map((c) => c.argv), [COMMENTS])
  assert.equal(s.api!.requests.length, minted)
})

// A restack after the parent layer landed moved the head of a layer from OLD
// to FIXED. GitHub can then show the App's round 1 APPROVE (review 600, first
// recorded at OLD) on FIXED. The new head always gets a fresh APPROVE.
const OLD = 'd'.repeat(40)
const VERDICT_MARKER = '<!-- hero-forge:review-pipeline pr=13 round=1 kind=verdict -->'

async function restackedSetup(t: Parameters<typeof tempDir>[0], github: Record<string, unknown>[]) {
  const s = await gateSetup(t, { app: true, phase: 'complete', mode: 'layer' })
  await s.patch({
    reviews: [
      ...(await s.reviews()),
      { round: 1, kind: 'verdict', id: 600, commit: OLD, as: BOT, event: 'APPROVE' },
    ],
    gates: [{ round: 1, commit: OLD, result: 'pass' }],
  })
  await s.gh.respond([
    { match: 'pulls/13/comments', stdout: POSTED },
    { match: '--paginate', stdout: listed(...(github as { id: number; body: string }[])) },
    { match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 666 }) },
  ])
  return s
}

const RESTACKED = [
  ['that GitHub shows on the new head', FIXED],
  ['that GitHub still shows on the old head', OLD],
] as const

for (const [name, commit] of RESTACKED) {
  test(`with the App, a layer whose head moved by a restack gets a fresh APPROVE at the new head, with an old APPROVE ${name}`, async (t) => {
    const s = await restackedSetup(t, [{ id: 600, body: `## Verdict: round 1\n\n${VERDICT_MARKER}`, commit_id: commit, login: BOT, state: 'APPROVED' }])
    const { code, stdout, stderr } = await s.gated('verdict')
    assert.equal(stderr, '')
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), {
      posted: true, id: 666, as: BOT, event: 'APPROVE', round: 1, kind: 'verdict', gate: 'pass', problems: [],
    })
    assert.deepEqual((await s.calls()).map((c) => c.argv), [COMMENTS, LIST, POST])
    assert.deepEqual(
      (await s.reviews()).slice(1).map((r: { id: number; commit: string }) => [r.id, r.commit]),
      [[600, OLD], [666, FIXED]],
    )
  })
}

test('with the App, an APPROVE that an older version recorded again at the restacked head does not count there: a fresh APPROVE posts', async (t) => {
  const s = await restackedSetup(t, [{ id: 600, body: `## Verdict: round 1\n\n${VERDICT_MARKER}`, commit_id: FIXED, login: BOT, state: 'APPROVED' }])
  await s.patch({
    reviews: [...(await s.reviews()), { round: 1, kind: 'verdict', id: 600, commit: FIXED, as: BOT, event: 'APPROVE' }],
  })
  const { code, stdout, stderr } = await s.gated('verdict')
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), {
    posted: true, id: 666, as: BOT, event: 'APPROVE', round: 1, kind: 'verdict', gate: 'pass', problems: [],
  })
})

// A zero-finding round: the ledger the Orchestrator wrote to the run dir is
// empty. The review posts with no findings table, and post-review records a
// gate pass at the pinned head, after it checked every reviewer's output. No
// re-checker runs: the run advances to rechecked on that pass.

const FINDINGS_OUT = (pair: number, axis: string) => JSON.stringify({ axis, pair, findings: [], notes: '' })
const TABLE_HEAD = '| ID | Where | Axis | Severity | Pairs | Finding |\n| --- | --- | --- | --- | --- | --- |'
const ZERO = {
  event: 'COMMENT',
  body: `## Review pipeline: round 1\n\nRuntime claude, 2 pairs, commit ccccccc.\n\nSpec: no spec available.\n\n${TABLE_HEAD}\n\nDropped: 1 (S1: a nitpick).`,
  comments: [],
}

type ZeroSetup = { outputs?: Record<string, string | null>; payload?: unknown; app?: boolean }

// A run state at review-dispatched, a run dir with an empty ledger and one
// output per reviewer (`outputs` overrides one; null leaves it out), and a
// fake gh that answers the review post with id 555.
async function zeroSetup(t: Parameters<typeof tempDir>[0], options: ZeroSetup = {}) {
  const s = await setup(t, {
    payload: options.payload ?? ZERO,
    app: options.app ? {} : undefined,
    responses: [{ match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 555 }) }],
  })
  await s.patch({ phase: 'review-dispatched' })
  const runDir = join(s.dir, 'state', 'pr-13')
  await writeFile(join(runDir, 'findings.json'), '[]\n')
  const outputs: Record<string, string | null> = {
    'reviewer-p1-standards': FINDINGS_OUT(1, 'standards'),
    'reviewer-p2-standards': FINDINGS_OUT(2, 'standards'),
    ...options.outputs,
  }
  for (const [name, out] of Object.entries(outputs)) if (out !== null) await writeFile(join(runDir, `${name}.json`), out)
  const runState = (...args: string[]) => runCli(['run-state', ...args], { env: s.env })
  return { ...s, runDir, runState }
}

test('a zero-finding review posts with no findings table and records a gate pass at the pinned head', async (t) => {
  const s = await zeroSetup(t)
  const { code, stdout, stderr } = await s.post()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), {
    posted: true, id: 555, as: 'user', event: 'COMMENT', round: 1, kind: 'review', gate: 'pass', problems: [],
  })
  const posts = (await s.gh.calls()).filter((c) => c.argv.includes('POST'))
  assert.equal(posts.length, 1)
  const sent = JSON.parse(posts[0]!.stdin)
  assert.deepEqual(sent.comments, [])
  assert.doesNotMatch(sent.body, /\|/)
  assert.equal(
    sent.body,
    `## Review pipeline: round 1\n\nRuntime claude, 2 pairs, commit ccccccc.\n\nSpec: no spec available.\n\nNo findings.\n\nDropped: 1 (S1: a nitpick).\n\n${MARKER}`,
  )
  assert.deepEqual(await s.gates(), [{ round: 1, commit: SHA, result: 'pass' }])
})

test('a zero-finding walkthrough with no table and no "No findings." line gets that line at the end', async (t) => {
  const s = await zeroSetup(t, { payload: { ...ZERO, body: '## Review pipeline: round 1\n\nSpec: no spec available.\n' } })
  const { code, stderr } = await s.post()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const sent = JSON.parse((await s.gh.calls()).find((c) => c.argv.includes('POST'))!.stdin)
  assert.equal(sent.body, `## Review pipeline: round 1\n\nSpec: no spec available.\n\nNo findings.\n\n${MARKER}`)
})

for (const [name, outputs, why] of [
  ['a missing reviewer output', { 'reviewer-p2-standards': null }, /reviewer-p2-standards\.json is missing/],
  ['a reviewer output that is prose', { 'reviewer-p2-standards': 'No findings here.' }, /reviewer-p2-standards\.json is not JSON/],
  ['a reviewer output that breaks the findings schema', { 'reviewer-p2-standards': '{"axis":"standards","pair":2,"findings":[]}' }, /does not match findings\.schema\.json: \$: missing "notes"/],
] as const) {
  test(`a zero-finding round with ${name} posts nothing and records no pass`, async (t) => {
    const s = await zeroSetup(t, { outputs })
    const { code, stdout, stderr } = await s.post()
    assert.equal(code, 1)
    assert.equal(stdout, '')
    assert.match(stderr, /a round with zero findings passes only when every reviewer's output is valid, so nothing was posted and no pass is recorded: no valid output from reviewer-p2-standards \(/)
    assert.match(stderr, why)
    assert.doesNotMatch(stderr, /reviewer-p1-standards/)
    assert.deepEqual(await s.gh.calls(), [])
    assert.deepEqual(await s.reviews(), [])
    assert.deepEqual(await s.gates(), [])
    await assert.rejects(access(join(s.runDir, 'recheck-r1.json')))
    assert.equal((await s.runState('advance', '--pr', '13', 'review-posted')).code, 1)
  })
}

test('a zero-finding round with <run dir>/spec.md needs the Spec reviewers too, whatever the walkthrough says', async (t) => {
  const s = await zeroSetup(t)
  await writeFile(join(s.runDir, 'spec.md'), '# #2: Spec\n')
  const { code, stderr } = await s.post()
  assert.equal(code, 1)
  assert.match(stderr, /no valid output from reviewer-p1-spec, reviewer-p2-spec \(/)
  assert.deepEqual(await s.gh.calls(), [])
  assert.deepEqual(await s.gates(), [])

  await writeFile(join(s.runDir, 'reviewer-p1-spec.json'), FINDINGS_OUT(1, 'spec'))
  await writeFile(join(s.runDir, 'reviewer-p2-spec.json'), `\`\`\`json\n${FINDINGS_OUT(2, 'spec')}\n\`\`\`\n`)
  const again = await s.post()
  assert.equal(again.code, 0, again.stderr)
  assert.equal(JSON.parse(again.stdout).gate, 'pass')
})

test('a zero-finding round with no <run dir>/spec.md needs only the Standards reviewers, whatever the walkthrough says', async (t) => {
  const s = await zeroSetup(t, { payload: { ...ZERO, body: ZERO.body.replace('Spec: no spec available.\n\n', '') } })
  const { code, stdout, stderr } = await s.post()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout).gate, 'pass')
})

// Inline comments on GitHub, as `gh api --paginate --jq` lists them.
const inlineFinding = (review: number) =>
  `${JSON.stringify({ id: 101, in_reply_to_id: null, pull_request_review_id: review, login: 'alilloig', body: '**F1** (Standards, bug, high, 2/2 pairs) ...' })}\n`

test('a zero-finding re-run whose recorded review holds an inline finding on GitHub records no pass', async (t) => {
  const s = await zeroSetup(t)
  await s.patch({ reviews: [{ round: 1, kind: 'review', id: 555, commit: SHA, as: 'user', event: 'COMMENT' }] })
  await s.gh.respond([{ match: 'pulls/13/comments', stdout: inlineFinding(555) }, ME])
  const { code, stdout, stderr } = await s.post()
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /the ledger is empty, but GitHub shows inline findings in this run's review, so no pass is recorded: F1 is posted inline but is not in the ledger/)
  assert.deepEqual(await s.gates(), [])
  await assert.rejects(access(join(s.runDir, 'recheck-r1.json')))
})

test('a zero-finding post that finds its own marked review on GitHub with an inline finding records no pass', async (t) => {
  const s = await zeroSetup(t)
  await s.gh.respond([
    { match: 'pulls/13/comments', stdout: inlineFinding(777) },
    { match: '--paginate', stdout: listed({ id: 777, body: `## Review pipeline: round 1\n\n${MARKER}` }) },
    ME,
  ])
  const { code, stderr } = await s.post()
  assert.equal(code, 1)
  assert.match(stderr, /GitHub shows inline findings in this run's review, so no pass is recorded: F1 is posted inline/)
  assert.ok((await s.gh.calls()).every((c) => !c.argv.includes('POST')))
  assert.deepEqual(await s.reviews(), [])
  assert.deepEqual(await s.gates(), [])
})

test('a zero-finding post reads the inline comments, and a re-run records the same pass and posts nothing', async (t) => {
  const s = await zeroSetup(t)
  assert.equal((await s.post()).code, 0)
  assert.ok((await s.gh.calls()).some((c) => c.argv.join(' ') === COMMENTS.join(' ')))
  const again = await s.post()
  assert.equal(again.code, 0, again.stderr)
  assert.deepEqual(JSON.parse(again.stdout), { posted: false, duplicate: true, id: 555, gate: 'pass', problems: [] })
  assert.equal((await s.gh.calls()).filter((c) => c.argv.includes('POST')).length, 1)
  assert.deepEqual(await s.gates(), [{ round: 1, commit: SHA, result: 'pass' }])
})

test('a zero-finding post keeps an existing empty re-check file as it is', async (t) => {
  const s = await zeroSetup(t)
  const old = '{"items":[]}'
  await writeFile(join(s.runDir, 'recheck-r1.json'), old)
  assert.equal((await s.post()).code, 0)
  assert.equal(await readFile(join(s.runDir, 'recheck-r1.json'), 'utf8'), old)
})

test('a zero-finding walkthrough loses a findings table with no outer pipes', async (t) => {
  const body = '## Review pipeline: round 1\n\nSpec: no spec available.\n\nID | Where | Axis | Severity | Pairs | Finding\n--- | --- | --- | --- | --- | ---\n\nDropped: 0.'
  const s = await zeroSetup(t, { payload: { ...ZERO, body } })
  const { code, stderr } = await s.post()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const sent = JSON.parse((await s.gh.calls()).find((c) => c.argv.includes('POST'))!.stdin)
  assert.equal(sent.body, `## Review pipeline: round 1\n\nSpec: no spec available.\n\nNo findings.\n\nDropped: 0.\n\n${MARKER}`)
})

test('a zero-finding round with a Spec reviewer output in the run dir, and no spec.md, needs every pair\'s Spec output', async (t) => {
  const s = await zeroSetup(t, { outputs: { 'reviewer-p1-spec': FINDINGS_OUT(1, 'spec') } })
  const { code, stderr } = await s.post()
  assert.equal(code, 1)
  assert.match(stderr, /no valid output from reviewer-p2-spec \(.*reviewer-p2-spec\.json is missing/)
  assert.deepEqual(await s.gh.calls(), [])
  assert.deepEqual(await s.gates(), [])
})

// An empty ledger with a finding row in the walkthrough table is an
// inconsistent Orchestrator output: the row would be lost, so it is refused.
for (const [name, table] of [
  ['with outer pipes', `${TABLE_HEAD}\n| F1 | src/a.ts:5 | Standards | high | 2/2 | Off by one. |`],
  ['with no outer pipes', 'ID | Where | Axis | Severity | Pairs | Finding\n--- | --- | --- | --- | --- | ---\nF1 | src/a.ts:5 | Standards | high | 2/2 | Off by one.'],
] as const) {
  test(`a zero-finding walkthrough whose findings table (${name}) has a finding row posts nothing and records no pass`, async (t) => {
    const s = await zeroSetup(t, { payload: { ...ZERO, body: ZERO.body.replace(TABLE_HEAD, table) } })
    const { code, stderr } = await s.post()
    assert.equal(code, 1)
    assert.match(stderr, /the ledger \S+findings\.json is empty, but the walkthrough's findings table has 1 row\(s\): every finding in the table needs a ledger entry/)
    assert.deepEqual(await s.gh.calls(), [])
    assert.deepEqual(await s.gates(), [])
  })
}

const CLEAN_PR = JSON.stringify({
  state: 'OPEN', isDraft: false, headRefOid: SHA, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
})

test('after a zero-finding review, the run advances to rechecked with no re-check post, and merge-gate accepts the recorded pass', async (t) => {
  const s = await zeroSetup(t)
  assert.equal((await s.post()).code, 0)
  for (const phase of ['review-posted', 'adjudicated', 'rechecked', 'body-rewritten', 'ready', 'explained']) {
    const advanced = await s.runState('advance', '--pr', '13', phase)
    assert.equal(advanced.code, 0, `${phase}: ${advanced.stderr}`)
  }
  assert.deepEqual(JSON.parse(await readFile(join(s.runDir, 'recheck-r1.json'), 'utf8')), { items: [] })
  const kinds = (await s.reviews()).map((r: { kind: string }) => r.kind)
  assert.deepEqual(kinds, ['review'])

  await s.gh.respond([{ match: 'mergeStateStatus', stdout: CLEAN_PR }])
  const gate = await runCli(['merge-gate', '--repo', 'contract-hero/hero-forge', '--pr', '13', '--config', s.configPath], { env: s.env })
  assert.equal(gate.stderr, '')
  assert.equal(gate.code, 0)
  assert.deepEqual(JSON.parse(gate.stdout).gate, 'go')
  assert.deepEqual(JSON.parse(gate.stdout).problems, [])
})

test('with the App, a zero-finding round gets its APPROVE from the gate on the empty re-check, and merge-gate says go', async (t) => {
  const s = await zeroSetup(t, { app: true })
  const reviewed = await s.post()
  assert.equal(reviewed.code, 0, reviewed.stderr)
  for (const phase of ['review-posted', 'adjudicated', 'rechecked', 'body-rewritten', 'ready']) {
    assert.equal((await s.runState('advance', '--pr', '13', phase)).code, 0, phase)
  }
  const verdict = join(s.dir, 'verdict-r1.json')
  await writeFile(verdict, JSON.stringify({ event: 'APPROVE', body: '## Verdict: round 1', comments: [] }))
  await s.gh.respond([{ match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 666 }) }])
  const approved = await runCli(
    ['post-review', '--repo', 'contract-hero/hero-forge', '--pr', '13', '--commit', SHA, '--round', '1', '--kind', 'verdict',
      '--payload', verdict, '--config', s.configPath, '--ledger', join(s.runDir, 'findings.json'), '--recheck', join(s.runDir, 'recheck-r1.json')],
    { env: s.env },
  )
  assert.equal(approved.stderr, '')
  assert.equal(approved.code, 0)
  assert.deepEqual(JSON.parse(approved.stdout), {
    posted: true, id: 666, as: BOT, event: 'APPROVE', round: 1, kind: 'verdict', gate: 'pass', problems: [],
  })
  for (const phase of ['verdict-posted', 'explained']) assert.equal((await s.runState('advance', '--pr', '13', phase)).code, 0, phase)

  await s.gh.respond([
    { match: 'mergeStateStatus', stdout: CLEAN_PR },
    { match: 'pulls/13/reviews', stdout: `${JSON.stringify({ id: 555, state: 'COMMENTED', commit_id: SHA, login: BOT })}\n${JSON.stringify({ id: 666, state: 'APPROVED', commit_id: SHA, login: BOT })}\n` },
  ])
  const gate = await runCli(['merge-gate', '--repo', 'contract-hero/hero-forge', '--pr', '13', '--config', s.configPath], { env: s.env })
  assert.equal(gate.stderr, '')
  assert.deepEqual(JSON.parse(gate.stdout).problems, [])
  assert.equal(JSON.parse(gate.stdout).gate, 'go')
})

test('with the App, a zero-finding round replaces a re-check file with items from another run, and goes through the APPROVE and merge-gate go', async (t) => {
  const s = await zeroSetup(t, { app: true })
  await writeFile(join(s.runDir, 'recheck-r1.json'), '{"items":[{"id":"F1","status":"fixed","reason":"from an earlier run"}]}')
  const reviewed = await s.post()
  assert.equal(reviewed.code, 0, reviewed.stderr)
  assert.deepEqual(JSON.parse(await readFile(join(s.runDir, 'recheck-r1.json'), 'utf8')), { items: [] })
  for (const phase of ['review-posted', 'adjudicated', 'rechecked', 'body-rewritten', 'ready']) {
    assert.equal((await s.runState('advance', '--pr', '13', phase)).code, 0, phase)
  }
  const verdict = join(s.dir, 'verdict-r1.json')
  await writeFile(verdict, JSON.stringify({ event: 'APPROVE', body: '## Verdict: round 1', comments: [] }))
  await s.gh.respond([{ match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 666 }) }])
  const approved = await runCli(
    ['post-review', '--repo', 'contract-hero/hero-forge', '--pr', '13', '--commit', SHA, '--round', '1', '--kind', 'verdict',
      '--payload', verdict, '--config', s.configPath, '--ledger', join(s.runDir, 'findings.json'), '--recheck', join(s.runDir, 'recheck-r1.json')],
    { env: s.env },
  )
  assert.equal(approved.stderr, '')
  assert.equal(approved.code, 0)
  assert.equal(JSON.parse(approved.stdout).gate, 'pass')
  for (const phase of ['verdict-posted', 'explained']) assert.equal((await s.runState('advance', '--pr', '13', phase)).code, 0, phase)

  await s.gh.respond([
    { match: 'mergeStateStatus', stdout: CLEAN_PR },
    { match: 'pulls/13/reviews', stdout: `${JSON.stringify({ id: 555, state: 'COMMENTED', commit_id: SHA, login: BOT })}\n${JSON.stringify({ id: 666, state: 'APPROVED', commit_id: SHA, login: BOT })}\n` },
  ])
  const gate = await runCli(['merge-gate', '--repo', 'contract-hero/hero-forge', '--pr', '13', '--config', s.configPath], { env: s.env })
  assert.equal(gate.stderr, '')
  assert.deepEqual(JSON.parse(gate.stdout).problems, [])
  assert.equal(JSON.parse(gate.stdout).gate, 'go')
})
