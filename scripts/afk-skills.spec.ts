// The AFK path of implement-pr, review-pipeline and implement-spec-stack, read
// from the real SKILL.md files: the order rules the router depends on, and
// every helper CLI call they name against the CLI's own usage table.
//   node --test scripts/afk-skills.spec.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { COMMANDS } from '../skills/engineering/review-pipeline/scripts/cli.ts'

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'engineering')
const read = (skill: string) => readFileSync(join(SKILLS, skill, 'SKILL.md'), 'utf8')
const IMPLEMENT_PR = read('implement-pr')
const PIPELINE = read('review-pipeline')
const STACK = read('implement-spec-stack')
const THREAD_STEP = readFileSync(join(SKILLS, 'review-pipeline', 'afk-thread-step.md'), 'utf8')

// The text of the `## <heading>` section, up to the next `## ` heading.
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`)
  assert.ok(start !== -1, `no section "${heading}"`)
  const end = text.indexOf('\n## ', start + 1)
  return text.slice(start, end === -1 ? undefined : end)
}

// Each needle appears in `text`, in this order.
function inOrder(text: string, needles: string[]): void {
  let at = -1
  for (const needle of needles) {
    const next = text.indexOf(needle, at + 1)
    assert.ok(next > at, `"${needle}" is missing or out of order`)
    at = next
  }
}

// The pause record comes first: its paused_at is the pause boundary, set
// before anyone can see the question, so an early answer still counts.
test('implement-pr --afk pauses at a one-way door: the pause record, then the comment, then needs-info, a push notification, the lock release', () => {
  const afk = section(IMPLEMENT_PR, 'Decisions in an AFK run')
  assert.match(afk, /\*\*A one-way door\*\*: a data shape, a public API, a new dependency, a migration, or a destructive action/)
  inOrder(afk, [
    'review.ts pause write --repo <owner/repo> --issue <ticket> --reason',
    'review.ts implementer comment --repo <owner/repo> --issue <ticket> --body-file <file>',
    'review.ts implementer label --repo <owner/repo> --issue <ticket> --add needs-info',
    'push notification',
    'review.ts lock release --issue <ticket> --token <token>',
  ])
  assert.match(afk, /add `--decisions-file <file>`/)
  assert.match(section(IMPLEMENT_PR, 'Resume after a pause'), /The record's `decisions` \(the entries logged before the pause\) come back as the first entries of that section/)
})

test('implement-pr --afk logs its two-way decisions in the PR body and hands nothing to review-pipeline', () => {
  assert.match(IMPLEMENT_PR, /With `--afk`, add a `## Decisions` section above the closing line/)
  const handOff = section(IMPLEMENT_PR, '6. Hand off to the review pipeline')
  assert.match(handOff, /With `--afk`, do not call `review-pipeline`.*Run `review\.ts lock release --issue <ticket> --token <token>`/)
  const resume = section(IMPLEMENT_PR, 'Resume after a pause')
  inOrder(resume, ['review.ts pause read --issue <ticket>', 'created in or after the whole second of the record\'s `paused_at`', '--remove needs-info', 'review.ts pause delete --issue <ticket>'])
})

test('review-pipeline --afk: each part ends with advance, then the lock release, then the hand-off as the last action', () => {
  const afk = section(PIPELINE, 'AFK run')
  inOrder(afk, ['`run-state advance` to the new phase', 'review.ts lock release --pr N --token <token>', 'then the hand-off as the last post'])
  inOrder(afk, ['ends after `advance review-posted`', 'lock release', 'review.ts handoff --app reviewer --repo O/R --pr N --kind review-posted --round <R>'])
  inOrder(afk, ['ends after `advance adjudicated`', 'lock release', 'review.ts handoff --app implementer --repo O/R --pr N --kind adjudicated --round <R>'])
  inOrder(afk, ['prints `review-posted`', 'lock release', 'review.ts handoff --app reviewer --repo O/R --pr N --kind recheck-failed --round <the new round>'])
  inOrder(afk, ['prints `stopped`', 'REQUEST_CHANGES', 'release the lock', 'push notification', 'no hand-off'])
  assert.match(afk, /review\.ts implementer push --repo O\/R --branch <the worktree's branch> --to <headRefName>/)
  assert.match(afk, /`git reset --hard origin\/<headRefName>`/)
  inOrder(section(PIPELINE, 'AFK run'), ['review.ts pause write --repo O/R --pr N', 'review.ts implementer comment --repo O/R --issue N', '--add needs-info', 'push notification', 'review.ts lock release --pr N --token <token>'])
  assert.match(afk, /A PR whose run state has mode `layer` or `stack-final`, terminal or not, stays under its stack/)
})

test('review-pipeline keeps the Decisions section when Finish rewrites the PR body', () => {
  assert.match(section(PIPELINE, 'Finish'), /Keep the old body's `## Decisions` section whole too/)
})

test('implement-spec-stack --afk pushes a restacked layer as the Implementer App, with the lease on its old tip', () => {
  assert.match(STACK, /with `--afk`, as the Implementer App instead: `review\.ts implementer push --repo O\/R --branch <C branch> --force-with-lease <old_tip>`/)
  assert.match(STACK, /The run ends after step 9 with `review\.ts lock release --issue <spec> --token <token>`/)
})

test('implement-pr --afk stays on the router\'s local branch and pushes to the ticket branch with --to', () => {
  const branch = section(IMPLEMENT_PR, '3. Pick the branch')
  assert.doesNotMatch(branch, /git checkout -B/)
  assert.match(branch, /you stay on that branch: never check out the ticket branch itself/)
  assert.match(IMPLEMENT_PR, /review\.ts implementer push --repo <owner\/repo> --branch <the worktree's branch> --to <ticket branch>/)
  assert.match(section(IMPLEMENT_PR, 'Decisions in an AFK run'), /add `--branch <ticket branch> --tip <the commit it pushed>`/)
})

// The reviewer App's router starts the review when the PR opens, so the
// simplify commit must be on the branch before the push that opens it.
test('implement-pr and implement-spec-stack simplify the build before the push', () => {
  inOrder(section(IMPLEMENT_PR, '4. Build it'), ['Call the Skill tool with "tdd"', 'call the Skill tool with "simplify"', 'git revert --no-edit <the simplify commit>', 'Then push it: `git push -u origin <branch>`'])
  inOrder(STACK, ['calls the Skill tool with `tdd`', 'calls the Skill tool with `simplify`', 'git revert --no-edit <the simplify commit>', 'Then it pushes (`git push -u origin <branch>`)', 'gh pr create --draft --base <base>'])
  // A pass with no change makes no commit, so a revert would undo the build.
  assert.match(section(IMPLEMENT_PR, '4. Build it'), /Push only when both checks pass: when they still fail, stop and report the output/)
  assert.match(STACK, /It pushes only when both checks pass: when they still fail, it stops and reports the output/)
  assert.match(section(IMPLEMENT_PR, '4. Build it'), /When either fails.*When it changes nothing, it makes no commit, so nothing is reverted/)
  assert.match(STACK, /When either fails.*When the pass changes nothing, it makes no commit, so nothing is reverted/)
})

test('implement-pr updates an existing PR\'s Decisions section before the hand-off', () => {
  inOrder(section(IMPLEMENT_PR, '3. Pick the branch'), ['An open PR whose body closes this ticket', 'its `## Decisions` section keeps the earlier entries and gains each decision of this build', 'gh pr edit <PR> --body-file <file>', 'go to step 6'])
})

test('review-pipeline --afk adjudicate checks the Implementer App first, replies only as the App, and waits on a pause', () => {
  const afk = section(PIPELINE, 'AFK run')
  assert.match(afk, /Before `adjudicate` posts anything, check the Implementer App's credentials: `review\.ts app-token --repo O\/R --app implementer --check`/)
  assert.match(afk, /`reply \.\.\. --as implementer`, which posts as the Implementer App or not at all/)
  assert.match(afk, /Without `--resume`, a pause record for the PR .* release the lock and end/)
  assert.match(afk, /`adjudicate` at phase `adjudicated`/)
  assert.match(afk, /When it runs again, the phase shows its work is done, so it does none of it again: it releases the lock and posts the hand-off/)
})

test('implement-spec-stack holds its own pause and resume protocol, and resumes a paused layer from its pushed tip', () => {
  assert.doesNotMatch(STACK, /implement-pr/)
  inOrder(STACK, [
    'review.ts pause write --repo O/R --issue <spec> --reason "<the question, on one line>" --branch <layer branch> --tip <the tip it pushed>',
    'add `--decisions-file <file>`',
    'review.ts implementer comment --repo O/R --issue <spec> --body-file <file>',
    'review.ts implementer label --repo O/R --issue <spec> --add needs-info',
    'push notification',
    'review.ts lock release --issue <spec> --token <token>',
  ])
  inOrder(STACK, ['review.ts pause read --issue <spec>', '--remove needs-info', 'review.ts pause delete --issue <spec>'])
  assert.match(section(STACK, 'Resume'), /a layer with no PR whose branch is on GitHub .* from its pushed tip, never from the parent base/)
})

// The run's own T3 thread is the last thing an AFK run touches: settled when
// the run leaves nothing for the maintainer, marked unread when it needs them.
const THREAD = /t3_thread_organize|`settle`|`mark_unread`|settle the thread|mark the thread unread/

// The thread rule lives once, in review-pipeline/afk-thread-step.md: the
// tool, both actions, the late notification turn (a queued notification keeps
// a settled thread active), the skip, and the by-hand path.
test('the shared thread step holds the tool, both actions, the late notification turn and the skip', () => {
  inOrder(THREAD_STEP, ['`t3_thread_organize` with no `threadId`', 'action `settle`', 'action `mark_unread`', 'Settling takes effect when the turn ends', 'A turn that starts only because a background job or a subagent reported', 'does the thread step again, with the same action, and ends', 'A session with no `t3_thread_organize` tool skips this step'])
  assert.match(THREAD_STEP, /A run without `--afk` never settles, archives or marks its thread/)
})

// T3 refuses `mark_unread` on a thread whose latest run is active, also from
// a queued follow-up turn (#74). So the run puts its own thread on the unread
// list, and the daily reconcile marks it after the run ends.
test('the shared thread step puts the thread on the unread list for reconcile, and never calls mark_unread on its own thread', () => {
  const mark = THREAD_STEP.slice(THREAD_STEP.indexOf('action `mark_unread`'))
  inOrder(mark, ['T3 refuses `mark_unread` on a thread whose latest run is still active', 'also from a queued follow-up turn', '`t3_thread_configuration` with no `threadId`', '`review.ts unread add --thread <threadId>`', 'neither settles the thread nor calls `mark_unread`', 'The daily reconcile', 'marks the thread unread'])
  assert.match(mark, /`review\.ts` cannot run .* push notification only/)
  assert.doesNotMatch(THREAD_STEP, /`t3_thread_organize` with no `threadId` and action `mark_unread`/)
})

// Each skill points to the shared thread step, names its own outcomes for both
// actions, and holds no copy of the shared rule.
function threadRule(text: string, pointer: string): void {
  inOrder(text, [pointer, 'action `settle`', 'action `mark_unread`'])
  for (const shared of ['Settling takes effect when the turn ends', 'review.ts unread add', 'T3 refuses `mark_unread`', 'A turn that starts only because a background job or a subagent reported', 'A session with no `t3_thread_organize` tool skips this step', 'A run without `--afk` never settles']) {
    assert.ok(!text.includes(shared), `"${shared}" is copied out of afk-thread-step.md`)
  }
}
const SIBLING_THREAD_STEP = '`<the folder this SKILL.md is in>/../review-pipeline/afk-thread-step.md`'

// `text` with every paragraph that starts `With \`--afk\`` taken out.
const withoutAfkParagraphs = (text: string) => text.split('\n\n').filter((p) => !p.startsWith('With `--afk`')).join('\n\n')

test('implement-pr --afk settles its thread after the PR, and marks it unread on a pause or a stop', () => {
  const top = IMPLEMENT_PR.slice(IMPLEMENT_PR.indexOf('**AFK run.**'), IMPLEMENT_PR.indexOf('\n## 1.'))
  threadRule(top, SIBLING_THREAD_STEP)
  inOrder(top, ['releases the lock', 'mark the thread unread', 'and ends'])
  inOrder(section(IMPLEMENT_PR, '6. Hand off to the review pipeline'), ['review.ts lock release --issue <ticket> --token <token>', 'settle the thread', 'and end'])
  inOrder(section(IMPLEMENT_PR, 'Decisions in an AFK run'), ['review.ts lock release --issue <ticket> --token <token>', 'mark the thread unread', 'Open no PR'])
  const resume = section(IMPLEMENT_PR, 'Resume after a pause')
  inOrder(resume, ['Exit 3 (no pause record): release the lock, settle the thread, and end', 'No answer: release the lock, settle the thread, and end'])
})

test('review-pipeline --afk settles its thread after the hand-off or the merge, and marks it unread on a pause or a stop', () => {
  const afk = section(PIPELINE, 'AFK run')
  threadRule(afk, '[afk-thread-step.md](./afk-thread-step.md)')
  inOrder(afk, ['then the hand-off as the last post: nothing posts after it', 'settle the thread'])
  inOrder(afk, ['prints `stopped`', 'push notification', 'mark the thread unread', 'no hand-off'])
  inOrder(afk, ['A re-checker that failed twice', 'mark the thread unread'])
  inOrder(afk, ['**Stops.**', 'release the lock, mark the thread unread, and end with no hand-off'])
  inOrder(afk, ['**One-way door in `adjudicate`.**', 'review.ts lock release --pr N --token <token>', 'mark the thread unread'])
})

test('implement-spec-stack --afk settles its thread after step 9, and marks it unread on a pause or a stop', () => {
  const afk = STACK.slice(STACK.indexOf('**AFK run.**'), STACK.indexOf('Without `--afk`, every step works as written.'))
  threadRule(afk, SIBLING_THREAD_STEP)
  assert.match(afk, /send a push notification with the message .*, run `review\.ts lock release --issue <spec> --token <token>`, mark the thread unread, and end/)
  assert.match(afk, /The run ends after step 9 with `review\.ts lock release --issue <spec> --token <token>`, then settle the thread/)
  inOrder(afk, ['**Pause**', 'review.ts lock release --issue <spec> --token <token>`, mark the thread unread, and end'])
  inOrder(afk, ['**Resume after a pause**', 'Exit 3 (no pause record): release the lock, settle the thread, and end', 'No answer: release the lock, settle the thread, and end'])
})

test('the by-hand paths never settle, archive or mark their thread', () => {
  const byHand: [string, string][] = [
    ['implement-pr', withoutAfkParagraphs(IMPLEMENT_PR.replace(IMPLEMENT_PR.slice(IMPLEMENT_PR.indexOf('**AFK run.**'), IMPLEMENT_PR.indexOf('\n## 1.')), '').replace(section(IMPLEMENT_PR, 'Decisions in an AFK run'), '').replace(section(IMPLEMENT_PR, 'Resume after a pause'), ''))],
    ['review-pipeline', PIPELINE.replace(section(PIPELINE, 'AFK run'), '')],
    ['implement-spec-stack', STACK.replace(STACK.slice(STACK.indexOf('**AFK run.**'), STACK.indexOf('Without `--afk`, every step works as written.')), '')],
  ]
  for (const [name, text] of byHand) assert.doesNotMatch(text, THREAD, `${name} names the thread step outside its AFK text`)
})

// `review.ts <subcommand> [<command>] --flag ...` in a SKILL.md, for the
// subcommands of the AFK path.
const CALL = /review\.ts (handoff|lock release|pause (?:write|read|delete)|implementer (?:push|pr|comment|label)|app-token)((?: --[a-z-]+(?: [^\s`-][^\s`]*)?)*)/g

test('every AFK helper CLI call in the three SKILL.md files uses only flags its usage text names', () => {
  let calls = 0
  for (const [name, text] of [['implement-pr', IMPLEMENT_PR], ['review-pipeline', PIPELINE], ['implement-spec-stack', STACK]] as const) {
    for (const match of text.matchAll(CALL)) {
      const [subcommand = ''] = match[1]!.split(' ')
      const usage = COMMANDS[subcommand as keyof typeof COMMANDS].usage
      for (const flag of match[2]!.match(/--[a-z-]+/g) ?? []) {
        assert.ok(usage.includes(flag), `${name}: "${match[0]}" uses ${flag}, which the ${subcommand} usage does not name`)
      }
      calls++
    }
  }
  assert.ok(calls >= 15, `only ${calls} calls found`)
})
