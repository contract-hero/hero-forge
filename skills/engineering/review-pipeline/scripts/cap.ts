// The daily run cap of each App: one small file per App that every repo on
// the machine shares, `<cap dir>/<app>-app-runs.json`. It is a JSON list of
// the ISO times of the runs the App started in the last 24 hours (a rolling
// window, not a calendar day). The cap dir is ~/.config/hero-forge/,
// overridable for tests with HERO_FORGE_CAP_DIR.
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

export function capFile(app: string): string {
  const dir = process.env.HERO_FORGE_CAP_DIR || join(homedir(), '.config', 'hero-forge')
  return join(dir, `${app}-app-runs.json`)
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

// Count one run of `app` toward its cap of `limit` runs in 24 hours. False:
// the cap is reached, and nothing is counted.
export async function countRun(app: string, limit: number): Promise<boolean> {
  const file = capFile(app)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const lock = `${file}.lock`
  return withLock(lock, LOCK_TTL_MS, LOCK_WAIT_MS, async (token) => {
    const now = Date.now()
    const runs = (await readRuns(file)).filter((at) => now - Date.parse(at) < DAY)
    if (runs.length >= limit) return false
    runs.push(new Date(now).toISOString())
    const tmp = `${file}.${randomBytes(6).toString('hex')}`
    try {
      await writeFile(tmp, `${JSON.stringify(runs)}\n`, { mode: 0o600 })
      await whileHolding(lock, token, () => rename(tmp, file))
    } finally {
      await rm(tmp, { force: true })
    }
    return true
  })
}
