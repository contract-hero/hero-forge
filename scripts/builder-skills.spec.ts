// The builder path of implement-pr, implement-spec-stack and setup-forge, read
// from the real SKILL.md files: a ticket's builder:<alias> label builds on the
// builder or stops, and never on the worker's own model.
//   node --test scripts/builder-skills.spec.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'engineering')
const read = (...path: string[]) => readFileSync(join(SKILLS, ...path), 'utf8')
const IMPLEMENT_PR = read('implement-pr', 'SKILL.md')
const STACK = read('implement-spec-stack', 'SKILL.md')
const SETUP = read('setup-forge', 'SKILL.md')
const SEED = read('setup-forge', 'review.md')
const BUILDER_STEP = read('review-pipeline', 'builder-step.md')

// The text of the `## <heading>` section, up to the next `## ` heading.
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`)
  assert.ok(start !== -1, `no section "${heading}"`)
  const end = text.indexOf('\n## ', start + 1)
  return text.slice(start, end === -1 ? undefined : end)
}

test('implement-pr reads the builder before it builds, and a refusal builds nothing', () => {
  const build = section(IMPLEMENT_PR, '4. Build it')
  assert.ok(build.startsWith('\n## 4. Build it\n\nFirst find the ticket\'s builder: `review.ts builder --repo <owner/repo> --issue <ticket>`'))
  assert.match(build, /Exit 4 .*, or any other non-zero exit: stop, with the message\. Build nothing: a labelled ticket is never built on your own model\./)
  assert.match(section(IMPLEMENT_PR, '3. Pick the branch'), /build only what is still missing \(through the ticket's builder when it has one, as step 4 says\)/)
})

test('the shared builder step builds through delegate_task, and stops on each missing piece', () => {
  assert.match(section(IMPLEMENT_PR, 'Build with a builder'), /Read `<the folder this SKILL\.md is in>\/\.\.\/review-pipeline\/builder-step\.md` and follow it/)
  const builder = BUILDER_STEP
  assert.match(builder, /you never write or change a line of its code/)
  assert.match(builder, /With no `delegate_task`, stop: `builder <alias>: this session has no delegate_task tool`/)
  assert.match(builder, /Call `orchestrator_capabilities` with `search: "<model>"`/)
  assert.match(builder, /stop and name it: the provider, the model or the effort/)
  assert.match(builder, /`isolation: "shared"`, `mode: "async"`/)
  assert.match(builder, /start one new `delegate_task` on the same builder and target \(steps 1 and 2 hold already\), with the same brief and the failing output\. When a check still fails after that, stop and report the output: you never fix its code/)
  assert.match(section(IMPLEMENT_PR, '5. Open the draft PR'), /the Evidence names it: `Built by builder <alias>: <model> at <effort> effort \(<provider>\)\.`/)
})

test('implement-spec-stack resolves every layer builder before it builds, and each layer uses its own', () => {
  assert.match(STACK, /run `review\.ts builder --repo O\/R --issue <ticket>` for each layer\. A non-zero exit for any layer: stop with the message, and build nothing/)
  // A resume skips step 2, so each implementer reads its own builder again.
  assert.match(STACK, /   - runs `review\.ts builder --repo O\/R --issue <ticket>`, also on a resume\. A non-zero exit: it stops and reports the message, and builds nothing\. An implementer subagent that finds a builder here .* also stops and reports it, and builds nothing: you then build that layer yourself;/)
  assert.match(STACK, /Each layer uses its own ticket's builder, so one stack can mix builders/)
  // A builder's completion wakes only the thread that started it, so the main
  // session builds a labelled layer, never an implementer subagent.
  assert.match(STACK, /A layer whose ticket has a builder \(step 2\) gets no implementer subagent, because a builder's completion wakes only the thread that started it, never a subagent/)
  assert.match(STACK, /For a layer with a builder, you read `<the folder this SKILL\.md is in>\/\.\.\/review-pipeline\/builder-step\.md` and follow it in the layer's worktree, in place of `tdd`/)
  assert.match(BUILDER_STEP, /Only that thread gets the wake, so a subagent never starts a builder/)
})

test('setup-forge writes the builders and creates their labels, and the seed template shows them', () => {
  assert.match(SETUP, /\*Builders\.\*/)
  assert.ok(SETUP.includes('```yaml\nbuilders:\n  astra:\n    provider: codex\n    model: gpt-6.2-astra\n    effort: xhigh\n```'))
  assert.match(SETUP, /create the `builder:<alias>` label of each builder that the repo lacks: `gh label create "builder:<alias>"/)
  assert.match(SEED, /\nbuilders: .*\n  <alias>:\n    provider: <T3 provider instance id>\n    model: <model>\n    effort: <effort>\n```/)
})
