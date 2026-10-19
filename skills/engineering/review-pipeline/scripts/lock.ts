// Lock files with one exclusion protocol for every take, reclaim and release.
//
// A short-held guard file next to the lock (`<lock>.guard`, an exclusive
// create) is held only for the few milliseconds of a check and a write. Under
// the guard: no lock, or a lock older than its TTL, is replaced by a new one;
// a younger lock refuses. Each take writes a random owner token into the
// lock and returns it. Release, and any write that must happen only while
// the lock is held (whileHolding), check the token under the guard, so a
// holder whose lock expired and was replaced can neither remove the new
// lock nor commit its work.
//
// The guard carries an owner token too. A guard older than GUARD_TTL_MS was
// left by a crashed process (a holder keeps it for milliseconds). Only the
// holder of the breaker (`<lock>.guard.break`, an exclusive create) may
// delete a guard: a stale break deletes it only when it still has the token
// the caller saw stale and is still stale, and a holder's own release only
// when it still has the holder's token. A caller that cannot take the
// breaker deletes nothing and tries again.
//
// Two assumptions are left. The breaker is never deleted for its age: a
// breaker older than GUARD_TTL_MS means a process crashed in the few
// microseconds while it held one, and every caller then exits 1 and names
// it, for a human to remove by hand. And a holder never stalls inside the
// guard for GUARD_TTL_MS: a guard is a lease with no fencing, so a holder
// that stalled that long may finish its check and write after another
// caller broke its guard and took a new one.
//
// The locks that `route` take are `<state root>/locks/pr-<N>.lock` (a review,
// a re-check, an Adjudication, a resume on a PR) and
// `<state root>/locks/issue-<N>.lock` (a build, a resume on an issue). Each
// holds for LOCK_TTL_HOURS unless the run releases it with its token.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Failure, LOCK_TTL_HOURS } from './cli.ts'
import { stateRoot } from './run-state.ts'

const HOUR = 60 * 60 * 1000

const GUARD_TTL_MS = 60 * 1000

// How long a caller waits for the guard: long enough to break a guard that a
// crashed process left.
const GUARD_WAIT_MS = GUARD_TTL_MS + 5 * 1000

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

// Delete the guard `guard` only if it still holds `token`, while holding its
// breaker. Every delete of a guard (a stale break, or a holder's own release)
// goes through here, so no delete can remove a guard another caller took in
// the meantime. With `stale`, the guard must also be older than GUARD_TTL_MS.
// 'deleted', 'kept' (another token, or not stale), or 'busy' (another caller
// holds the breaker). A breaker older than GUARD_TTL_MS: exit 1.
async function deleteGuard(guard: string, token: string | null, stale: boolean): Promise<'deleted' | 'kept' | 'busy'> {
  const breaker = `${guard}.break`
  if (!(await createOnly(breaker, `${process.pid}\n`))) {
    const breakerAge = await age(breaker)
    if (breakerAge !== null && breakerAge >= GUARD_TTL_MS) {
      throw new Failure(`${breaker} is older than ${GUARD_TTL_MS / 1000} s: a process crashed while it deleted a guard. Remove it by hand`, 1)
    }
    return 'busy'
  }
  try {
    const now = await age(guard)
    if (now === null || (stale && now < GUARD_TTL_MS) || (await tokenOf(guard)) !== token) return 'kept'
    await rm(guard, { force: true })
    return 'deleted'
  } finally {
    await rm(breaker, { force: true })
  }
}

// Delete the guard `guard` if it still holds `seen` (the token a caller saw)
// and is still stale. True: this call deleted it. A breaker that another
// caller holds: false, nothing deleted.
export async function breakGuard(guard: string, seen: string | null): Promise<boolean> {
  return (await deleteGuard(guard, seen, true)) === 'deleted'
}

// Release this caller's own guard: delete it only while it still holds
// `token` (one broken as stale is another caller's now), waiting out a busy
// breaker.
export async function releaseGuard(guard: string, token: string): Promise<void> {
  const until = Date.now() + GUARD_WAIT_MS
  while ((await deleteGuard(guard, token, false)) === 'busy') {
    if (Date.now() >= until) throw new Failure(`cannot release the guard ${guard}: its breaker stays busy`, 1)
    await sleep(2)
  }
}

// Run `fn` while holding the guard of the lock `file`.
async function underGuard<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const guard = `${file}.guard`
  const token = randomBytes(16).toString('hex')
  const until = Date.now() + GUARD_WAIT_MS
  while (!(await createOnly(guard, `${JSON.stringify({ token, pid: process.pid })}\n`))) {
    const seen = await tokenOf(guard)
    const guardAge = await age(guard)
    if (guardAge !== null && guardAge >= GUARD_TTL_MS && (await breakGuard(guard, seen))) continue
    if (Date.now() >= until) throw new Failure(`cannot take the guard ${guard}: another process holds it`, 1)
    await sleep(2)
  }
  try {
    return await fn()
  } finally {
    await releaseGuard(guard, token)
  }
}

// The owner token in the lock `file`, or null when there is no lock or no
// token in it.
async function tokenOf(file: string): Promise<string | null> {
  try {
    const token = (JSON.parse(await readFile(file, 'utf8')) as { token?: unknown }).token
    return typeof token === 'string' ? token : null
  } catch {
    return null
  }
}

// Take the lock `file` unless a holder younger than `ttlMs` has it. Returns
// the owner token, or null when the lock is held. `holder` is written beside
// the token, for a human who looks.
export async function takeLock(file: string, ttlMs: number, holder: Record<string, unknown>): Promise<string | null> {
  const token = randomBytes(16).toString('hex')
  return underGuard(file, async () => {
    const held = await age(file)
    if (held !== null && held < ttlMs) return null
    await writeFile(file, `${JSON.stringify({ ...holder, token, taken_at: new Date().toISOString() })}\n`, { mode: 0o600 })
    return token
  })
}

// Remove the lock `file` if `token` still owns it. False: it does not (the
// lock expired and another caller took it, or it is gone).
export function releaseLock(file: string, token: string): Promise<boolean> {
  return underGuard(file, async () => {
    if ((await tokenOf(file)) !== token) return false
    await rm(file, { force: true })
    return true
  })
}

// Run `fn` only while `token` still owns the lock `file`, under its guard.
// A holder that lost its lock runs nothing and fails with exit 1.
export function whileHolding<T>(file: string, token: string, fn: () => Promise<T>): Promise<T> {
  return underGuard(file, async () => {
    if ((await tokenOf(file)) !== token) throw new Failure(`lost the lock ${file}: it expired and another process took it`, 1)
    return fn()
  })
}

// Run `fn` with the token of the lock `file`, waiting up to `waitMs` for it.
export async function withLock<T>(file: string, ttlMs: number, waitMs: number, fn: (token: string) => Promise<T>): Promise<T> {
  const until = Date.now() + waitMs
  let token: string | null
  while ((token = await takeLock(file, ttlMs, { pid: process.pid })) === null) {
    if (Date.now() >= until) throw new Failure(`cannot take the lock ${file}: another process holds it`, 1)
    await sleep(25)
  }
  try {
    return await fn(token)
  } finally {
    await releaseLock(file, token)
  }
}

export function prLockFile(pr: number): string {
  return join(stateRoot(), 'locks', `pr-${pr}.lock`)
}

// Take the per-PR lock for one run. Returns its token, or null when a run
// that is not older than the TTL holds it.
export function takePrLock(pr: number, holder: Record<string, unknown>): Promise<string | null> {
  return takeLock(prLockFile(pr), LOCK_TTL_HOURS * HOUR, { pr, ...holder })
}

export function releasePrLock(pr: number, token: string): Promise<boolean> {
  return releaseLock(prLockFile(pr), token)
}

export function issueLockFile(issue: number): string {
  return join(stateRoot(), 'locks', `issue-${issue}.lock`)
}

// Take the per-issue lock for one build or resume of an issue that is not a
// PR. Returns its token, or null when a run younger than the TTL holds it.
export function takeIssueLock(issue: number, holder: Record<string, unknown>): Promise<string | null> {
  return takeLock(issueLockFile(issue), LOCK_TTL_HOURS * HOUR, { issue, ...holder })
}

export function releaseIssueLock(issue: number, token: string): Promise<boolean> {
  return releaseLock(issueLockFile(issue), token)
}
