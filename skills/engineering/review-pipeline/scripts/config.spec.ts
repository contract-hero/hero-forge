import assert from 'node:assert/strict'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { run, runCli, tempDir } from './test-helpers.ts'

// A review.md with some prose, then the given lines as its one YAML block.
const PROSE = '# Review pipeline\n\nSome prose.\n\n'
function doc(...yaml: string[]): string {
  return `${PROSE}\`\`\`yaml\n${yaml.join('\n')}\n\`\`\`\n`
}

async function config(t: Parameters<typeof tempDir>[0], text: string) {
  const dir = await tempDir(t)
  const path = join(dir, 'review.md')
  await writeFile(path, text)
  const result = await runCli(['config', '--config', path])
  return { ...result, path }
}

test('a missing config file exits 3 and points at setup', async (t) => {
  const dir = await tempDir(t)
  const path = join(dir, 'review.md')
  const { code, stdout, stderr } = await runCli(['config', '--config', path])
  assert.equal(code, 3)
  assert.equal(stdout, '')
  assert.equal(stderr, `review.ts config: no review config at ${path}. Tell the user to run /setup-forge.\n`)
})

test('a minimal codex file resolves to the codex defaults', async (t) => {
  const { code, stdout, stderr, path } = await config(t, doc('runtime: codex'))
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), {
    config_path: path,
    runtime: 'codex',
    pairs: 2,
    orchestrator: { model: 'gpt-6-astra', effort: 'low', agent_model: null },
    reviewer: { model: 'gpt-6.1-sol', effort: 'high', agent_model: null },
    max_rounds: 2,
    app: false,
  })
})

test('a minimal claude file resolves to the claude defaults with sub-agent models', async (t) => {
  const { code, stdout, stderr, path } = await config(t, doc('runtime: claude'))
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), {
    config_path: path,
    runtime: 'claude',
    pairs: 2,
    orchestrator: { model: 'claude-opus-5-5', effort: 'medium', agent_model: 'opus' },
    reviewer: { model: 'claude-sonnet-5-5', effort: 'high', agent_model: 'sonnet' },
    max_rounds: 2,
    app: false,
  })
})

test('a role that overrides only its effort keeps the default model', async (t) => {
  const codex = await config(t, doc('runtime: codex', 'reviewer:', '  effort: xhigh'))
  assert.equal(codex.code, 0)
  assert.deepEqual(JSON.parse(codex.stdout).reviewer, { model: 'gpt-6.1-sol', effort: 'xhigh', agent_model: null })
  assert.deepEqual(JSON.parse(codex.stdout).orchestrator, { model: 'gpt-6-astra', effort: 'low', agent_model: null })

  const claude = await config(t, doc('runtime: claude', 'orchestrator:', '  effort: max'))
  assert.equal(claude.code, 0)
  assert.deepEqual(JSON.parse(claude.stdout).orchestrator, { model: 'claude-opus-5-5', effort: 'max', agent_model: 'opus' })
})

test('the canonical block setup writes resolves field for field', async (t) => {
  const { code, stdout, stderr } = await config(
    t,
    doc(
      'runtime: claude',
      'pairs: 3',
      'orchestrator:',
      '  model: claude-fable-1',
      '  effort: high',
      'reviewer:',
      '  model: haiku',
      '  effort: low',
      'max_rounds: 4',
      'app: enabled',
    ),
  )
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const resolved = JSON.parse(stdout)
  assert.equal(resolved.pairs, 3)
  assert.deepEqual(resolved.orchestrator, { model: 'claude-fable-1', effort: 'high', agent_model: 'fable' })
  assert.deepEqual(resolved.reviewer, { model: 'haiku', effort: 'low', agent_model: 'haiku' })
  assert.equal(resolved.max_rounds, 4)
  assert.equal(resolved.app, true)
})

test('comments, blank lines, quotes and trailing comments are accepted', async (t) => {
  const { code, stdout, stderr } = await config(
    t,
    doc(
      '# how this repo reviews',
      'runtime: "codex"   # the runtime',
      '',
      'orchestrator:  # the one that consolidates',
      "  model: 'gpt-6-astra'",
      '  # effort stays default',
      'pairs: 1',
    ),
  )
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const resolved = JSON.parse(stdout)
  assert.equal(resolved.runtime, 'codex')
  assert.equal(resolved.pairs, 1)
  assert.deepEqual(resolved.orchestrator, { model: 'gpt-6-astra', effort: 'low', agent_model: null })
})

test('a yml fence and an empty role map are accepted', async (t) => {
  const { code, stdout } = await config(t, `${PROSE}\`\`\`yml\nruntime: codex\nreviewer:\n\`\`\`\n`)
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout).reviewer.model, 'gpt-6.1-sol')
})

// Each case: the test name, the file contents, and the reason after
// `<path>[:<line>]: ` in the error. Line numbers count from the top of the
// file; the YAML block's first line is line 6 (PROSE is 4 lines, the fence 5).
const invalid: [string, string, number | null, string][] = [
  ['no yaml block', `${PROSE}runtime: codex\n`, null, 'no ```yaml block found'],
  ['two yaml blocks', doc('runtime: codex') + doc('runtime: codex'), 12, 'more than one ```yaml block (keep exactly one)'],
  ['an unclosed fence', `${PROSE}\`\`\`yaml\nruntime: codex\n`, 5, 'the ```yaml block is never closed'],
  ['a missing runtime', doc('pairs: 2'), null, 'runtime is missing (codex or claude)'],
  ['an unknown runtime', doc('runtime: gemini'), 6, 'unknown runtime "gemini" (codex or claude)'],
  ['an unknown top key', doc('runtime: codex', 'colour: blue'), 7, 'unknown key colour'],
  ['an unknown nested key', doc('runtime: codex', 'reviewer:', '  temperature: 1'), 8, 'unknown key reviewer.temperature (model or effort)'],
  ['a duplicate top key', doc('runtime: codex', 'runtime: claude'), 7, 'duplicate key runtime'],
  ['a duplicate nested key', doc('runtime: codex', 'reviewer:', '  effort: low', '  effort: high'), 9, 'duplicate key reviewer.effort'],
  ['a duplicate map', doc('runtime: codex', 'reviewer:', 'reviewer:'), 8, 'duplicate key reviewer'],
  ['tab indentation', doc('runtime: codex', 'reviewer:', '\teffort: low'), 8, 'tab indentation (indent with 2 spaces)'],
  [
    'a four-space indent',
    doc('runtime: codex', 'reviewer:', '    effort: low'),
    8,
    'line is outside the supported YAML subset (KEY: value, or a 2-space indented model/effort)',
  ],
  ['a list', doc('runtime: codex', '- one'), 7, 'line is outside the supported YAML subset (KEY: value, or a 2-space indented model/effort)'],
  ['an indented line outside a map', doc('runtime: codex', '  model: gpt-6-astra'), 7, 'indented line outside orchestrator or reviewer'],
  ['a role given a scalar', doc('runtime: codex', 'reviewer: gpt-6.1-sol'), 7, 'reviewer must be a map (put model and effort on indented lines)'],
  ['a top key with no value', doc('runtime: codex', 'pairs:'), 7, 'pairs needs a value'],
  [
    'mixed runtime: codex with a Claude reviewer',
    doc('runtime: codex', 'reviewer:', '  model: claude-sonnet-5-5'),
    8,
    'mixed runtime: runtime is codex but reviewer.model "claude-sonnet-5-5" is a Claude model',
  ],
  [
    'mixed runtime: codex with a bare Claude alias',
    doc('runtime: codex', 'orchestrator:', '  model: opus'),
    8,
    'mixed runtime: runtime is codex but orchestrator.model "opus" is a Claude model',
  ],
  [
    'mixed runtime: claude with a Codex orchestrator',
    doc('runtime: claude', 'orchestrator:', '  model: gpt-6-astra'),
    8,
    'mixed runtime: runtime is claude but orchestrator.model "gpt-6-astra" is not a Claude model',
  ],
  [
    'a Claude model with no sub-agent family',
    doc('runtime: claude', 'reviewer:', '  model: claude-instant-1'),
    8,
    'cannot map reviewer.model "claude-instant-1" to a sub-agent model (opus|sonnet|haiku|fable)',
  ],
  [
    'an effort Codex does not take',
    doc('runtime: codex', 'reviewer:', '  effort: extreme'),
    8,
    'reviewer.effort "extreme" is not a codex effort (none, minimal, low, medium, high, xhigh, max)',
  ],
  [
    'a Codex-only effort under claude',
    doc('runtime: claude', 'reviewer:', '  effort: minimal'),
    8,
    'reviewer.effort "minimal" is not a claude effort (low, medium, high, xhigh, max)',
  ],
  ['pairs 0', doc('runtime: codex', 'pairs: 0'), 7, 'pairs must be 1 or more, got 0'],
  ['max_rounds 0', doc('runtime: codex', 'max_rounds: 0'), 7, 'max_rounds must be 1 or more, got 0'],
  ['a non-integer pairs', doc('runtime: codex', 'pairs: 1.5'), 7, 'pairs must be a whole number, got "1.5"'],
  ['a quoted max_rounds', doc('runtime: codex', 'max_rounds: "2"'), 7, 'max_rounds must be a whole number, got "2"'],
  ['a negative max_rounds', doc('runtime: codex', 'max_rounds: -1'), 7, 'max_rounds must be a whole number, got "-1"'],
  ['an app value other than enabled', doc('runtime: codex', 'app: true'), 7, 'app must be "enabled" or left out, got "true"'],
]

for (const [name, text, line, reason] of invalid) {
  test(`${name} exits 4 with a clear message`, async (t) => {
    const { code, stdout, stderr, path } = await config(t, text)
    const where = line === null ? path : `${path}:${line}`
    assert.equal(stdout, '')
    assert.equal(stderr, `review.ts config: ${where}: ${reason}. Edit the file or re-run /setup-forge.\n`)
    assert.equal(code, 4)
  })
}

test('without --config it reads docs/agents/review.md at the git root', async (t) => {
  const dir = await tempDir(t)
  const init = await run('git', ['init', '-q', dir])
  assert.equal(init.code, 0)
  await mkdir(join(dir, 'docs/agents'), { recursive: true })
  await mkdir(join(dir, 'sub'))
  await writeFile(join(dir, 'docs/agents/review.md'), doc('runtime: codex'))
  const { code, stdout } = await runCli(['config'], { cwd: join(dir, 'sub') })
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout).config_path, join(await realpath(dir), 'docs/agents/review.md'))
})

test('an unknown option is a usage error', async () => {
  const { code, stdout, stderr } = await runCli(['config', '--colour'])
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts config: /)
  assert.match(stderr, /usage: review\.ts config \[--config <path>\]/)
})
