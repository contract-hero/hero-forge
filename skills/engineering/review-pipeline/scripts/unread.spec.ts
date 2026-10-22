// The unread list (#74). T3 refuses `mark_unread` on a thread whose latest
// run is still active, so an AFK run cannot mark its own thread. It adds its
// thread id with `review.ts unread add`, and the hourly reconcile, a later
// run, lists the ids, marks each thread unread, and drops it with `done`.
import assert from 'node:assert/strict'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseEnv, runCli, tempDir } from './test-helpers.ts'

// A real T3 thread id: it holds `:` and `%`.
const THREAD = 'thread:delegated-task:command%3Amcp%3A15bfe003%3Adelegate-task%3Aprobe-74'
const OTHER = 'mcp:670b3ab8-bdaa-4cd1-af55-8eb0e8ed1f7c'

// `review.ts unread` with its own state root.
async function unreadCli(t: Parameters<typeof tempDir>[0]) {
  const root = await tempDir(t)
  return { root, cli: (...args: string[]) => runCli(['unread', ...args], { env: { ...baseEnv(), HERO_FORGE_STATE_DIR: root } }) }
}

const lines = (stdout: string) => stdout.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { thread: string; added_at: string })

test('unread add records a thread, and list prints it with the time it was added', async (t) => {
  const s = await unreadCli(t)
  assert.equal((await s.cli('list')).stdout, '')
  const before = Date.now()
  const added = await s.cli('add', '--thread', THREAD)
  assert.equal(added.stderr, '')
  assert.equal(added.code, 0)
  assert.deepEqual(JSON.parse(added.stdout), { thread: THREAD, added: true })
  const listed = await s.cli('list')
  assert.equal(listed.code, 0, listed.stderr)
  const [record, ...rest] = lines(listed.stdout)
  assert.deepEqual(rest, [])
  assert.equal(record?.thread, THREAD)
  assert.ok(Date.parse(record?.added_at ?? '') >= before - 1000 && Date.parse(record?.added_at ?? '') <= Date.now())
  // One file per thread under <state root>/unread/, whatever the id holds.
  assert.equal((await readdir(join(s.root, 'unread'))).filter((f) => f.endsWith('.json')).length, 1)
})

// A late notification turn does the thread step again: the second add of the
// same thread changes nothing.
test('unread add of a thread already on the list keeps the one record and its time', async (t) => {
  const s = await unreadCli(t)
  await s.cli('add', '--thread', THREAD)
  const [first] = lines((await s.cli('list')).stdout)
  const again = await s.cli('add', '--thread', THREAD)
  assert.equal(again.code, 0, again.stderr)
  assert.deepEqual(JSON.parse(again.stdout), { thread: THREAD, added: false })
  assert.deepEqual(lines((await s.cli('list')).stdout), [first])
})

test('unread list prints the oldest thread first, and done drops one thread only', async (t) => {
  const s = await unreadCli(t)
  await s.cli('add', '--thread', THREAD)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await s.cli('add', '--thread', OTHER)
  assert.deepEqual(lines((await s.cli('list')).stdout).map((r) => r.thread), [THREAD, OTHER])
  const done = await s.cli('done', '--thread', THREAD)
  assert.equal(done.code, 0, done.stderr)
  assert.deepEqual(JSON.parse(done.stdout), { thread: THREAD, deleted: true })
  assert.deepEqual(lines((await s.cli('list')).stdout).map((r) => r.thread), [OTHER])
  assert.deepEqual(JSON.parse((await s.cli('done', '--thread', THREAD)).stdout), { thread: THREAD, deleted: false })
})

// One bad file must not hide the other threads from the sweep.
test('unread list skips a corrupt record with a line on stderr, and still prints the others', async (t) => {
  const s = await unreadCli(t)
  await s.cli('add', '--thread', THREAD)
  await writeFile(join(s.root, 'unread', 'broken.json'), '{"thread": ')
  const listed = await s.cli('list')
  assert.equal(listed.code, 4)
  assert.deepEqual(lines(listed.stdout).map((r) => r.thread), [THREAD])
  assert.match(listed.stderr, /broken\.json/)
})

test('unread needs a command it knows, and --thread for add and done: else a usage error (exit 2) that writes nothing', async (t) => {
  const s = await unreadCli(t)
  for (const args of [[], ['mark'], ['add'], ['add', '--thread', ''], ['add', '--thread', 'a b'], ['add', '--thread', 'x'.repeat(513)], ['done'], ['list', '--thread', THREAD]]) {
    const result = await s.cli(...args)
    assert.equal(result.code, 2, args.join(' '))
    assert.match(result.stderr, /^review\.ts unread: .*\nusage:\n/, args.join(' '))
  }
  assert.equal((await s.cli('list')).stdout, '')
})
