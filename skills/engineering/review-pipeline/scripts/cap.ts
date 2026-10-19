// The daily run cap of each App: one small file per App that every repo on
// the machine shares, `<cap dir>/<app>-app-runs.json`. It is a JSON list of
// the ISO times of the runs the App started in the last 24 hours (a rolling
// window, not a calendar day). The cap dir is ~/.config/hero-forge/,
// overridable for tests with HERO_FORGE_CAP_DIR.
//
// The Implementer's attempt cap: `<cap dir>/implementer-app-attempts.json`, a
// JSON map from `O/R#N` to the number of builds `route` started for that
// ticket or spec. A build reserves its attempt with one check and increment
// under the file's lock, so two callers can never both take the last one.
// It never resets by itself: a ticket at its cap stays ignored until a human
// lowers its count or removes its entry.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Failure } from './cli.ts'
import { whileHolding, withLock } from './lock.ts'

const DAY = 24 * 60 * 60 * 1000

// A process holds the cap file's lock for one read and one write. Its write
// commits only while it still owns that lock.
const LOCK_TTL_MS = 30 * 1000
const LOCK_WAIT_MS = 5 * 1000

function capDir(): string {
  return process.env.HERO_FORGE_CAP_DIR || join(homedir(), '.config', 'hero-forge')
}

export function capFile(app: string): string {
  return join(capDir(), `${app}-app-runs.json`)
}

export function attemptsFile(): string {
  return join(capDir(), 'implementer-app-attempts.json')
}

async function readRuns(file: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return []
    throw new Failure(`cannot read ${file}: ${(error as Error).message}`, 1)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    value = undefined
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)))) {
    throw new Failure(`corrupt run cap file ${file}: not a JSON list of times. Delete it to reset the count`, 4)
  }
  return value
}

// Write `text` to `file` in one rename, only while `token` still owns `lock`.
async function commit(file: string, text: string, lock: string, token: string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}`
  try {
    await writeFile(tmp, text, { mode: 0o600 })
    await whileHolding(lock, token, () => rename(tmp, file))
  } finally {
    await rm(tmp, { force: true })
  }
}

// Count one run of `app` toward its cap of `limit` runs in 24 hours. Returns
// the time it counted (for `uncountRun`), or null: the cap is reached, and
// nothing is counted.
export async function countRun(app: string, limit: number): Promise<string | null> {
  const file = capFile(app)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const lock = `${file}.lock`
  return withLock(lock, LOCK_TTL_MS, LOCK_WAIT_MS, async (token) => {
    const now = Date.now()
    const runs = (await readRuns(file)).filter((at) => now - Date.parse(at) < DAY)
    if (runs.length >= limit) return null
    const at = new Date(now).toISOString()
    runs.push(at)
    await commit(file, `${JSON.stringify(runs)}\n`, lock, token)
    return at
  })
}

// Give back the run of `app` counted at `at`, for a run that never started.
// False: that run is not counted (it left the 24 hours, or was given back).
export async function uncountRun(app: string, at: string): Promise<boolean> {
  const file = capFile(app)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const lock = `${file}.lock`
  return withLock(lock, LOCK_TTL_MS, LOCK_WAIT_MS, async (token) => {
    const runs = await readRuns(file)
    const index = runs.indexOf(at)
    if (index === -1) return false
    runs.splice(index, 1)
    await commit(file, `${JSON.stringify(runs)}\n`, lock, token)
    return true
  })
}

async function readAttempts(file: string): Promise<Record<string, number>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return {}
    throw new Failure(`cannot read ${file}: ${(error as Error).message}`, 1)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    value = undefined
  }
  const ok =
    typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.values(value).every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)
  if (!ok) throw new Failure(`corrupt attempts file ${file}: not a JSON map of counts. Fix or delete it`, 4)
  return value as Record<string, number>
}

const ticketKey = (repo: string, issue: number) => `${repo}#${issue}`

// Change the count of ticket `issue` of `repo` under the attempts file's
// lock: `change` gets the count and returns the new one, or null to write
// nothing. A count of 0 drops the entry. Returns what `change` returned.
async function changeAttempts(repo: string, issue: number, change: (count: number) => number | null): Promise<number | null> {
  const file = attemptsFile()
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const lock = `${file}.lock`
  return withLock(lock, LOCK_TTL_MS, LOCK_WAIT_MS, async (token) => {
    const attempts = await readAttempts(file)
    const key = ticketKey(repo, issue)
    const next = change(attempts[key] ?? 0)
    if (next === null) return null
    if (next === 0) delete attempts[key]
    else attempts[key] = next
    await commit(file, `${JSON.stringify(attempts)}\n`, lock, token)
    return next
  })
}

// Reserve one build of ticket `issue` of `repo`, under its cap of `limit`.
// False: the ticket has used every attempt, and nothing is reserved.
export async function reserveAttempt(repo: string, issue: number, limit: number): Promise<boolean> {
  return (await changeAttempts(repo, issue, (count) => (count < limit ? count + 1 : null))) !== null
}

// Give back a reservation that started no build.
export async function releaseAttempt(repo: string, issue: number): Promise<void> {
  await changeAttempts(repo, issue, (count) => (count > 0 ? count - 1 : null))
}
