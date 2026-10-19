// The router and reconcile prompt templates of setup-forge, read from the real
// files: how each run leaves its own T3 thread, and how setup-forge brings an
// existing task up to the current template.
//   node --test scripts/afk-prompts.spec.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SETUP = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'engineering', 'setup-forge')
const read = (file: string) => readFileSync(join(SETUP, file), 'utf8')
const ROUTER = read('router-prompt.md')
const RECONCILE = read('reconcile-prompt.md')
const SKILL = read('SKILL.md')

// The last numbered step of a prompt template.
function lastStep(text: string): string {
  const steps = [...text.matchAll(/^\d+\. /gm)]
  const last = steps.at(-1)
  assert.ok(last?.index !== undefined, 'no numbered step')
  return text.slice(last.index)
}

// The `**<label>**` paragraph of setup-forge's SKILL.md, up to the next one.
function part(label: string): string {
  const start = SKILL.indexOf(`**${label}**`)
  assert.ok(start !== -1, `no part "${label}"`)
  const end = SKILL.indexOf('\n**6.', start + 1)
  return SKILL.slice(start, end === -1 ? undefined : end)
}

// Settling this thread waits for the turn to end; archiving it cuts the turn,
// so the run fails before it writes its line.
const SETTLE = 'action `settle` (it takes effect when this turn ends; `archive` would cut the turn) for '

test('the router prompt ends by settling its thread on ignore or started, and marking it unread on stop', () => {
  const last = lastStep(ROUTER)
  assert.match(last, /^\d+\. Every exit above: as the last action, before you write its line, call `t3_thread_organize` with no `threadId`/)
  assert.ok(last.includes(`${SETTLE}an \`ignore: ...\` or \`started: ...\` exit`), 'no settle for ignore or started')
  assert.doesNotMatch(last, /action `archive`/)
  assert.match(last, /action `mark_unread` for a `stop: \.\.\.` exit/)
  assert.match(last, /A session with no `t3_thread_organize` tool skips this step/)
  assert.match(ROUTER, /Each exit is one line, as each step says, and the last step comes before it/)
})

test('the reconcile prompt ends by settling its thread on a clean sweep, and marking it unread on a stop or a failed launch', () => {
  const last = lastStep(RECONCILE)
  assert.match(last, /^\d+\. Every exit above: as the last action, before you write its line, call `t3_thread_organize` with no `threadId`/)
  assert.ok(last.includes(`${SETTLE}a \`reconcile: started ...\` line with \`failed 0\` and no message of step 3`), 'no settle for a clean sweep')
  assert.doesNotMatch(last, /action `archive`/)
  assert.match(last, /action `mark_unread` for a `stop: \.\.\.` exit, and for a `reconcile:` line with a failed launch or a message of step 3/)
  assert.match(last, /A session with no `t3_thread_organize` tool skips this step/)
})

test('setup-forge 6.2 and 6.4 update an existing task\'s prompt in place, and nothing else of it', () => {
  const router = part('6.2 The router tasks.')
  assert.match(router, /When its `prompt` differs from the filled template, call `update_scheduled_task` with its `scheduledTaskId` and the new `prompt` only: its URL, its secret and its trigger stay/)
  assert.match(router, /in place of `<<clone_root>>`, use the path the task's prompt already holds/)
  assert.match(router, /A plugin update that changes a prompt template reaches the live tasks when this part runs again/)
  const reconcile = part('6.4 The reconcile task.')
  assert.match(reconcile, /When its `prompt` differs from the filled template, call `update_scheduled_task` with its `scheduledTaskId` and the new `prompt` only: its schedule stays/)
})

test('setup-forge 6.2 and 6.4 create a task only when none exists, and leave a matching one as it is', () => {
  for (const label of ['6.2 The router tasks.', '6.4 The reconcile task.']) {
    const text = part(label)
    assert.match(text, /When its `prompt` is the same as the filled template, change nothing/, label)
    assert.match(text, /Only when no such task exists/, label)
    assert.doesNotMatch(text, /\bElse\b/, label)
  }
})
