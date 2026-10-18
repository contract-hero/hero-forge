// Tests that the repo ships exactly the skills in its two buckets, read from
// the real files: the plugin manifest, the top-level README and the bucket
// READMEs.
//   node --test scripts/skills.spec.ts
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'node:test'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

const BUCKETS = ['engineering', 'productivity']

function dirs(path: string) {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

// Each skill as `<bucket>/<name>`: a folder in a bucket that holds a SKILL.md.
function shipped() {
  return BUCKETS.flatMap((bucket) =>
    dirs(join(REPO, 'skills', bucket))
      .filter((name) => existsSync(join(REPO, 'skills', bucket, name, 'SKILL.md')))
      .map((name) => `${bucket}/${name}`),
  ).sort()
}

function read(path: string) {
  return readFileSync(join(REPO, path), 'utf8')
}

test('skills/ holds only the engineering and productivity buckets', () => {
  assert.deepEqual(dirs(join(REPO, 'skills')), BUCKETS)
})

test("the plugin's skills array lists every skill in the two buckets, and nothing else", () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json')) as { skills: string[] }
  const listed = manifest.skills.map((path) => path.replace(/^\.\/skills\//, '')).sort()
  assert.deepEqual(listed, shipped())
})

test('the top-level README links every shipped skill to its SKILL.md', () => {
  const readme = read('README.md')
  const missing = shipped().filter((skill) => !readme.includes(`](./skills/${skill}/SKILL.md)`))
  assert.deepEqual(missing, [])
})

test('each bucket README links every skill in its bucket to its SKILL.md', () => {
  const missing = shipped().filter((skill) => {
    const [bucket, name] = skill.split('/')
    return !read(`skills/${bucket}/README.md`).includes(`](./${name}/SKILL.md)`)
  })
  assert.deepEqual(missing, [])
})
