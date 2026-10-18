// Tests that the skills an agent starts by name are model-invoked, read from
// the real skill files.
//   node --test scripts/invocation.spec.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'node:test'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

// Agents and routers start these through the Skill tool, but only by name.
const BY_NAME = ['implement-pr', 'implement-spec-stack', 'setup-review-pipeline']

function read(skill: string, file: string) {
  return readFileSync(join(REPO, 'skills', 'engineering', skill, file), 'utf8')
}

// The YAML block between the first two `---` lines of a SKILL.md.
function frontmatter(skill: string) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(read(skill, 'SKILL.md'))
  assert.ok(match, `${skill}/SKILL.md has no frontmatter`)
  return match[1] ?? ''
}

function description(skill: string) {
  const match = /^description: "(.*)"$/m.exec(frontmatter(skill))
  assert.ok(match, `${skill}/SKILL.md has no quoted description`)
  return match[1] ?? ''
}

for (const skill of BY_NAME) {
  test(`${skill}: SKILL.md does not disable model invocation`, () => {
    assert.doesNotMatch(frontmatter(skill), /^disable-model-invocation:\s*true\s*$/m)
  })

  test(`${skill}: agents/openai.yaml does not disable implicit invocation`, () => {
    assert.doesNotMatch(read(skill, 'agents/openai.yaml'), /^\s*allow_implicit_invocation:\s*false\s*$/m)
  })

  test(`${skill}: the description limits triggering to an explicit request by name`, () => {
    const text = description(skill)
    assert.match(text, /Use only on an explicit request for this skill by name/)
    assert.ok(text.includes(`the user runs /${skill}`), text)
    assert.ok(text.includes(`an agent or router asks for ${skill} through the Skill tool`), text)
    assert.match(text, /Do not start it because /)
  })
}
