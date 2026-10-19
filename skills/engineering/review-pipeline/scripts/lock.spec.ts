// Lock races. These few tests call lock.ts's exported functions, not the CLI:
// the interleavings they check cannot be driven through `review.ts route`.
import assert from 'node:assert/strict'
import { readFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Failure } from './cli.ts'
import { releaseLock, takeLock, whileHolding } from './lock.ts'
import { tempDir } from './test-helpers.ts'

const HOUR = 60 * 60 * 1000

const tokenIn = async (file: string) => (JSON.parse(await readFile(file, 'utf8')) as { token: string }).token

test('lock race: callers that retry while the holder releases give exactly one new holder, and the lock holds its token', async (t) => {
  const file = join(await tempDir(t), 'pr-42.lock')
  const first = await takeLock(file, HOUR, {})
  assert.ok(first !== null)
  const until = Date.now() + 2000
  const contender = async (): Promise<string | null> => {
    while (Date.now() < until) {
      const token = await takeLock(file, HOUR, {})
      if (token !== null) return token
      await sleep(1)
    }
    return null
  }
  const contenders = Array.from({ length: 20 }, contender)
  await sleep(20)
  assert.equal(await releaseLock(file, first), true)
  const won = (await Promise.all(contenders)).filter((token) => token !== null)
  assert.equal(won.length, 1)
  assert.equal(await tokenIn(file), won[0])
})

test('lock race: callers that find one stale lock at once give exactly one new holder', async (t) => {
  const file = join(await tempDir(t), 'pr-42.lock')
  assert.ok((await takeLock(file, HOUR, {})) !== null)
  const old = new Date(Date.now() - 2 * HOUR)
  await utimes(file, old, old)
  const won = (await Promise.all(Array.from({ length: 20 }, () => takeLock(file, HOUR, {})))).filter((token) => token !== null)
  assert.equal(won.length, 1)
  assert.equal(await tokenIn(file), won[0])
})

test('lock race: an expired holder that releases after a replacement leaves the replacement lock in place', async (t) => {
  const file = join(await tempDir(t), 'pr-42.lock')
  const expired = await takeLock(file, 20, {})
  assert.ok(expired !== null)
  await sleep(30)
  const replacement = await takeLock(file, 20, {})
  assert.ok(replacement !== null)
  assert.equal(await releaseLock(file, expired), false)
  assert.equal(await tokenIn(file), replacement)
  assert.equal(await releaseLock(file, replacement), true)
})

test('lock race: an expired holder commits nothing once its lock is replaced, and fails with exit 1', async (t) => {
  const file = join(await tempDir(t), 'runs.json.lock')
  const expired = await takeLock(file, 20, {})
  assert.ok(expired !== null)
  await sleep(30)
  const replacement = await takeLock(file, 20, {})
  assert.ok(replacement !== null)
  let committed = false
  await assert.rejects(
    whileHolding(file, expired, async () => {
      committed = true
    }),
    (error) => error instanceof Failure && error.code === 1,
  )
  assert.equal(committed, false)
  await whileHolding(file, replacement, async () => {
    committed = true
  })
  assert.equal(committed, true)
})
