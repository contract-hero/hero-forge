// Tests for typecheck.sh, driven through its command line. Each run installs
// TypeScript from the npm registry, so this file needs the network.
//   node --test scripts/typecheck.spec.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'node:test'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'typecheck.sh')

function typecheck(args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env })
  return { code: result.status, output: result.stdout + result.stderr }
}

test('the helper scripts type-check clean, exit 0, and write nothing inside the repo', () => {
  const repo = join(dirname(SCRIPT), '..')
  const status = () =>
    spawnSync('git', ['status', '--porcelain', '--ignored', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' })
      .stdout
  const before = status()

  const { code, output } = typecheck()
  assert.equal(code, 0, output)
  assert.equal(status(), before)
})

test('a type error exits non-zero and prints the tsc error', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'typecheck-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, types: ['node'] }, include: ['*.ts'] }),
  )
  writeFileSync(join(dir, 'bad.ts'), "export const count: number = 'one'\n")

  const { code, output } = typecheck([dir])
  assert.notEqual(code, 0, output)
  assert.match(output, /bad\.ts\(1,14\): error TS2322/)
})

test('an install failure exits non-zero and prints the npm error', () => {
  // Nothing listens on port 9, so npm cannot reach the registry. No retries:
  // npm's default backoff makes this test take minutes.
  const { code, output } = typecheck([], {
    ...process.env,
    npm_config_registry: 'http://127.0.0.1:9',
    npm_config_fetch_retries: '0',
  })
  assert.notEqual(code, 0, output)
  assert.match(output, /npm error/)
})
