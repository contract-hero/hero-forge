import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { baseEnv, fakeCodex, runCli, tempDir, type FakeCodexSpec } from './test-helpers.ts'

const SCHEMA = join(dirname(dirname(fileURLToPath(import.meta.url))), 'findings.schema.json')
const CODEX_CONFIG = '# Review pipeline\n\n```yaml\nruntime: codex\norchestrator:\n  model: gpt-6-astra\n  effort: low\nreviewer:\n  model: gpt-6.1-sol\n  effort: xhigh\n```\n'
const FINDINGS = '{"axis":"standards","pair":1,"findings":[],"notes":""}'

type Setup = { spec?: FakeCodexSpec; config?: string }

// A temp dir (the cwd, outside any git repo) with a config, a brief and a fake codex.
async function setup(t: Parameters<typeof tempDir>[0], options: Setup = {}) {
  const dir = await realpath(await tempDir(t))
  const codex = await fakeCodex(dir, options.spec)
  const configPath = join(dir, 'review.md')
  await writeFile(configPath, options.config ?? CODEX_CONFIG)
  const brief = join(dir, 'reviewer-p1-standards.md')
  await writeFile(brief, 'You are the Standards reviewer of pair 1 of 2.\n')
  const exec = (...args: string[]) => runCli(['codex-exec', '--config', configPath, ...args], { cwd: dir, env: codex.env })
  return { dir, codex, brief, exec }
}

test('a reviewer runs codex exec read-only with the configured model, effort and findings schema', async (t) => {
  const { dir, codex, brief, exec } = await setup(t, { spec: { exec: { out: FINDINGS, stderr: 'session id: abc\n' } } })
  const out = join(dir, 'reviewer-p1-standards.json')

  const { code, stdout, stderr } = await exec('--role', 'reviewer', '--brief', brief, '--out', out)

  assert.equal(stderr, '')
  assert.equal(code, 0)
  const log = join(dir, 'reviewer-p1-standards.log')
  assert.deepEqual(JSON.parse(stdout), {
    role: 'reviewer',
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    sandbox: 'read-only',
    out,
    log,
  })
  assert.deepEqual(await codex.calls(), [
    { argv: ['--version'], stdin: '' },
    {
      argv: ['exec', '-C', dir, '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=xhigh', '-s', 'read-only',
        '--output-schema', SCHEMA, '-o', out, '-'],
      stdin: 'You are the Standards reviewer of pair 1 of 2.\n',
    },
  ])
  assert.equal(await readFile(out, 'utf8'), FINDINGS)
  assert.equal(await readFile(log, 'utf8'), 'session id: abc\n')
})

test('the orchestrator runs with full access, its own model and effort, and no output schema', async (t) => {
  const { dir, codex, brief, exec } = await setup(t, { spec: { exec: { out: 'Posted review 99.\n' } } })
  const out = join(dir, 'orchestrator-final.md')
  const log = join(dir, 'orchestrator.log')

  const { code, stdout, stderr } = await exec('--role', 'orchestrator', '--brief', brief, '--out', out, '--log', log)

  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { role: 'orchestrator', model: 'gpt-6-astra', effort: 'low', sandbox: 'danger-full-access', out, log })
  const [, call] = await codex.calls()
  assert.deepEqual(call?.argv, ['exec', '-C', dir, '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=low', '-s', 'danger-full-access', '-o', out, '-'])
  assert.equal(await readFile(out, 'utf8'), 'Posted review 99.\n')
})

const SETUP_HINT = /Codex CLI is missing or broken.*\/setup-review-pipeline/

test('a missing codex CLI stops with exit 4 and points at setup', async (t) => {
  const { dir, brief } = await setup(t)
  const empty = join(dir, 'empty-bin')
  await mkdir(empty)
  const { code, stdout, stderr } = await runCli(
    ['codex-exec', '--config', join(dir, 'review.md'), '--role', 'reviewer', '--brief', brief, '--out', join(dir, 'r.json')],
    { cwd: dir, env: { ...baseEnv(), PATH: empty } },
  )
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, SETUP_HINT)
})

test('a codex CLI whose --version fails stops with exit 4 before any exec', async (t) => {
  const { dir, codex, brief, exec } = await setup(t, { spec: { version: { exit: 1, stderr: 'dyld: Library not loaded\n' } } })
  const { code, stdout, stderr } = await exec('--role', 'reviewer', '--brief', brief, '--out', join(dir, 'r.json'))
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, SETUP_HINT)
  assert.match(stderr, /dyld: Library not loaded/)
  assert.deepEqual((await codex.calls()).map((c) => c.argv[0]), ['--version'])
})

test('a failed codex exec exits 1 and names the log', async (t) => {
  const { dir, brief, exec } = await setup(t, { spec: { exec: { exit: 1, out: null, stderr: 'ERROR: stream disconnected\n' } } })
  const out = join(dir, 'reviewer-p1-standards.json')
  const { code, stdout, stderr } = await exec('--role', 'reviewer', '--brief', brief, '--out', out)
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, `review.ts codex-exec: codex exec failed (exit 1). See ${join(dir, 'reviewer-p1-standards.log')}.\n`)
})

test('an effort the model rejects exits 1 and points at setup to fix the effort', async (t) => {
  const rejected =
    'ERROR: {"type":"error","error":{"message":"Unsupported value: \'minimal\' is not supported with the \'gpt-6.1-sol\' model.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_value"},"status":400}\n'
  const { dir, brief, exec } = await setup(t, { spec: { exec: { exit: 1, out: null, stderr: rejected } } })
  const { code, stderr } = await exec('--role', 'reviewer', '--brief', brief, '--out', join(dir, 'r.json'))
  assert.equal(code, 1)
  assert.match(stderr, /codex exec failed \(exit 1\)/)
  assert.match(stderr, /Codex rejected reviewer\.effort "xhigh" for model gpt-6\.1-sol\. Fix the effort in docs\/agents\/review\.md or re-run \/setup-review-pipeline\./)
})

test('a reviewer whose output is missing or not JSON exits 1', async (t) => {
  const missing = await setup(t, { spec: { exec: { out: null } } })
  const gone = await missing.exec('--role', 'reviewer', '--brief', missing.brief, '--out', join(missing.dir, 'r.json'))
  assert.equal(gone.code, 1)
  assert.match(gone.stderr, /codex exec wrote no output to .*r\.json/)

  const prose = await setup(t, { spec: { exec: { out: 'Here are my findings: none.' } } })
  const bad = await prose.exec('--role', 'reviewer', '--brief', prose.brief, '--out', join(prose.dir, 'r.json'))
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /output in .*r\.json is not JSON/)
})

test('a config whose runtime is claude refuses to call codex', async (t) => {
  const { dir, codex, brief, exec } = await setup(t, { config: '# Review pipeline\n\n```yaml\nruntime: claude\n```\n' })
  const { code, stdout, stderr } = await exec('--role', 'reviewer', '--brief', brief, '--out', join(dir, 'r.json'))
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, /runtime is claude, not codex/)
  assert.deepEqual(await codex.calls(), [])
})

test('a missing review config exits 3 and points at setup', async (t) => {
  const { dir, codex, brief } = await setup(t)
  const path = join(dir, 'nope.md')
  const { code, stderr } = await runCli(
    ['codex-exec', '--config', path, '--role', 'reviewer', '--brief', brief, '--out', join(dir, 'r.json')],
    { cwd: dir, env: codex.env },
  )
  assert.equal(code, 3)
  assert.match(stderr, /\/setup-review-pipeline/)
})

test('a brief that does not exist exits 1 without calling codex exec', async (t) => {
  const { dir, codex, exec } = await setup(t)
  const { code, stderr } = await exec('--role', 'reviewer', '--brief', join(dir, 'nope.md'), '--out', join(dir, 'r.json'))
  assert.equal(code, 1)
  assert.match(stderr, /cannot read the brief .*nope\.md/)
  assert.deepEqual((await codex.calls()).map((c) => c.argv[0]), ['--version'])
})

test('a bad role or a missing flag is a usage error', async (t) => {
  const { dir, brief, exec } = await setup(t)
  assert.equal((await exec('--role', 'rechecker', '--brief', brief, '--out', join(dir, 'r.json'))).code, 2)
  assert.equal((await exec('--role', 'reviewer', '--brief', brief)).code, 2)
  assert.equal((await exec('--role', 'reviewer', '--brief', brief, '--out', join(dir, 'r.json'), '--model', 'x')).code, 2)
})
