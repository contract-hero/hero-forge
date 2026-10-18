// Tests that the shipped skills use the hero-forge names only, read from the
// real files: the skill files, and every repo file outside the history.
//   node --test scripts/names.spec.ts
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'node:test'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : []
  })
}

// The old plugin name, built from parts so that this file does not name it.
const OLD_NAME = new RegExp(['hero', 'pocock'].join('-'), 'i')

test('no file under skills/ names the old plugin', () => {
  const hits = files(join(REPO, 'skills')).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) => (OLD_NAME.test(line) ? [`${relative(REPO, file)}:${index + 1}: ${line.trim()}`] : [])),
  )
  assert.deepEqual(hits, [])
})

// The skill names that `ask-forge` and `setup-forge` replaced, built from
// parts so that this file does not name them.
const OLD_SKILLS = new RegExp(
  [
    ['ask', 'matt'],
    ['setup', 'matt', 'pocock', 'skills'],
    ['setup', 'review', 'pipeline'],
  ]
    .map((parts) => parts.join('-'))
    .join('|'),
)

// History keeps the old names: the ADRs, the changelog and the changesets.
const HISTORY = [/^\.agents\/adr\//, /^CHANGELOG\.md$/, /^\.changeset\//]

// Every file git tracks or would track, as a path from the repo root.
function repoFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((path) => path !== '' && existsSync(join(REPO, path)) && statSync(join(REPO, path)).isFile())
}

test('no file outside the history names a skill that ask-forge or setup-forge replaced', () => {
  const hits = repoFiles()
    .filter((path) => !HISTORY.some((pattern) => pattern.test(path)))
    .flatMap((path) =>
      readFileSync(join(REPO, path), 'utf8')
        .split('\n')
        .flatMap((line, index) => (OLD_SKILLS.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [])),
    )
  assert.deepEqual(hits, [])
})
