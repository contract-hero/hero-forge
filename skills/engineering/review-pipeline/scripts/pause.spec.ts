// The pause record. #29 writes it when a run stops at a one-way door, and
// `route --app implementer` reads it (route.spec.ts drives that through the
// CLI). These tests call pause.ts's exported functions, the interface the
// posting side imports: what writePause writes must be what route reads.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Failure } from './cli.ts'
import { deletePause, pauseFile, readPause, writePause, type PauseRecord } from './pause.ts'
import { tempDir } from './test-helpers.ts'

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
