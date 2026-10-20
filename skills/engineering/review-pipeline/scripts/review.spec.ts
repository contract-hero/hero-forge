// The dispatcher and the help every subcommand prints.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runCli } from './test-helpers.ts'

// Every subcommand, with one whole line its usage text must hold.
const SUBCOMMANDS: [string, string][] = [
  ['config', 'usage: review.ts config [--config <path>]'],
  ['run-state', '  review.ts run-state path    --pr N'],
  ['app-token', 'usage: review.ts app-token --repo O/R [--app reviewer|implementer] [--config <path>] --check | --login'],
  ['post-review', 'usage: review.ts post-review --repo O/R --pr N --commit <sha> --round R'],
  ['reply', 'usage: review.ts reply --repo O/R --pr N --round R --ledger <findings.json>'],
  ['implementer', '  review.ts implementer push    --repo O/R --branch <local> [--to <branch on GitHub>] [--force-with-lease <old tip sha>] [--config <path>]   (in the repo\'s worktree)'],
  ['handoff', 'usage: review.ts handoff --app reviewer|implementer --repo O/R --pr N --kind review-posted|recheck-failed|adjudicated --round R [--config <path>]'],
  ['lock', 'usage: review.ts lock release --pr N | --issue N --token <lock_token>'],
  ['pause', '  review.ts pause write  --repo O/R --issue N | --pr N --reason <the question>'],
  [
    'codex-exec',
    'usage: review.ts codex-exec --role orchestrator|reviewer --brief <file> --out <file> [--schema <file>] [--log <file>] [--config <path>]',
  ],
  ['codex-review', 'usage: review.ts codex-review --pr N [--issue <n>]... [--spec <parent spec issue, layer runs>] [--config <path>]'],
  ['merge-gate', 'usage: review.ts merge-gate --repo O/R --pr N [--config <path>]'],
  ['merge', 'usage: review.ts merge --repo O/R --pr N [--config <path>]'],
  ['explainer', 'usage: review.ts explainer --repo O/R --pr N --file <absolute path to explainer.html>'],
  ['resolve-base', '  review.ts resolve-base prepare --repo O/R --pr N    (in the worktree at the run\'s head: merge, resolve, move the branch)'],
  ['stack', '  review.ts stack order       --repo O/R --spec N'],
  ['route', 'usage: review.ts route --app reviewer|implementer --event <X-GitHub-Event> --delivery <X-GitHub-Delivery> --payload <file>'],
  ['reconcile', 'usage: review.ts reconcile --repo O/R   (in a checkout of the repo, as route)'],
  ['delivery', 'usage: review.ts delivery --app reviewer|implementer --delivery <X-GitHub-Delivery> --out <file>'],
  ['app-check', 'usage: review.ts app-check --app reviewer|implementer --repo O/R [--webhook-url <url>]'],
]

const COMMANDS_FIRST: Record<string, string[]> = { stack: ['order'], 'run-state': ['path'], implementer: ['push'], lock: ['release'], pause: ['write'], 'resolve-base': ['prepare'] }

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
    // stack, run-state, implementer, lock and pause take a command first; give them one, so the
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

// The names in a `review.ts help` list, in order: the first word of each
// indented line that has a summary after it.
function listedNames(list: string): string[] {
  return [...list.matchAll(/^ {2}(\S+) {2,}\S/gm)].map((match) => match[1] ?? '')
}

test('help lists every subcommand with its summary on stdout, and exits 0', async () => {
  const { code, stdout, stderr } = await runCli(['help'])
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.match(stdout, /^usage: review\.ts <subcommand> \[options\]\n/)
  assert.deepEqual(listedNames(stdout).sort(), SUBCOMMANDS.map(([name]) => name).sort())
  assert.match(stdout, /^ {2}merge-gate {2,}Read the PR once and print whether it is safe to squash-merge now\.$/m)
  assert.match(stdout, /review\.ts <subcommand> --help/)
})

test('an unknown subcommand exits 2 with one message line, then the list that help prints, on stderr', async () => {
  const help = await runCli(['help'])
  const { code, stdout, stderr } = await runCli(['nope'])
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.equal(stderr, `review.ts: unknown subcommand 'nope'\n${help.stdout}`)
})

test('review.ts with no arguments does what help does', async () => {
  const help = await runCli(['help'])
  assert.deepEqual(await runCli([]), help)
})

test('--help after a -- terminator is not a help request', async () => {
  const { code, stdout } = await runCli(['config', '--', '--help'])
  assert.equal(code, 2)
  assert.equal(stdout, '')
})
