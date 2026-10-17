// The dispatcher and the help every subcommand prints.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runCli } from './test-helpers.ts'

// Every subcommand, with one whole line its usage text must hold.
const SUBCOMMANDS: [string, string][] = [
  ['config', 'usage: review.ts config [--config <path>]'],
  ['run-state', '  review.ts run-state path    --pr N'],
  ['app-token', 'usage: review.ts app-token --repo O/R [--config <path>] --check | --login'],
  ['post-review', 'usage: review.ts post-review --repo O/R --pr N --commit <sha> --round R'],
  ['reply', 'usage: review.ts reply --repo O/R --pr N --round R --ledger <findings.json>'],
  [
    'codex-exec',
    'usage: review.ts codex-exec --role orchestrator|reviewer --brief <file> --out <file> [--schema <file>] [--log <file>] [--config <path>]',
  ],
  ['codex-review', 'usage: review.ts codex-review --pr N [--issue <n>]... [--config <path>]'],
  ['merge-gate', 'usage: review.ts merge-gate --repo O/R --pr N [--config <path>]'],
  ['merge', 'usage: review.ts merge --repo O/R --pr N [--config <path>]'],
  ['explainer', 'usage: review.ts explainer --repo O/R --pr N --file <absolute path to explainer.html>'],
  ['stack', '  review.ts stack order       --repo O/R --spec N'],
]

const COMMANDS_FIRST: Record<string, string[]> = { stack: ['order'], 'run-state': ['path'] }

for (const [name, line] of SUBCOMMANDS) {
  test(`${name} --help prints a summary and the usage to stdout, and exits 0`, async () => {
    const { code, stdout, stderr } = await runCli([name, '--help'])
    assert.equal(stderr, '')
    assert.equal(code, 0)
    const [first = '', blank, ...usage] = stdout.split('\n')
    assert.match(first, new RegExp(`^review\\.ts ${name}: \\S`))
    assert.equal(blank, '')
    assert.ok(usage.includes(line), `no "${line}" in:\n${stdout}`)
  })

  test(`${name} --help wins over other arguments, an unknown option among them`, async () => {
    const alone = await runCli([name, '--help'])
    const mixed = await runCli([name, '--no-such-option', '--help'])
    assert.deepEqual(mixed, alone)
  })

  test(`${name} with an unknown option exits 2 with the same usage text that --help prints`, async () => {
    const help = await runCli([name, '--help'])
    // stack and run-state take a command first; give them one, so the
    // unknown option reaches the option parser.
    const command = COMMANDS_FIRST[name] ?? []
    const { code, stdout, stderr } = await runCli([name, ...command, '--no-such-option'])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    const [message = '', ...usage] = stderr.split('\n')
    assert.match(message, new RegExp(`^review\\.ts ${name}: Unknown option '--no-such-option'`))
    const helpUsage = help.stdout.split('\n').slice(2)
    assert.deepEqual(usage, helpUsage)
  })
}

test('the list above holds every subcommand the dispatcher knows', async () => {
  const { code, stderr } = await runCli(['nope'])
  assert.equal(code, 2)
  const listed = /^subcommands: (.*)$/m.exec(stderr)?.[1]?.split(', ')
  assert.deepEqual(listed?.sort(), SUBCOMMANDS.map(([name]) => name).sort())
})

test('--help after a -- terminator is not a help request', async () => {
  const { code, stdout } = await runCli(['config', '--', '--help'])
  assert.equal(code, 2)
  assert.equal(stdout, '')
})
