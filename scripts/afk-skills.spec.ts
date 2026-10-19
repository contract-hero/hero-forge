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

test('implement-pr --afk pauses at a one-way door: comment, then needs-info, then the pause record, a push notification, the lock release', () => {
  const afk = section(IMPLEMENT_PR, 'Decisions in an AFK run')
  assert.match(afk, /\*\*A one-way door\*\*: a data shape, a public API, a new dependency, a migration, or a destructive action/)
  inOrder(afk, [
    'review.ts implementer comment --repo <owner/repo> --issue <ticket> --body-file <file>',
    'review.ts implementer label --repo <owner/repo> --issue <ticket> --add needs-info',
    'review.ts pause write --repo <owner/repo> --issue <ticket> --reason',
    'push notification',
    'review.ts lock release --issue <ticket> --token <token>',
  ])
})

test('implement-pr --afk logs its two-way decisions in the PR body and hands nothing to review-pipeline', () => {
  assert.match(IMPLEMENT_PR, /With `--afk`, add a `## Decisions` section above the closing line/)
  const handOff = section(IMPLEMENT_PR, '6. Hand off to the review pipeline')
  assert.match(handOff, /With `--afk`, do not call `review-pipeline`.*Run `review\.ts lock release --issue <ticket> --token <token>`/)
  const resume = section(IMPLEMENT_PR, 'Resume after a pause')
  inOrder(resume, ['review.ts pause read --issue <ticket>', 'created after the record\'s `paused_at`', '--remove needs-info', 'review.ts pause delete --issue <ticket>'])
})

test('review-pipeline --afk: each part ends with advance, then the lock release, then the hand-off as the last action', () => {
  const afk = section(PIPELINE, 'AFK run')
  inOrder(afk, ['`run-state advance` to the new phase', 'review.ts lock release --pr N --token <token>', 'then the hand-off as the last action'])
  inOrder(afk, ['ends after `advance review-posted`', 'lock release', 'review.ts handoff --app reviewer --repo O/R --pr N --kind review-posted --round <R>'])
  inOrder(afk, ['ends after `advance adjudicated`', 'lock release', 'review.ts handoff --app implementer --repo O/R --pr N --kind adjudicated --round <R>'])
  inOrder(afk, ['prints `review-posted`', 'lock release', 'review.ts handoff --app reviewer --repo O/R --pr N --kind recheck-failed --round <the new round>'])
  inOrder(afk, ['prints `stopped`', 'REQUEST_CHANGES', 'release the lock', 'push notification', 'no hand-off'])
  assert.match(afk, /review\.ts implementer push --repo O\/R --branch <the worktree's branch> --to <headRefName>/)
  assert.match(afk, /`git reset --hard origin\/<headRefName>`/)
  inOrder(section(PIPELINE, 'AFK run'), ['review.ts implementer comment --repo O/R --issue N', '--add needs-info', 'review.ts pause write --repo O/R --pr N', 'push notification', 'review.ts lock release --pr N --token <token>'])
})

test('review-pipeline keeps the Decisions section when Finish rewrites the PR body', () => {
  assert.match(section(PIPELINE, 'Finish'), /Keep the old body's `## Decisions` section whole too/)
})

test('implement-spec-stack --afk pushes a restacked layer as the Implementer App, with the lease on its old tip', () => {
  assert.match(STACK, /with `--afk`, as the Implementer App instead: `review\.ts implementer push --repo O\/R --branch <C branch> --force-with-lease <old_tip>`/)
  assert.match(STACK, /The run ends after step 9 with `review\.ts lock release --issue <spec> --token <token>`/)
})

// `review.ts <subcommand> [<command>] --flag ...` in a SKILL.md, for the
// subcommands of the AFK path.
const CALL = /review\.ts (handoff|lock release|pause (?:write|read|delete)|implementer (?:push|pr|comment|label))((?: --[a-z-]+(?: [^\s`-][^\s`]*)?)*)/g

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
