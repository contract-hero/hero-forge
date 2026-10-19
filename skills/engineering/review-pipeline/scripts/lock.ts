// Lock files: an exclusive create is the whole lock, so two callers that race
// for one lock give one winner. A lock whose file is older than its TTL is
// free again, so a crashed holder does not block it forever.
//
// The per-PR lock that `route` takes is `<state root>/locks/pr-<N>.lock`.
// Ending a run releases it (releasePrLock); until then it holds for
// LOCK_TTL_HOURS.
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Failure, LOCK_TTL_HOURS } from './cli.ts'
import { stateRoot } from './run-state.ts'

const HOUR = 60 * 60 * 1000

// A break guard older than this was left by a caller that crashed while it
// replaced a stale lock.
const GUARD_TTL_MS = 60 * 1000

// Create `file` with `content` only when it does not exist. False: it exists.
async function createOnly(file: string, content: string): Promise<boolean> {
  try {
    await writeFile(file, content, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false
    throw error
  }
}

// Milliseconds since `file` last changed, or null when it does not exist.
async function age(file: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(file)).mtimeMs
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw error
  }
}

// Take the lock `file`, holding `content` (who holds it, for a human who
// looks), unless a holder younger than `ttlMs` has it. True: taken.
export async function takeLock(file: string, ttlMs: number, content: string): Promise<boolean> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  if (await createOnly(file, content)) return true
  const held = await age(file)
  if (held !== null && held < ttlMs) return false
  // The lock is stale. Only the caller that creates the break guard may
  // replace it, and it checks the age again inside the guard, so two callers
  // that both saw the lock stale cannot both take it.
  const guard = `${file}.break`
  if (!(await createOnly(guard, content))) {
    const guardAge = await age(guard)
    if (guardAge !== null && guardAge >= GUARD_TTL_MS) await rm(guard, { force: true })
    return false
  }
  try {
    const again = await age(file)
    if (again !== null && again < ttlMs) return false
    await rm(file, { force: true })
    return await createOnly(file, content)
  } finally {
    await rm(guard, { force: true })
  }
}

export async function releaseLock(file: string): Promise<void> {
  await rm(file, { force: true })
}

// Run `fn` while holding the lock `file`, waiting up to `waitMs` for it.
export async function withLock<T>(file: string, ttlMs: number, waitMs: number, fn: () => Promise<T>): Promise<T> {
  const until = Date.now() + waitMs
  const content = `${JSON.stringify({ pid: process.pid, taken_at: new Date().toISOString() })}\n`
  while (!(await takeLock(file, ttlMs, content))) {
    if (Date.now() >= until) throw new Failure(`cannot take the lock ${file}: another process holds it`, 1)
    await sleep(25)
  }
  try {
    return await fn()
  } finally {
    await releaseLock(file)
  }
}

export function prLockFile(pr: number): string {
  return join(stateRoot(), 'locks', `pr-${pr}.lock`)
}

// Take the per-PR lock for one run. False: a run that is not older than the
// TTL holds it.
export function takePrLock(pr: number, holder: Record<string, unknown>): Promise<boolean> {
  const content = `${JSON.stringify({ pr, ...holder, taken_at: new Date().toISOString() })}\n`
  return takeLock(prLockFile(pr), LOCK_TTL_HOURS * HOUR, content)
}

export function releasePrLock(pr: number): Promise<void> {
  return releaseLock(prLockFile(pr))
}
