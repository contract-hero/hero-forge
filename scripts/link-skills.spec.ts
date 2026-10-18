// Tests that scripts/link-skills.sh links every skill into ~/.claude/skills
// and writes nothing else under $HOME. Runs the real script with a temp HOME.
//   node --test scripts/link-skills.spec.ts
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs'
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

function runWithHome() {
  const home = mkdtempSync(join(tmpdir(), 'link-skills-'))
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
