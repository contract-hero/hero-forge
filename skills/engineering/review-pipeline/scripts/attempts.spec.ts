// Attempt reservation races. These few tests call cap.ts's exported
// functions, not the CLI: the issue lock serializes `route` calls for one
// ticket, so only a direct call can race the reservation itself.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { attemptsFile, releaseAttempt, reserveAttempt } from './cap.ts'
import { tempDir } from './test-helpers.ts'

const REPO = 'contract-hero/hero-forge'

async function capDir(t: Parameters<typeof tempDir>[0]): Promise<string> {
  const dir = await tempDir(t)
  const before = process.env.HERO_FORGE_CAP_DIR
  process.env.HERO_FORGE_CAP_DIR = dir
  t.after(async () => {
    if (before === undefined) delete process.env.HERO_FORGE_CAP_DIR
    else process.env.HERO_FORGE_CAP_DIR = before
  })
  return dir
}

test('attempt race: callers that reserve the last attempt at once give exactly one reservation', async (t) => {
  await capDir(t)
  const won = (await Promise.all(Array.from({ length: 20 }, () => reserveAttempt(REPO, 28, 1)))).filter((ok) => ok)
  assert.equal(won.length, 1)
  assert.deepEqual(JSON.parse(await readFile(attemptsFile(), 'utf8')), { [`${REPO}#28`]: 1 })
})

test('attempt race: with three attempts, twenty callers at once reserve three, and a release frees one again', async (t) => {
  const dir = await capDir(t)
  const won = (await Promise.all(Array.from({ length: 20 }, () => reserveAttempt(REPO, 28, 3)))).filter((ok) => ok)
  assert.equal(won.length, 3)
  await releaseAttempt(REPO, 28)
  assert.equal(await reserveAttempt(REPO, 28, 3), true)
  assert.equal(await reserveAttempt(REPO, 28, 3), false)
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'implementer-app-attempts.json'), 'utf8')), { [`${REPO}#28`]: 3 })
})
