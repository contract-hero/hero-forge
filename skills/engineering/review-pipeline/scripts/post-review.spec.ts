import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeGh, runCli, tempDir, type FakeGhResponse } from './test-helpers.ts'

const SHA = 'c'.repeat(40)
const MARKER = '<!-- hero-pocock:review-pipeline pr=13 round=1 kind=review -->'
const LIST = ['api', '--paginate', '--jq', '.[] | {id, body}', 'repos/contract-hero/hero-pocock/pulls/13/reviews']
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
  const gh = await fakeGh(dir, options.responses ?? [])
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
  return { gh, post, reviews, stateFile }
}

test('a COMMENT review with inline suggestions posts once, as the user, and is recorded', async (t) => {
  const s = await setup(t, {
    responses: [
      { match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 555, state: 'COMMENTED' }) },
      { match: '--paginate', stdout: `${JSON.stringify({ id: 1, body: 'an older human review' })}\n` },
    ],
  })
  const { code, stdout, stderr } = await s.post()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { posted: true, id: 555, as: 'user', event: 'COMMENT', round: 1, kind: 'review' })

  const calls = await s.gh.calls()
  assert.deepEqual(calls.map((c) => c.argv), [LIST, POST])
  assert.deepEqual(calls.map((c) => c.gh_token), [null, null])
  assert.deepEqual(JSON.parse(calls[1]!.stdin), {
    ...PAYLOAD,
    body: `${PAYLOAD.body}\n\n${MARKER}`,
    commit_id: SHA,
  })
  assert.deepEqual(await s.reviews(), [{ round: 1, kind: 'review', id: 555, commit: SHA, as: 'user' }])
})

test('a review already on the PR with the same marker is not posted again', async (t) => {
  const s = await setup(t, {
    responses: [{ match: '--paginate', stdout: `${JSON.stringify({ id: 777, body: `walkthrough\n\n${MARKER}` })}\n` }],
  })
  const first = await s.post()
  assert.equal(first.code, 0)
  assert.deepEqual(JSON.parse(first.stdout), { posted: false, duplicate: true, id: 777 })
  const second = await s.post()
  assert.equal(second.code, 0)

  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [LIST, LIST])
  assert.deepEqual(await s.reviews(), [{ round: 1, kind: 'review', id: 777, commit: SHA, as: 'user' }])
})

test('a marker for another round does not count as a duplicate', async (t) => {
  const s = await setup(t, {
    responses: [
      { match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 556 }) },
      { match: '--paginate', stdout: `${JSON.stringify({ id: 9, body: MARKER.replace('round=1', 'round=11') })}\n` },
    ],
  })
  const { code, stdout } = await s.post()
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout).posted, true)
})

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
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [LIST])
})

const REFUSED = [
  ['a verdict from the user', ['--kind', 'verdict'], { ...PAYLOAD, event: 'APPROVE' }, /APPROVE\/REQUEST_CHANGES need the reviewer App/],
  ['a review that approves', [], { ...PAYLOAD, event: 'APPROVE' }, /--kind review posts COMMENT only/],
  ['a recheck that requests changes', ['--kind', 'recheck'], { ...PAYLOAD, event: 'REQUEST_CHANGES' }, /--kind recheck posts COMMENT only/],
  ['a verdict that only comments', ['--kind', 'verdict'], PAYLOAD, /--kind verdict posts APPROVE or REQUEST_CHANGES only/],
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
  for (const extra of [['--kind', 'praise'], ['--round', '0'], ['--commit', 'abc'], ['--bogus']]) {
    const { code } = await s.post(...extra)
    assert.equal(code, 2, extra.join(' '))
  }
  assert.equal((await runCli(['post-review'])).code, 2)
  assert.deepEqual(await s.gh.calls(), [])
})
