// Lock races. These few tests call lock.ts's exported functions, not the CLI:
// the interleavings they check cannot be driven through `review.ts route`.
// The last ones drive `review.ts lock release`.
import assert from 'node:assert/strict'
import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Failure } from './cli.ts'
import { breakGuard, releaseGuard, releaseLock, takeIssueLock, takeLock, takePrLock, whileHolding } from './lock.ts'
import { baseEnv, runCli, tempDir } from './test-helpers.ts'

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

test('guard race: callers that all see one stale guard break it once, and the fresh guard survives the others', async (t) => {
  const file = join(await tempDir(t), 'pr-42.lock')
  const token = await takeLock(file, HOUR, {})
  assert.ok(token !== null)
  // A guard left by a crashed process, which every caller below sees stale.
  await writeFile(`${file}.guard`, `${JSON.stringify({ token: 'crashed' })}\n`)
  const old = new Date(Date.now() - 2 * 60 * 1000)
  await utimes(`${file}.guard`, old, old)
  let inside = 0
  let most = 0
  const holder = () =>
    whileHolding(file, token, async () => {
      inside += 1
      most = Math.max(most, inside)
      await sleep(40)
      inside -= 1
    })
  await Promise.all(Array.from({ length: 8 }, holder))
  assert.equal(most, 1)
})

test('guard race: of callers that saw one stale guard, one breaks it, and the fresh guard survives a late break', async (t) => {
  const file = join(await tempDir(t), 'pr-42.lock')
  const guard = `${file}.guard`
  const token = await takeLock(file, HOUR, {})
  assert.ok(token !== null)
  await writeFile(guard, `${JSON.stringify({ token: 'crashed' })}\n`)
  const old = new Date(Date.now() - 2 * 60 * 1000)
  await utimes(guard, old, old)
  // Two callers saw the stale guard 'crashed' and both try to break it.
  const broke = await Promise.all([breakGuard(guard, 'crashed'), breakGuard(guard, 'crashed')])
  assert.equal(broke.filter((b) => b).length, 1)
  // A takes a fresh guard and holds it; a third caller that also saw the
  // stale guard tries to break it late.
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const a = whileHolding(file, token, () => held)
  while (!(await stat(guard).then(() => true, () => false))) await sleep(1)
  const fresh = await readFile(guard, 'utf8')
  assert.equal(await breakGuard(guard, 'crashed'), false)
  assert.equal(await readFile(guard, 'utf8'), fresh)
  release()
  await a
})

test('guard race: a holder whose release waits on a busy breaker never deletes the guard that replaced its own', async (t) => {
  const file = join(await tempDir(t), 'pr-42.lock')
  const guard = `${file}.guard`
  const breaker = `${guard}.break`
  // Holder A owns the guard with token 'a', then stalls before its release.
  await writeFile(guard, `${JSON.stringify({ token: 'a' })}\n`)
  // B holds the breaker: it is breaking A's guard as stale right now.
  await writeFile(breaker, 'b\n')
  let done = false
  const releasing = releaseGuard(guard, 'a').then(() => (done = true))
  await sleep(20)
  assert.equal(done, false, 'the release waits while the breaker is held')
  // B deletes A's guard, takes a fresh one with token 'b', and frees the breaker.
  await writeFile(guard, `${JSON.stringify({ token: 'b' })}\n`)
  await rm(breaker)
  await releasing
  assert.equal(await readFile(guard, 'utf8'), `${JSON.stringify({ token: 'b' })}\n`)
})

test('guard: a holder release deletes its own guard', async (t) => {
  const file = join(await tempDir(t), 'pr-42.lock')
  const guard = `${file}.guard`
  await writeFile(guard, `${JSON.stringify({ token: 'a' })}\n`)
  await releaseGuard(guard, 'a')
  assert.equal(await stat(guard).then(() => true, () => false), false)
})

// `review.ts lock release`: the launched run gives back the lock that route
// took, with the lock_token route printed. The lock is taken in this process
// (as route takes it) and released through the CLI.
async function lockRoot(t: Parameters<typeof tempDir>[0]): Promise<{ root: string; cli: (...args: string[]) => ReturnType<typeof runCli> }> {
  const root = await tempDir(t)
  const before = process.env.HERO_FORGE_STATE_DIR
  process.env.HERO_FORGE_STATE_DIR = root
  t.after(async () => {
    if (before === undefined) delete process.env.HERO_FORGE_STATE_DIR
    else process.env.HERO_FORGE_STATE_DIR = before
  })
  return { root, cli: (...args) => runCli(['lock', ...args], { env: { ...baseEnv(), HERO_FORGE_STATE_DIR: root } }) }
}

for (const [kind, take, file] of [
  ['pr', takePrLock, (root: string) => join(root, 'locks', 'pr-42.lock')],
  ['issue', takeIssueLock, (root: string) => join(root, 'locks', 'issue-42.lock')],
] as const) {
  test(`lock release --${kind} with the owner token removes the lock and prints released: true`, async (t) => {
    const s = await lockRoot(t)
    const token = await take(42, { app: 'implementer' })
    assert.ok(token !== null)
    const result = await s.cli('release', `--${kind}`, '42', '--token', token)
    assert.equal(result.stderr, '')
    assert.equal(result.code, 0)
    assert.deepEqual(JSON.parse(result.stdout), { [kind]: 42, released: true })
    await assert.rejects(stat(file(s.root)))
    assert.ok((await take(42, {})) !== null, 'the lock is free again')
  })

  test(`lock release --${kind} with a token that no longer owns the lock exits 0, released: false, and keeps the new lock`, async (t) => {
    const s = await lockRoot(t)
    const token = await take(42, {})
    assert.ok(token !== null)
    const result = await s.cli('release', `--${kind}`, '42', '--token', 'f'.repeat(32))
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { [kind]: 42, released: false })
    assert.equal(await tokenIn(file(s.root)), token)
  })

  test(`lock release --${kind} of a lock that is gone exits 0, released: false`, async (t) => {
    const s = await lockRoot(t)
    const result = await s.cli('release', `--${kind}`, '42', '--token', 'a'.repeat(32))
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { [kind]: 42, released: false })
  })
}

test('lock release needs exactly one of --pr and --issue, and a lock token: else a usage error (exit 2)', async (t) => {
  const s = await lockRoot(t)
  for (const args of [
    ['release', '--token', 'a'.repeat(32)],
    ['release', '--pr', '1', '--issue', '2', '--token', 'a'.repeat(32)],
    ['release', '--pr', '1'],
    ['release', '--pr', '1', '--token', '../../etc'],
    ['take', '--pr', '1', '--token', 'a'.repeat(32)],
  ]) {
    const result = await s.cli(...args)
    assert.equal(result.code, 2, args.join(' '))
    assert.match(result.stderr, /^review\.ts lock: .*\nusage: review\.ts lock release/, args.join(' '))
  }
})
