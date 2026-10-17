import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseEnv, run, runCli, tempDir } from './test-helpers.ts'

const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

// A state root in a temp dir, and a runner that uses it.
async function stateRoot(t: Parameters<typeof tempDir>[0]) {
  const root = await tempDir(t)
  const env = { ...baseEnv(), HERO_POCOCK_STATE_DIR: root }
  return {
    root,
    file: join(root, 'pr-13', 'state.json'),
    cli: (...args: string[]) => runCli(['run-state', ...args], { env }),
  }
}

const CREATE = [
  'create', '--pr', '13', '--repo', 'contract-hero/hero-pocock', '--base', 'main', '--head', 'feature/x',
  '--head-sha', SHA, '--runtime', 'claude', '--reviewer-login', 'none',
]

test('path prints the run dir under the state root and creates nothing', async (t) => {
  const s = await stateRoot(t)
  const { code, stdout, stderr } = await s.cli('path', '--pr', '13')
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.equal(stdout, `${join(s.root, 'pr-13')}\n`)
  assert.deepEqual(await readdir(s.root), [])
})

test('without an override the state root is hero-pocock/ in the git common dir', async (t) => {
  const repo = await realpath(await tempDir(t))
  assert.equal((await run('git', ['init', '-q', repo])).code, 0)
  const env = baseEnv()
  delete env.HERO_POCOCK_STATE_DIR
  const { code, stdout } = await runCli(['run-state', 'path', '--pr', '13'], { cwd: repo, env })
  assert.equal(code, 0)
  assert.equal(stdout, `${join(repo, '.git', 'hero-pocock', 'pr-13')}\n`)
})

test('create writes a fresh state file in a private run dir', async (t) => {
  const s = await stateRoot(t)
  const { code, stdout, stderr } = await s.cli(...CREATE)
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const state = JSON.parse(await readFile(s.file, 'utf8'))
  assert.deepEqual(JSON.parse(stdout), state)
  const { created_at, updated_at, ...rest } = state
  assert.match(created_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(updated_at, created_at)
  assert.deepEqual(rest, {
    schema: 1,
    repo: 'contract-hero/hero-pocock',
    pr: 13,
    mode: 'single',
    base_ref: 'main',
    head_ref: 'feature/x',
    head_sha: SHA,
    runtime: 'claude',
    reviewer_login: 'none',
    round: 1,
    phase: 'created',
    reviews: [],
    explainer: null,
  })
  assert.equal((await stat(join(s.root, 'pr-13'))).mode & 0o777, 0o700)
})

test('read prints the whole state, or one key as a raw value', async (t) => {
  const s = await stateRoot(t)
  await s.cli(...CREATE)
  const whole = await s.cli('read', '--pr', '13')
  assert.equal(whole.code, 0)
  assert.equal(JSON.parse(whole.stdout).head_sha, SHA)
  assert.deepEqual(await s.cli('read', '--pr', '13', 'phase'), { code: 0, stdout: 'created\n', stderr: '' })
  assert.deepEqual(await s.cli('read', '--pr', '13', 'round'), { code: 0, stdout: '1\n', stderr: '' })
  assert.deepEqual(await s.cli('read', '--pr', '13', 'reviews'), { code: 0, stdout: '[]\n', stderr: '' })
  assert.deepEqual(await s.cli('read', '--pr', '13', 'explainer'), { code: 0, stdout: 'null\n', stderr: '' })
})

test('advance moves the phase and set changes one field', async (t) => {
  const s = await stateRoot(t)
  await s.cli(...CREATE)
  assert.equal((await s.cli('advance', '--pr', '13', 'review-dispatched')).code, 0)
  assert.equal((await s.cli('set', '--pr', '13', 'round', '2')).code, 0)
  assert.equal((await s.cli('set', '--pr', '13', 'head_sha', SHA2)).code, 0)
  assert.equal((await s.cli('set', '--pr', '13', 'reviewer_login', 'hero-reviewer[bot]')).code, 0)
  assert.equal((await s.cli('set', '--pr', '13', 'explainer', '/tmp/explainer.html')).code, 0)
  const state = JSON.parse(await readFile(s.file, 'utf8'))
  assert.equal(state.phase, 'review-dispatched')
  assert.equal(state.round, 2)
  assert.equal(state.head_sha, SHA2)
  assert.equal(state.reviewer_login, 'hero-reviewer[bot]')
  assert.equal(state.explainer, '/tmp/explainer.html')
})

// A run at the end of round `round` (re-check posted), and its next-round call.
async function rechecked(t: Parameters<typeof tempDir>[0], round: number) {
  const s = await stateRoot(t)
  await s.cli(...CREATE)
  await s.cli('set', '--pr', '13', 'round', String(round))
  await s.cli('advance', '--pr', '13', 'rechecked')
  return { ...s, next: (max: string) => s.cli('next-round', '--pr', '13', '--max-rounds', max) }
}

test('next-round after a failed re-check starts the next round at Adjudication', async (t) => {
  const s = await rechecked(t, 1)
  const { code, stdout, stderr } = await s.next('2')
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { round: 2, phase: 'review-posted' })
  const state = JSON.parse(await readFile(s.file, 'utf8'))
  assert.equal(state.round, 2)
  assert.equal(state.phase, 'review-posted')
  assert.deepEqual(await readdir(join(s.root, 'pr-13')), ['state.json'])
})

for (const [round, max] of [[2, '2'], [1, '1'], [3, '2']] as const) {
  test(`next-round at round ${round} of max ${max} stops the run, and it stays stopped`, async (t) => {
    const s = await rechecked(t, round)
    const { code, stdout } = await s.next(max)
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), { round, phase: 'stopped' })
    assert.equal(JSON.parse(await readFile(s.file, 'utf8')).phase, 'stopped')
    assert.equal((await s.next(max)).code, 1)
    assert.equal((await s.cli('advance', '--pr', '13', 'review-posted')).code, 1)
  })
}

test('next-round before the re-check is posted is refused and changes nothing', async (t) => {
  const s = await stateRoot(t)
  await s.cli(...CREATE)
  await s.cli('advance', '--pr', '13', 'adjudicated')
  const before = await readFile(s.file, 'utf8')
  const { code, stderr } = await s.cli('next-round', '--pr', '13', '--max-rounds', '2')
  assert.equal(code, 1)
  assert.equal(stderr, 'review.ts run-state: next-round needs phase rechecked, but PR #13 is at adjudicated\n')
  assert.equal(await readFile(s.file, 'utf8'), before)
})

test('next-round without a whole-number --max-rounds is a usage error', async (t) => {
  const s = await rechecked(t, 1)
  for (const args of [['next-round', '--pr', '13'], ['next-round', '--pr', '13', '--max-rounds', '0'], ['next-round', '--pr', '13', '--max-rounds', 'two']]) {
    assert.equal((await s.cli(...args)).code, 2, args.join(' '))
  }
  assert.equal(JSON.parse(await readFile(s.file, 'utf8')).round, 1)
})

const REFUSED = [
  ['an unknown phase', ['advance', '--pr', '13', 'shipped'], /unknown phase "shipped"/],
  ['an unknown key', ['set', '--pr', '13', 'phase', 'merged'], /cannot set "phase"/],
  ['a round of 0', ['set', '--pr', '13', 'round', '0'], /round must be a positive whole number/],
  ['a short head_sha', ['set', '--pr', '13', 'head_sha', 'abc'], /head_sha must be 40 hex characters/],
  ['a bad reviewer_login', ['set', '--pr', '13', 'reviewer_login', 'someone'], /reviewer_login must be "none" or <slug>\[bot\]/],
] as const

for (const [name, args, message] of REFUSED) {
  test(`${name} is refused with exit 1 and leaves the state untouched`, async (t) => {
    const s = await stateRoot(t)
    await s.cli(...CREATE)
    const before = await readFile(s.file, 'utf8')
    const { code, stdout, stderr } = await s.cli(...args)
    assert.equal(code, 1)
    assert.equal(stdout, '')
    assert.match(stderr, /^review\.ts run-state: /)
    assert.match(stderr, message)
    assert.equal(await readFile(s.file, 'utf8'), before)
  })
}

test('create over a run in flight is refused, so a resumed run keeps its state', async (t) => {
  const s = await stateRoot(t)
  await s.cli(...CREATE)
  await s.cli('advance', '--pr', '13', 'review-posted')
  const before = await readFile(s.file, 'utf8')
  const { code, stderr } = await s.cli(...CREATE)
  assert.equal(code, 1)
  assert.equal(
    stderr,
    'review.ts run-state: run in flight for PR #13 (phase review-posted): resume it, or create --force\n',
  )
  assert.equal(await readFile(s.file, 'utf8'), before)

  const forced = await s.cli(...CREATE, '--force')
  assert.equal(forced.code, 0)
  assert.equal(JSON.parse(await readFile(s.file, 'utf8')).phase, 'created')
})

test('create over a terminal run starts a new one', async (t) => {
  const s = await stateRoot(t)
  await s.cli(...CREATE)
  await s.cli('advance', '--pr', '13', 'complete')
  const { code } = await s.cli(...CREATE)
  assert.equal(code, 0)
  assert.equal(JSON.parse(await readFile(s.file, 'utf8')).phase, 'created')
})

test('advance out of a terminal phase is refused', async (t) => {
  const s = await stateRoot(t)
  await s.cli(...CREATE)
  await s.cli('advance', '--pr', '13', 'stopped')
  const { code, stderr } = await s.cli('advance', '--pr', '13', 'review-posted')
  assert.equal(code, 1)
  assert.match(stderr, /run for PR #13 is stopped \(terminal\)/)
})

test('no state file exits 3 on read, advance and set', async (t) => {
  const s = await stateRoot(t)
  for (const args of [['read', '--pr', '13'], ['advance', '--pr', '13', 'created'], ['set', '--pr', '13', 'round', '2']]) {
    const { code, stdout, stderr } = await s.cli(...args)
    assert.equal(code, 3, args.join(' '))
    assert.equal(stdout, '')
    assert.equal(stderr, `review.ts run-state: no run state for PR #13 at ${s.file}\n`)
  }
})

const CORRUPT = [
  ['unparseable JSON', '{"phase": "created"'],
  ['no phase', JSON.stringify({ schema: 1 })],
  ['a bad field', JSON.stringify({ schema: 1, phase: 'created', pr: 'thirteen' })],
] as const

for (const [name, contents] of CORRUPT) {
  test(`a corrupt state file (${name}) exits 4 and create needs --force`, async (t) => {
    const s = await stateRoot(t)
    await mkdir(join(s.root, 'pr-13'), { recursive: true })
    await writeFile(s.file, contents)
    for (const args of [['read', '--pr', '13'], ['advance', '--pr', '13', 'created'], ['set', '--pr', '13', 'round', '2'], CREATE]) {
      const { code, stdout, stderr } = await s.cli(...args)
      assert.equal(code, 4, args.join(' '))
      assert.equal(stdout, '')
      assert.match(stderr, new RegExp(`^review\\.ts run-state: corrupt state file ${s.file}: `))
    }
    assert.equal(await readFile(s.file, 'utf8'), contents)

    const forced = await s.cli(...CREATE, '--force')
    assert.equal(forced.code, 0)
    assert.equal(JSON.parse(await readFile(s.file, 'utf8')).phase, 'created')
  })
}

test('writes leave no temporary files behind', async (t) => {
  const s = await stateRoot(t)
  await s.cli(...CREATE)
  await s.cli('advance', '--pr', '13', 'review-dispatched')
  await s.cli('set', '--pr', '13', 'round', '2')
  await s.cli('advance', '--pr', '13', 'shipped')
  assert.deepEqual(await readdir(join(s.root, 'pr-13')), ['state.json'])
})

test('bad arguments are a usage error (exit 2)', async (t) => {
  const s = await stateRoot(t)
  for (const args of [['read'], ['read', '--pr', 'x'], ['nope', '--pr', '13'], ['create', '--pr', '13'], ['advance', '--pr', '13']]) {
    const { code, stdout } = await s.cli(...args)
    assert.equal(code, 2, args.join(' '))
    assert.equal(stdout, '')
  }
})
