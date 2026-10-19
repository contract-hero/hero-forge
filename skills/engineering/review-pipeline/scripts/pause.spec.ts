// The pause record. #29 writes it when a run stops at a one-way door, and
// `route --app implementer` reads it (route.spec.ts drives that through the
// CLI). The first tests call pause.ts's exported functions, which route
// imports; the rest drive `review.ts pause`, which the AFK skills call: what
// the CLI writes must be what route reads.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Failure } from './cli.ts'
import { deletePause, pauseFile, readPause, writePause, type PauseRecord } from './pause.ts'
import { baseEnv, runCli, tempDir } from './test-helpers.ts'

const RECORD: PauseRecord = {
  kind: 'issue',
  number: 28,
  repo: 'contract-hero/hero-forge',
  reason: 'Add a column to the runs table?',
  paused_at: '2026-10-19T09:00:00.000Z',
}

// Point the state root at a temp dir for one test.
async function stateDir(t: Parameters<typeof tempDir>[0]): Promise<string> {
  const dir = await tempDir(t)
  const before = process.env.HERO_FORGE_STATE_DIR
  process.env.HERO_FORGE_STATE_DIR = dir
  t.after(async () => {
    if (before === undefined) delete process.env.HERO_FORGE_STATE_DIR
    else process.env.HERO_FORGE_STATE_DIR = before
  })
  return dir
}

test('pause record: one file per issue or PR under <state root>/pauses/', async (t) => {
  const dir = await stateDir(t)
  assert.equal(pauseFile({ kind: 'issue', number: 28 }), join(dir, 'pauses', 'issue-28.json'))
  assert.equal(pauseFile({ kind: 'pr', number: 42 }), join(dir, 'pauses', 'pr-42.json'))
})

test('pause record: what writePause writes, readPause reads back, and deletePause removes', async (t) => {
  const dir = await stateDir(t)
  assert.equal(await readPause(RECORD), null)
  await writePause(RECORD)
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'pauses', 'issue-28.json'), 'utf8')), RECORD)
  assert.deepEqual(await readPause({ kind: 'issue', number: 28 }), RECORD)
  // The PR of the same number has no record.
  assert.equal(await readPause({ kind: 'pr', number: 28 }), null)
  assert.equal(await deletePause({ kind: 'issue', number: 28 }), true)
  assert.equal(await readPause({ kind: 'issue', number: 28 }), null)
  assert.equal(await deletePause({ kind: 'issue', number: 28 }), false)
})

test('pause record: a second write replaces the first', async (t) => {
  await stateDir(t)
  await writePause(RECORD)
  await writePause({ ...RECORD, reason: 'Drop the old endpoint?' })
  assert.equal((await readPause(RECORD))?.reason, 'Drop the old endpoint?')
})

test('pause record: an invalid record is refused before anything is written', async (t) => {
  await stateDir(t)
  await assert.rejects(writePause({ ...RECORD, reason: '' }), (error) => error instanceof Failure && error.code === 1)
  assert.equal(await readPause(RECORD), null)
})

// `review.ts pause` with its own state root.
async function pauseCli(t: Parameters<typeof tempDir>[0]) {
  const root = await stateDir(t)
  return { root, cli: (...args: string[]) => runCli(['pause', ...args], { env: { ...baseEnv(), HERO_FORGE_STATE_DIR: root } }) }
}

for (const kind of ['issue', 'pr'] as const) {
  test(`pause write --${kind} records the pause that route reads, read prints it, and delete removes it`, async (t) => {
    const s = await pauseCli(t)
    const before = Date.now()
    const written = await s.cli('write', '--repo', 'contract-hero/hero-forge', `--${kind}`, '28', '--reason', 'Add a column to the runs table?')
    assert.equal(written.stderr, '')
    assert.equal(written.code, 0)
    const record = JSON.parse(written.stdout) as PauseRecord
    assert.deepEqual({ ...record, paused_at: 'x' }, { kind, number: 28, repo: 'contract-hero/hero-forge', reason: 'Add a column to the runs table?', paused_at: 'x' })
    assert.ok(Date.parse(record.paused_at) >= before - 1000 && Date.parse(record.paused_at) <= Date.now())
    assert.deepEqual(await readPause({ kind, number: 28 }), record)

    const read = await s.cli('read', `--${kind}`, '28')
    assert.equal(read.code, 0, read.stderr)
    assert.deepEqual(JSON.parse(read.stdout), record)

    const deleted = await s.cli('delete', `--${kind}`, '28')
    assert.equal(deleted.code, 0, deleted.stderr)
    assert.deepEqual(JSON.parse(deleted.stdout), { kind, number: 28, deleted: true })
    assert.equal(await readPause({ kind, number: 28 }), null)
    assert.deepEqual(JSON.parse((await s.cli('delete', `--${kind}`, '28')).stdout), { kind, number: 28, deleted: false })
  })
}

test('pause read with no record exits 3', async (t) => {
  const s = await pauseCli(t)
  const result = await s.cli('read', '--issue', '28')
  assert.equal(result.code, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^review\.ts pause: no pause record for issue #28 at .*issue-28\.json\n$/)
})

test('pause read of a corrupt record exits 4', async (t) => {
  const s = await pauseCli(t)
  await writePause(RECORD)
  await writeFile(pauseFile(RECORD), '{"kind": "issue"')
  assert.equal((await s.cli('read', '--issue', '28')).code, 4)
})

test('pause needs one of --issue and --pr, a repo and a reason to write: else a usage error (exit 2) that writes nothing', async (t) => {
  const s = await pauseCli(t)
  for (const args of [
    ['write', '--repo', 'contract-hero/hero-forge', '--reason', 'Q?'],
    ['write', '--repo', 'contract-hero/hero-forge', '--issue', '1', '--pr', '2', '--reason', 'Q?'],
    ['write', '--issue', '1', '--reason', 'Q?'],
    ['write', '--repo', 'contract-hero/hero-forge', '--issue', '1'],
    ['write', '--repo', 'contract-hero/hero-forge', '--issue', '1', '--reason', '  '],
    ['read'],
    ['list', '--issue', '1'],
  ]) {
    const result = await s.cli(...args)
    assert.equal(result.code, 2, args.join(' '))
    assert.match(result.stderr, /^review\.ts pause: .*\nusage:\n/, args.join(' '))
  }
  assert.equal(await readPause({ kind: 'issue', number: 1 }), null)
})

// A build that pushed its work before it paused names the branch and the tip
// it pushed, so the resumed run, in a new worktree, starts from that tip.
test('pause write --branch --tip records the pushed branch and tip, and the record still reads as a pause', async (t) => {
  const s = await pauseCli(t)
  const tip = 'a'.repeat(40)
  const written = await s.cli('write', '--repo', 'contract-hero/hero-forge', '--issue', '25', '--reason', 'New dependency?', '--branch', 'ticket/25-x', '--tip', tip)
  assert.equal(written.code, 0, written.stderr)
  const record = JSON.parse(written.stdout) as PauseRecord
  assert.equal(record.branch, 'ticket/25-x')
  assert.equal(record.tip, tip)
  assert.deepEqual(await readPause({ kind: 'issue', number: 25 }), record)
  assert.deepEqual(JSON.parse((await s.cli('read', '--issue', '25')).stdout), record)
})

test('pause write takes --branch and --tip together, the tip as a full sha: else a usage error that writes nothing', async (t) => {
  const s = await pauseCli(t)
  const base = ['write', '--repo', 'contract-hero/hero-forge', '--issue', '25', '--reason', 'Q?']
  for (const extra of [['--branch', 'ticket/25-x'], ['--tip', 'a'.repeat(40)], ['--branch', 'ticket/25-x', '--tip', 'HEAD'], ['--branch=-x', '--tip', 'a'.repeat(40)], ['--branch', 'a..b', '--tip', 'a'.repeat(40)]]) {
    const result = await s.cli(...base, ...extra)
    assert.equal(result.code, 2, extra.join(' '))
    assert.match(result.stderr, /^review\.ts pause: .*\nusage:\n/, extra.join(' '))
  }
  assert.equal(await readPause({ kind: 'issue', number: 25 }), null)
})

test('pause record: a record with a bad tip is corrupt', async (t) => {
  await stateDir(t)
  await assert.rejects(writePause({ ...RECORD, branch: 'ticket/28-x', tip: 'nope' }), (error) => error instanceof Failure && error.code === 1)
})

// A build that paused keeps the Decisions entries it made so far, so the
// resumed run, in a new session, puts them back into the PR body.
test('pause write --decisions-file records the Decisions entries so far, and read gives them back', async (t) => {
  const s = await pauseCli(t)
  const dir = await tempDir(t)
  const file = join(dir, 'decisions.md')
  const text = '- **Cache key.** Options: path, hash. Chose hash: renames keep the entry.\n'
  await writeFile(file, text)
  const written = await s.cli('write', '--repo', 'contract-hero/hero-forge', '--issue', '25', '--reason', 'New dependency?', '--decisions-file', file)
  assert.equal(written.code, 0, written.stderr)
  assert.equal((JSON.parse(written.stdout) as PauseRecord).decisions, text)
  assert.equal((await readPause({ kind: 'issue', number: 25 }))?.decisions, text)
  assert.equal((JSON.parse((await s.cli('read', '--issue', '25')).stdout) as PauseRecord).decisions, text)
})

test('pause write --decisions-file of a missing or empty file writes nothing', async (t) => {
  const s = await pauseCli(t)
  const dir = await tempDir(t)
  const empty = join(dir, 'empty.md')
  await writeFile(empty, '  \n')
  for (const [file, code] of [[join(dir, 'none.md'), 1], [empty, 2]] as const) {
    const result = await s.cli('write', '--repo', 'contract-hero/hero-forge', '--issue', '25', '--reason', 'Q?', '--decisions-file', file)
    assert.equal(result.code, code, file)
  }
  assert.equal(await readPause({ kind: 'issue', number: 25 }), null)
})

test('pause record: a decisions field that is not text is corrupt', async (t) => {
  await stateDir(t)
  await assert.rejects(writePause({ ...RECORD, decisions: 3 as unknown as string }), (error) => error instanceof Failure && error.code === 1)
})
