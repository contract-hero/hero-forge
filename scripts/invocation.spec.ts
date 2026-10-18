// Tests that every skill is model-invoked, read from the real skill files.
//   node --test scripts/invocation.spec.ts
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'node:test'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

const BUCKETS = ['engineering', 'productivity']

// Each skill as `<bucket>/<name>`: a folder in a bucket that holds a SKILL.md.
function skills() {
  return BUCKETS.flatMap((bucket) =>
    readdirSync(join(REPO, 'skills', bucket), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(REPO, 'skills', bucket, entry.name, 'SKILL.md')))
      .map((entry) => `${bucket}/${entry.name}`),
  ).sort()
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : []
  })
}

// The YAML block between the first two `---` lines of a SKILL.md.
function frontmatter(skill: string) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(join(REPO, 'skills', skill, 'SKILL.md'), 'utf8'))
  assert.ok(match, `${skill}/SKILL.md has no frontmatter`)
  return match[1] ?? ''
}

test('the buckets hold skills', () => {
  assert.ok(skills().length > 0)
})

test('no SKILL.md sets disable-model-invocation', () => {
  const hits = skills().filter((skill) => /^disable-model-invocation:/m.test(frontmatter(skill)))
  assert.deepEqual(hits, [])
})

test('no agents/openai.yaml exists under skills/', () => {
  const hits = files(join(REPO, 'skills'))
    .filter((file) => file.endsWith('openai.yaml'))
    .map((file) => relative(REPO, file))
  assert.deepEqual(hits, [])
})

test('every SKILL.md has a quoted, one-line description', () => {
  const hits = skills().filter((skill) => {
    const match = /^description: "(.+)"$/m.exec(frontmatter(skill))
    return !match
  })
  assert.deepEqual(hits, [])
})

// A skill that builds or lands work names the hand-over that starts it, and
// says that a passing mention does not (.agents/invocation.md).
for (const skill of ['engineering/implement-pr', 'engineering/implement-spec-stack']) {
  test(`${skill} starts on a hand-over for building, not on a mention`, () => {
    const description = /^description: "(.+)"$/m.exec(frontmatter(skill))?.[1] ?? ''
    assert.match(description, /handed over for building/)
    assert.match(description, /Do not start it because .* mentioned/)
  })
}
