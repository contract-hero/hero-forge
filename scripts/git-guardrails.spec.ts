// Tests for git-guardrails-claude-code's hook script, driven the way Claude
// Code runs it: a PreToolUse event as JSON on stdin, exit 2 to block.
//   node --test scripts/git-guardrails.spec.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'node:test'

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
  'engineering',
  'git-guardrails-claude-code',
  'scripts',
  'block-dangerous-git.sh',
)

function hook(stdin: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync('/bin/bash', [SCRIPT], { input: stdin, encoding: 'utf8', env })
  return { code: result.status, stderr: result.stderr }
}

const bash = (command: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } })

const BLOCKED = [
  'git push',
  'git push origin main',
  'git push --force',
  'git\tpush origin main',
  'git  push',
  'git -C /tmp push origin main',
  'git -c core.editor=vim push',
  'git --git-dir=/tmp/x/.git push',
  'git --no-pager push',
  'git reset --hard',
  'git reset --hard HEAD~1',
  'git -C /tmp reset --hard',
  'git clean -f',
  'git clean -fd',
  'git clean -df',
  'git clean -xdf',
  'git clean --force',
  'git clean -d -f',
  'git branch -D topic',
  'git branch --delete --force topic',
  'git -C /tmp branch -D topic',
  'git checkout .',
  'git restore .',
  'cd /tmp && git push',
]

const ALLOWED = [
  'git status',
  'git log --oneline',
  'git diff',
  'git commit -m "push the button"',
  'git branch -d merged-topic',
  'git clean -n',
  'git clean -dn',
  'git checkout main',
  'git restore src/a.ts',
  'git reset HEAD~1',
  'ls -la',
]

for (const command of BLOCKED) {
  test(`blocks ${JSON.stringify(command)}`, () => {
    const { code, stderr } = hook(bash(command))
    assert.equal(code, 2, stderr)
    assert.match(stderr, /^BLOCKED: /)
  })
}

for (const command of ALLOWED) {
  test(`allows ${JSON.stringify(command)}`, () => {
    const { code, stderr } = hook(bash(command))
    assert.equal(code, 0, stderr)
  })
}

test('blocks when the event is not valid JSON', () => {
  const { code, stderr } = hook('not json')
  assert.equal(code, 2)
  assert.match(stderr, /^BLOCKED: /)
})

test('blocks when jq is missing', () => {
  // A PATH that has every tool the script needs except jq.
  const bin = mkdtempSync(join(tmpdir(), 'git-guardrails-'))
  try {
    for (const tool of ['cat', 'grep', 'sed', 'tr', 'printf']) {
      const which = spawnSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
      if (which.startsWith('/')) symlinkSync(which, join(bin, tool))
    }
    const { code, stderr } = hook(bash('git status'), { ...process.env, PATH: bin })
    assert.equal(code, 2)
    assert.match(stderr, /^BLOCKED: .*jq/)
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})
