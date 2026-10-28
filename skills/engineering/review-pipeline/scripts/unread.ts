// The unread list: the T3 threads of AFK runs that ended needing the
// maintainer, one small file per thread under the state root,
// `<state root>/unread/<sha256 of the thread id>.json`. T3 refuses
// `mark_unread` on a thread whose latest run is still active, so a run cannot
// mark its own thread, not even from a queued follow-up turn (#74). The run
// adds its thread id; the daily reconcile lists the ids, marks each thread
// unread, and drops it with `done`. Two reconcile tasks on one clone may mark
// the same thread twice: that is harmless.
import { createHash, randomBytes } from 'node:crypto'
import { link, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Failure, parse, runMain, usageFor } from './cli.ts'
import { stateRoot } from './run-state.ts'

type UnreadRecord = { thread: string; added_at: string }

const usage = usageFor('unread')

// The file name of a thread's record: its id holds `:` and `%`.
const fileName = (thread: string) => `${createHash('sha256').update(thread).digest('hex')}.json`

// A T3 thread id: printable, no whitespace, at most 512 characters.
const isThread = (v: unknown): v is string => typeof v === 'string' && /^[\x21-\x7e]{1,512}$/.test(v)

function threadOption(value: unknown, command: string): string {
  if (value === undefined) throw usage(`unread ${command} needs --thread: the T3 thread id`)
  if (!isThread(value)) throw usage('--thread must be a T3 thread id: printable, no spaces, at most 512 characters')
  return value
}

// Add the thread once. A second add keeps the first record and its time:
// false. The record is written whole to a temp file, then linked into place,
// which fails when the file is there, so a reader never sees half a record.
async function add(dir: string, thread: string): Promise<boolean> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, fileName(thread))
  const tmp = `${file}.${randomBytes(6).toString('hex')}`
  try {
    await writeFile(tmp, `${JSON.stringify({ thread, added_at: new Date().toISOString() })}\n`, { mode: 0o600 })
    await link(tmp, file)
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false
    throw error
  } finally {
    await rm(tmp, { force: true })
  }
}

// Every record, oldest first, and the files that do not hold one.
async function list(dir: string): Promise<{ records: UnreadRecord[]; corrupt: string[] }> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { records: [], corrupt: [] }
    throw error
  }
  const records: UnreadRecord[] = []
  const corrupt: string[] = []
  await Promise.all(names.filter((n) => n.endsWith('.json')).map(async (name) => {
    try {
      const value = JSON.parse(await readFile(join(dir, name), 'utf8')) as Partial<UnreadRecord>
      if (isThread(value.thread) && typeof value.added_at === 'string' && !Number.isNaN(Date.parse(value.added_at)) && fileName(value.thread) === name) {
        records.push({ thread: value.thread, added_at: value.added_at })
        return
      }
    } catch {}
    corrupt.push(join(dir, name))
  }))
  corrupt.sort()
  records.sort((a, b) => Date.parse(a.added_at) - Date.parse(b.added_at))
  return { records, corrupt }
}

// `review.ts unread` (usage in the table in cli.ts).
async function unread(argv: string[]): Promise<string | number> {
  const [command, ...rest] = argv
  if (command !== 'add' && command !== 'list' && command !== 'done') throw usage(`unknown command "${command ?? ''}"`)
  const { values } = parse(rest, { thread: { type: 'string' } }, usage)
  if (command === 'list' && values.thread !== undefined) throw usage('unread list takes no --thread')
  const dir = join(stateRoot(), 'unread')
  if (command === 'list') {
    const { records, corrupt } = await list(dir)
    process.stdout.write(records.map((r) => `${JSON.stringify(r)}\n`).join(''))
    for (const file of corrupt) process.stderr.write(`review.ts unread: corrupt record ${file}. Delete it to drop it\n`)
    return corrupt.length === 0 ? 0 : 4
  }
  const thread = threadOption(values.thread, command)
  if (command === 'add') return `${JSON.stringify({ thread, added: await add(dir, thread) })}\n`
  const file = join(dir, fileName(thread))
  try {
    await rm(file)
    return `${JSON.stringify({ thread, deleted: true })}\n`
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return `${JSON.stringify({ thread, deleted: false })}\n`
    throw new Failure(`cannot delete ${file}: ${(error as Error).message}`, 1)
  }
}

export const main = runMain('unread', unread)
