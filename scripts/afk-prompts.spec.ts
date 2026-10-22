// The router and reconcile prompt templates of setup-forge, read from the real
// files: how each run leaves its own T3 thread, and how setup-forge brings an
// existing task up to the current template.
//   node --test scripts/afk-prompts.spec.ts
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SETUP = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'engineering', 'setup-forge')
const read = (file: string) => readFileSync(join(SETUP, file), 'utf8')
const ROUTER = read('router-prompt.md')
const RECONCILE = read('reconcile-prompt.md')
const SKILL = read('SKILL.md')

// Each phrase appears in `text`, in this order.
function inOrder(text: string, phrases: string[]): void {
  let at = 0
  for (const phrase of phrases) {
    const next = text.indexOf(phrase, at)
    assert.ok(next !== -1, `"${phrase}" is missing, or out of order`)
    at = next + phrase.length
  }
}

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
  assert.match(ROUTER, /Each exit is one line, as each step says, and the last two steps come before it/)
})

test('the reconcile prompt ends by settling its thread on a clean sweep, and marking it unread on a stop or a failed launch', () => {
  const last = lastStep(RECONCILE)
  assert.match(last, /^\d+\. Every exit above: as the last action, before you write its line, call `t3_thread_organize` with no `threadId`/)
  assert.ok(last.includes(`${SETTLE}a \`reconcile: started ...\` line with \`failed 0\` and no message of step 4`), 'no settle for a clean sweep')
  assert.doesNotMatch(last, /action `archive`/)
  assert.match(last, /action `mark_unread` for a `stop: \.\.\.` exit, and for a `reconcile:` line with a failed launch or a message of step 4/)
  assert.match(last, /A session with no `t3_thread_organize` tool skips this step/)
})

// An AFK run cannot mark its own thread unread while its run is active
// (#74), so it puts the thread on the unread list. The reconcile marks each
// listed thread once its run has ended, in the clone's workspaceRoot, right
// after it finds the project, so a sweep that stops later still marks them.
test('the reconcile prompt marks the threads on the unread list, and drops each one only once it is marked or gone', () => {
  const step = RECONCILE.slice(RECONCILE.indexOf('review.ts unread list'))
  assert.ok(RECONCILE.indexOf('review.ts unread list') > RECONCILE.indexOf('t3_project_list'), 'the drain runs before the project is found')
  assert.ok(RECONCILE.indexOf('review.ts unread list') < RECONCILE.indexOf('review.ts reconcile --repo'), 'the drain runs before the sweep command')
  inOrder(step, ['`t3_thread_organize` with action `mark_unread` and `threadId`', '`thread_not_found`', '`review.ts unread done --thread <thread>`', 'no completed run', 'keep'])
  assert.match(step, /never changes the exit line/)
})

// T3 starts each run of an unbound task in a new worktree, and the MCP task
// API cannot set its workspace. The run edits nothing in it, so it removes it.
const REMOVE = 'remove this thread\'s own worktree: call `t3_worktree_status`. When `attached` is true and its `worktreePath` is not its `projectWorkspaceRoot`, run `git -C <projectWorkspaceRoot> worktree remove --force <worktreePath> && git -C <projectWorkspaceRoot> branch -D <branch>`'

// The numbered step just before the last one.
function stepBeforeLast(text: string): string {
  const steps = [...text.matchAll(/^\d+\. /gm)]
  const [before, last] = steps.slice(-2)
  assert.ok(before?.index !== undefined && last?.index !== undefined, 'fewer than two numbered steps')
  return text.slice(before.index, last.index)
}

test('the router and reconcile prompts remove their own worktree on every exit, just before the thread step', () => {
  for (const [name, text] of [['router', ROUTER], ['reconcile', RECONCILE]] as const) {
    const step = stepBeforeLast(text)
    assert.match(step, /^\d+\. Every exit above: /, name)
    assert.ok(step.includes(REMOVE), `${name}: no removal of its own worktree`)
    assert.match(step, /This is the last shell command of the run/, name)
    assert.match(step, /A failure changes nothing: the exit line stays as it is/, name)
    assert.match(lastStep(text), /^\d+\. Every exit above: as the last action/, name)
  }
  assert.match(RECONCILE, /End with one line, as step \d+ says, and the last two steps come before it/)
})

test('setup-forge step 6 says each router and reconcile run removes its own worktree, and how to remove the ones earlier runs left', () => {
  assert.match(SKILL, /\*\*Each run's worktree\.\*\* T3 starts each run of a router or reconcile task in a new worktree of the project/)
  assert.match(SKILL, /`schedule_task` and `update_scheduled_task` cannot set a task's workspace, and `list_scheduled_tasks` does not show it/)
  assert.match(SKILL, /so each run removes its own worktree as its last shell command/)
  assert.match(SKILL, /\*\*Worktrees earlier runs left\.\*\*/)
  assert.match(SKILL, /only while no AFK run is in flight, and remove only the worktrees the user approves/)
  assert.match(SKILL, /is not the worktree this thread runs in/)
  assert.match(SKILL, /A worktree outside that folder is never a candidate/)
  assert.match(SKILL, /Show the user every line of `<list file>`: the worktree and its branch\. Ask them to approve the list/)
})

// The two shell blocks of "Worktrees earlier runs left": the list, then the removal.
function cleanupBlocks(): [string, string] {
  const start = SKILL.indexOf('**Worktrees earlier runs left.**')
  const end = SKILL.indexOf('**6.1 ', start)
  const blocks = [...SKILL.slice(start, end).matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1])
  assert.equal(blocks.length, 2, 'not exactly two shell blocks')
  return [blocks[0], blocks[1]]
}

test('the cleanup of earlier worktrees lists only clean, merged T3 worktrees, and removes only the approved lines', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'afk-cleanup-')))
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  try {
    const origin = join(tmp, 'origin.git')
    const root = join(tmp, 'root')
    const t3dir = join(tmp, 't3')
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
    git(tmp, 'clone', '-q', origin, root)
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
    git(root, 'push', '-q', 'origin', 'main')
    mkdirSync(t3dir)
    const add = (path: string, branch: string) => git(root, 'worktree', 'add', '-q', '-b', branch, path, 'origin/main')
    add(join(t3dir, 'leftover'), 'chore/route-1')
    add(join(t3dir, 'kept-by-user'), 'chore/route-2')
    add(join(t3dir, 'dirty'), 'chore/dirty')
    writeFileSync(join(t3dir, 'dirty', 'new.txt'), 'x')
    add(join(t3dir, 'ahead'), 'feat/ahead')
    git(join(t3dir, 'ahead'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'ahead')
    add(join(t3dir, 'self'), 'chore/self')
    add(join(tmp, 'manual'), 'manual')

    const list = join(tmp, 'list.tsv')
    const fill = (block: string) => block
      .replaceAll('<workspaceRoot>', root)
      .replaceAll('<T3 worktree folder>', t3dir)
      .replaceAll('<default branch>', 'main')
      .replaceAll('<list file>', list)
    const [listBlock, removeBlock] = cleanupBlocks()
    execFileSync('bash', ['-c', fill(listBlock)], { cwd: join(t3dir, 'self'), stdio: 'pipe' })
    const lines = readFileSync(list, 'utf8').trim().split('\n').sort()
    assert.deepEqual(lines, [`${join(t3dir, 'kept-by-user')}\tchore/route-2`, `${join(t3dir, 'leftover')}\tchore/route-1`])

    // The user keeps one line: it leaves the file before the removal.
    writeFileSync(list, `${join(t3dir, 'leftover')}\tchore/route-1\n`)
    execFileSync('bash', ['-c', fill(removeBlock)], { cwd: join(t3dir, 'self'), stdio: 'pipe' })
    const left = git(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).sort()
    assert.deepEqual(left, [root, join(t3dir, 'ahead'), join(t3dir, 'dirty'), join(t3dir, 'kept-by-user'), join(t3dir, 'self'), join(tmp, 'manual')].sort())
    assert.equal(git(root, 'branch', '--list', 'chore/route-1'), '')
    assert.notEqual(git(root, 'branch', '--list', 'chore/route-2'), '')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
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

// The worker runs Claude Code plugin commands, so its thread must not take the
// model of the router or reconcile thread, which can run on a small model. The
// launch table names the worker model of each action.
const WORKER_MODEL = '`modelSelection` `{instanceId: "claudeAgent", model: <the worker model of the table>}`'

test('the router and reconcile prompts launch the worker on the worker model of its table row', () => {
  for (const [name, text] of [['router', ROUTER], ['reconcile', RECONCILE]] as const) {
    const launch = text.split('\n').find((line) => line.includes('with `t3_thread_launch`'))
    assert.ok(launch, `${name}: no launch step`)
    assert.ok(launch.includes(WORKER_MODEL), `${name}: the launch passes no worker model`)
    assert.match(launch, /\(always set it: the worker runs Claude Code plugin commands/, name)
  }
})

// review and recheck workers only do bookkeeping around Codex runs; the other
// actions write code or judge findings, so they keep the strongest model.
const LIGHT = ['review', 'recheck']

test('the launch table runs review and recheck on <<light_worker_model>>, every other action on <<worker_model>>', () => {
  for (const [name, text] of [['router', ROUTER], ['reconcile', RECONCILE]] as const) {
    assert.match(text, /[Pp]ick the launch message, with `<n>` the `pr` or the `issue` of the decision, its base and its worker model:/, name)
    assert.match(text, /^   \| action \| message \| base \| worker model \|$/m, name)
    const rows = text.split('\n').filter((line) => /^   \| `/.test(line))
    assert.equal(rows.length, 7, `${name}: the table has 7 actions`)
    for (const row of rows) {
      const action = row.match(/^   \| `([a-z-]+)`/)?.[1] ?? ''
      const model = LIGHT.includes(action) ? '<<light_worker_model>>' : '<<worker_model>>'
      assert.ok(row.endsWith(` | \`${model}\` |`), `${name}: ${action} runs on ${model}`)
    }
  }
})

test('setup-forge says how it fills <<worker_model>> and <<light_worker_model>>, and fills both in both templates', () => {
  assert.match(SKILL, /`<<worker_model>>`: the model of this thread when `orchestrator_capabilities` gives `inheritedProviderInstanceId` `claudeAgent` \(its `inheritedModel`\), else the newest Claude Opus model of the `claudeAgent` provider in its catalog/)
  assert.match(SKILL, /`<<light_worker_model>>`: the newest Claude Sonnet model of the `claudeAgent` provider in the `orchestrator_capabilities` catalog/)
  for (const label of ['6.2 The router tasks.', '6.4 The reconcile task.']) {
    assert.match(part(label), /each `<<worker_model>>` by the worker model, each `<<light_worker_model>>` by the light worker model/, label)
  }
})

test('setup-forge step 6 says the tasks can run on a small model and the workers stay on Claude', () => {
  assert.doesNotMatch(SKILL, /Tell the user, so they run this part from a thread with the model and runtime mode the runs should use/)
  assert.match(SKILL, /The T3 tasks copy the provider, the model and the runtime mode of the thread that creates them/)
  assert.match(SKILL, /each worker thread runs on the Claude model its row of the launch table names/)
  assert.match(SKILL, /`review` and `recheck` run on `<<light_worker_model>>`/)
  assert.match(SKILL, /a small model is enough for the tasks/)
  assert.match(SKILL, /`update_scheduled_task` has no model field/)
})
