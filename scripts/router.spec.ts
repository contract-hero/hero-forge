// Tests that the ask-forge router maps every shipped skill and no other,
// read from the real files.
//   node --test scripts/router.spec.ts
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'node:test'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

const BUCKETS = ['engineering', 'productivity']

const ROUTER = 'skills/engineering/ask-forge'

// Claude Code commands the router names that are not skills.
const BUILT_INS = ['clear', 'compact']

// Each skill name: a folder in a bucket that holds a SKILL.md.
function shipped() {
  return BUCKETS.flatMap((bucket) =>
    readdirSync(join(REPO, 'skills', bucket), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(REPO, 'skills', bucket, entry.name, 'SKILL.md')))
      .map((entry) => entry.name),
  ).sort()
}

// Every `/name` the router's files name, without the slash.
function routed() {
  const text = readdirSync(join(REPO, ROUTER))
    .filter((file) => file.endsWith('.md'))
    .map((file) => readFileSync(join(REPO, ROUTER, file), 'utf8'))
    .join('\n')
  return [...new Set([...text.matchAll(/`\/([a-z][a-z0-9-]*)/g)].map((match) => match[1] ?? ''))].sort()
}

test('ask-forge names every shipped skill but itself', () => {
  const names = routed()
  const missing = shipped().filter((skill) => skill !== 'ask-forge' && !names.includes(skill))
  assert.deepEqual(missing, [])
})

test('ask-forge names no skill that is gone', () => {
  const skills = shipped()
  const gone = routed().filter((name) => !skills.includes(name) && !BUILT_INS.includes(name))
  assert.deepEqual(gone, [])
})
