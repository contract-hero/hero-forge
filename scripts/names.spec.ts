// Tests that the shipped skills use the hero-forge names only, read from the
// real skill files.
//   node --test scripts/names.spec.ts
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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
