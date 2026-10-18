// Tests that review-pipeline owns its reviewer prompts and that code-review
// stands alone, read from the real files.
//   node --test scripts/review-prompts.spec.ts
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'node:test'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const PIPELINE = join(REPO, 'skills', 'engineering', 'review-pipeline')
const CODE_REVIEW = join(REPO, 'skills', 'engineering', 'code-review')

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : []
  })
}

// A path into the code-review folder, or a section of code-review's SKILL.md
// read by heading ("code-review's SKILL.md", "`code-review`'s section").
const READS_CODE_REVIEW = /code-review\/|code-review`?'s (SKILL\.md|section)/

test('no file under review-pipeline reads or names a path under code-review', () => {
  const hits = files(PIPELINE).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) => (READS_CODE_REVIEW.test(line) ? [`${relative(REPO, file)}:${index + 1}: ${line.trim()}`] : [])),
  )
  assert.deepEqual(hits, [])
})

test("review-pipeline holds its own copy of each reviewer prompt", () => {
  for (const file of ['standards-prompt.md', 'smell-baseline.md', 'spec-prompt.md', 'standards-bug-axis.md']) {
    assert.ok(existsSync(join(PIPELINE, file)), `review-pipeline has no ${file}`)
  }
})

test("every relative link in code-review's SKILL.md resolves inside the code-review folder", () => {
  const text = readFileSync(join(CODE_REVIEW, 'SKILL.md'), 'utf8')
  const broken = [...text.matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)]
    .map((match) => match[1]!)
    .filter((target) => !/^[a-z]+:/i.test(target))
    .filter((target) => {
      const path = resolve(CODE_REVIEW, target)
      return !existsSync(path) || relative(CODE_REVIEW, path).startsWith('..')
    })
  assert.deepEqual(broken, [])
})

test("the re-checker brief points the re-checker to the run's spec file", () => {
  const brief = readFileSync(join(PIPELINE, 'rechecker-brief.md'), 'utf8')
  assert.match(brief, /^- Spec: `<run dir>\/spec\.md` when the run has one/m)
})
