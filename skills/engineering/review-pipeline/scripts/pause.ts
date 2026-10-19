// The pause record: one small file per paused issue or PR, under the state
// root, `<state root>/pauses/<issue|pr>-<N>.json`. A run that stops at a
// one-way door writes it (with the needs-info label and a push notification,
// #29); `route --app implementer` reads it, and turns the maintainer's
// answer on that issue or PR into `resume`. The resumed run deletes it.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Failure, isRepo, parse, positive, repoOption, runMain, usageFor } from './cli.ts'
import { stateRoot } from './run-state.ts'

export type PauseSubject = { kind: 'issue' | 'pr'; number: number }

// `reason`: the question the run asks the maintainer. `paused_at`: an ISO time.
export type PauseRecord = PauseSubject & { repo: string; reason: string; paused_at: string }

const FIELDS: Record<keyof PauseRecord, (v: unknown) => boolean> = {
  kind: (v) => v === 'issue' || v === 'pr',
  number: (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
  repo: isRepo,
  reason: (v) => typeof v === 'string' && v !== '',
  paused_at: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
}

export function pauseFile({ kind, number }: PauseSubject): string {
  return join(stateRoot(), 'pauses', `${kind}-${number}.json`)
}

// Why `value` is not the record of `subject`, or undefined when it is.
function problem(value: unknown, subject: PauseSubject): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not a JSON object'
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) if (!Object.hasOwn(FIELDS, key)) return `unknown field "${key}"`
  for (const [key, ok] of Object.entries(FIELDS)) if (!ok(obj[key])) return `bad or missing "${key}"`
  if (obj.kind !== subject.kind || obj.number !== subject.number) return `it is the record of ${String(obj.kind)} ${String(obj.number)}`
  return undefined
}

// The pause record of `subject`, or null when there is none. A record that
// is there but invalid exits 4.
export async function readPause(subject: PauseSubject): Promise<PauseRecord | null> {
  const file = pauseFile(subject)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw new Failure(`cannot read ${file}: ${(error as Error).message}`, 1)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Failure(`corrupt pause record ${file}: ${(error as Error).message}. Delete it to drop the pause`, 4)
  }
  const wrong = problem(value, subject)
  if (wrong !== undefined) throw new Failure(`corrupt pause record ${file}: ${wrong}. Delete it to drop the pause`, 4)
  return value as PauseRecord
}

// Write the pause record, replacing any earlier one of the same issue or PR
// in one rename, so a reader never sees half a record.
export async function writePause(record: PauseRecord): Promise<void> {
  const wrong = problem(record, record)
  if (wrong !== undefined) throw new Failure(`cannot write a pause record: ${wrong}`, 1)
  const file = pauseFile(record)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${randomBytes(6).toString('hex')}`
  const { kind, number, repo, reason, paused_at } = record
  try {
    await writeFile(tmp, `${JSON.stringify({ kind, number, repo, reason, paused_at })}\n`, { mode: 0o600 })
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
}

// Delete the pause record of `subject`. False: there was none.
export async function deletePause(subject: PauseSubject): Promise<boolean> {
  try {
    await rm(pauseFile(subject))
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false
    throw error
  }
}

const usage = usageFor('pause')

// `review.ts pause` (usage in the table in cli.ts): the AFK skills write the
// record at a one-way door, and the resumed run reads and deletes it.
async function pause(argv: string[]): Promise<string> {
  const [command, ...rest] = argv
  if (command !== 'write' && command !== 'read' && command !== 'delete') throw usage(`unknown command "${command ?? ''}"`)
  const { values } = parse(
    rest,
    { repo: { type: 'string' }, issue: { type: 'string' }, pr: { type: 'string' }, reason: { type: 'string' } },
    usage,
  )
  if ((values.issue === undefined) === (values.pr === undefined)) throw usage(`pause ${command} needs one of --issue and --pr`)
  const subject: PauseSubject =
    values.pr !== undefined ? { kind: 'pr', number: positive('pr', values.pr, usage) } : { kind: 'issue', number: positive('issue', values.issue, usage) }
  if (command === 'write') {
    const repo = repoOption(values.repo, usage)
    const reason = values.reason?.trim() ?? ''
    if (reason === '') throw usage('pause write needs --reason: the question the run asks')
    const record: PauseRecord = { ...subject, repo, reason, paused_at: new Date().toISOString() }
    await writePause(record)
    return `${JSON.stringify(record)}\n`
  }
  if (command === 'read') {
    const record = await readPause(subject)
    if (record === null) throw new Failure(`no pause record for ${subject.kind} #${subject.number} at ${pauseFile(subject)}`, 3)
    return `${JSON.stringify(record)}\n`
  }
  return `${JSON.stringify({ ...subject, deleted: await deletePause(subject) })}\n`
}

export const main = runMain('pause', pause)
