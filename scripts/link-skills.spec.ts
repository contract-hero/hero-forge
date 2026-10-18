// Tests that scripts/link-skills.sh links every skill into ~/.claude/skills
// and writes nothing else under $HOME. Runs the real script with a temp HOME.
//   node --test scripts/link-skills.spec.ts
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'node:test'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

const BUCKETS = ['engineering', 'productivity']

// Each skill folder that holds a SKILL.md, as an absolute path.
function skillDirs() {
  return BUCKETS.flatMap((bucket) =>
    readdirSync(join(REPO, 'skills', bucket), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(REPO, 'skills', bucket, entry.name, 'SKILL.md')))
      .map((entry) => join(REPO, 'skills', bucket, entry.name)),
  ).sort()
}

function runWithHome(seed: (home: string) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'link-skills-'))
  seed(home)
  execFileSync('bash', [join(REPO, 'scripts', 'link-skills.sh')], {
    env: { ...process.env, HOME: home },
    stdio: 'pipe',
  })
  return home
}

test('link-skills.sh writes only ~/.claude under HOME', () => {
  const home = runWithHome()
  try {
    assert.deepEqual(readdirSync(home), ['.claude'])
    assert.deepEqual(readdirSync(join(home, '.claude')), ['skills'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('link-skills.sh links every skill into ~/.claude/skills, and nothing else', () => {
  const home = runWithHome()
  try {
    const dest = join(home, '.claude', 'skills')
    const entries = readdirSync(dest).sort()
    for (const name of entries) {
      assert.ok(lstatSync(join(dest, name)).isSymbolicLink(), `${name} is not a symlink`)
    }
    const targets = entries.map((name) => readlinkSync(join(dest, name))).sort()
    assert.deepEqual(targets, skillDirs())
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('link-skills.sh removes its own links to skills that are gone, and keeps every other entry', () => {
  const outside = mkdtempSync(join(tmpdir(), 'link-skills-outside-'))
  const home = runWithHome((home) => {
    const dest = join(home, '.claude', 'skills')
    mkdirSync(dest, { recursive: true })
    // A link this script made before a skill was renamed: it points into this repo's skills/.
    symlinkSync(join(REPO, 'skills', 'engineering', 'renamed-away'), join(dest, 'renamed-away'))
    // The user's own entries: a link outside the repo (live and dangling) and a real folder.
    symlinkSync(outside, join(dest, 'user-link'))
    symlinkSync(join(outside, 'gone'), join(dest, 'user-dangling'))
    mkdirSync(join(dest, 'user-folder'))
  })
  try {
    const dest = join(home, '.claude', 'skills')
    const entries = readdirSync(dest)
    assert.ok(!entries.includes('renamed-away'), 'the stale link into this repo is still there')
    for (const name of ['user-link', 'user-dangling', 'user-folder']) assert.ok(entries.includes(name), `${name} was removed`)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
