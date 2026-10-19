// What every subcommand shares: the usage table, the list and help text it
// gives, the Failure that carries an
// exit code, the guard that throws it, the argument parser, and the `main`
// wrapper that turns `--help` into the subcommand's entry and a Failure into
// one stderr line and an exit code.
import { parseArgs, type ParseArgsConfig } from 'node:util'

// The run-state keys that `run-state set` may change. It lives here because
// the run-state usage line lists them. reviewer_login is fixed at create: the
// gates trust it only next to the login the App's own credentials give, but
// nobody should move it mid-run.
export const SETTABLE = ['round', 'head_sha', 'explainer']

// How long a lock that `route` takes (per PR or per issue) holds before it is
// free again, so a crashed run does not block its PR or issue forever. The
// usage line states it.
export const LOCK_TTL_HOURS = 3

// The usage table: the one place that holds each subcommand's one-line
// summary and usage text. The dispatcher, `--help` and every usage error read
// from it.
export const COMMANDS = {
  config: {
    summary: 'Read docs/agents/review.md, apply the defaults, and print the resolved config as JSON.',
    usage: 'usage: review.ts config [--config <path>]',
  },
  'run-state': {
    summary: 'Read or change the per-PR run state that lets an interrupted run resume.',
    usage: `usage:
  review.ts run-state path    --pr N
  review.ts run-state create  --pr N --repo O/R --base <ref> --head <ref> --head-sha <sha>
                              --runtime codex|claude --reviewer-login <slug[bot]|none>
                              [--mode single|layer|stack-final] [--force]
  review.ts run-state read    --pr N [<key>]
  review.ts run-state advance --pr N <phase> [--config <path>]
  review.ts run-state set     --pr N <key> <value>    (key: ${SETTABLE.join(' | ')})
  review.ts run-state next-round --pr N --max-rounds M [--config <path>]  (after a failed re-check: next round, or stopped)
  (with the reviewer App, a stop posts the contract-reviewer/gate failure status at the head)
  review.ts run-state supersede  --pr N    (the PR head moved after a review: archive the run, then create a new one)`,
  },
  'app-token': {
    summary: 'Check a GitHub App (the reviewer by default, or the implementer), or print its bot login.',
    usage: `usage: review.ts app-token --repo O/R [--app reviewer|implementer] [--config <path>] --check | --login`,
  },
  'post-review': {
    summary: 'Post one review payload to a PR, at most once per PR, round, kind and commit.',
    usage: `usage: review.ts post-review --repo O/R --pr N --commit <sha> --round R
                             --kind review|recheck|verdict --payload <file> [--config <path>]
                             [--ledger <findings.json> --recheck <recheck-rN.json>]   (recheck, verdict)
  (with the reviewer App, a passing gate posts the contract-reviewer/gate success status at the head, once per head)`,
  },
  reply: {
    summary: 'Post the Adjudication: one reply per inline finding and one PR comment with every answer.',
    usage: `usage: review.ts reply --repo O/R --pr N --round R --ledger <findings.json>
                       [--recheck <recheck-r(R-1).json>]   (round 2 and later)
                       [--as implementer]   (AFK: the Implementer App only, never the user)
                       [--config <path>]`,
  },
  implementer: {
    summary: 'Push a branch, open a draft PR, comment, or label, as the Implementer App (it mints its own token).',
    usage: `usage:
  review.ts implementer push    --repo O/R --branch <local> [--to <branch on GitHub>] [--force-with-lease <old tip sha>] [--config <path>]   (in the repo's worktree)
  review.ts implementer pr      --repo O/R --head <branch> --base <ref> --title <text> --body-file <file> [--config <path>]
  review.ts implementer comment --repo O/R --issue N --body-file <file> [--config <path>]   (an issue or a PR)
  review.ts implementer label   --repo O/R --issue N --add <label> | --remove <label> [--config <path>]   (an issue or a PR)`,
  },
  handoff: {
    summary: 'Post the hand-off marker comment, as the App named, as the last action of an AFK part.',
    usage: `usage: review.ts handoff --app reviewer|implementer --repo O/R --pr N --kind review-posted|recheck-failed|adjudicated --round R [--config <path>]
  reviewer: review-posted, recheck-failed (at phase review-posted). implementer: adjudicated (at phase adjudicated).
  Posts at most one comment per App, kind, PR and round; a re-run prints already: true.`,
  },
  lock: {
    summary: 'Release the lock that route took for an AFK run, with its owner token.',
    usage: `usage: review.ts lock release --pr N | --issue N --token <lock_token>
  Exits 0 also when the token no longer owns the lock (released: false).`,
  },
  pause: {
    summary: 'Write, read or delete the pause record of an AFK run stopped at a one-way door.',
    usage: `usage:
  review.ts pause write  --repo O/R --issue N | --pr N --reason <the question>
                         [--branch <branch on GitHub> --tip <its pushed sha>]
  review.ts pause read   --issue N | --pr N    (exit 3: no pause record)
  review.ts pause delete --issue N | --pr N`,
  },
  'codex-exec': {
    summary: 'Run one Codex role read-only on a brief, and check its output against a schema.',
    usage:
      'usage: review.ts codex-exec --role orchestrator|reviewer --brief <file> --out <file> [--schema <file>] [--log <file>] [--config <path>]',
  },
  'codex-review': {
    summary: 'Run one review round on runtime codex: the reviewers, the Orchestrator, then post-review.',
    usage: 'usage: review.ts codex-review --pr N [--issue <n>]... [--spec <parent spec issue, layer runs>] [--config <path>]',
  },
  'merge-gate': {
    summary: 'Read the PR once and print whether it is safe to squash-merge now.',
    usage: 'usage: review.ts merge-gate --repo O/R --pr N [--config <path>]',
  },
  merge: {
    summary: 'Run the merge gate again and, on go, squash-merge the re-checked head.',
    usage: 'usage: review.ts merge --repo O/R --pr N [--config <path>]',
  },
  explainer: {
    summary: 'Record the explainer path in the run state and link it from the PR in one comment.',
    usage: 'usage: review.ts explainer --repo O/R --pr N --file <absolute path to explainer.html>',
  },
  stack: {
    summary: 'Plan a PR stack from a spec, restack a layer, or land one reviewed layer.',
    usage: `usage:
  review.ts stack order       --repo O/R --spec N
  review.ts stack path        --spec N
  review.ts stack restack     --from <parent pre-landing tip> --onto <ref> [--pr <layer PR>]   (in the layer's worktree)
  review.ts stack merge-layer --repo O/R --pr N --base <default branch> --stack-pr S [--config <path>]`,
  },
  route: {
    summary: 'Decide whether one GitHub webhook delivery starts work for an App: print the action or ignore, with the reason.',
    usage: `usage: review.ts route --app reviewer|implementer --event <X-GitHub-Event> --delivery <X-GitHub-Delivery> --payload <file>
  Prints {action, repo, pr, issue, reason, lock_token} and exits 0 for every decision, ignore included.
  reviewer actions: review, recheck. implementer actions: build-ticket, build-spec, adjudicate, resume.
  Work takes a lock, per PR (or per issue for a build or a resume on an issue), free again after ${LOCK_TTL_HOURS} hours.
  lock_token is that lock's owner token, for the launched run to release it; null on ignore.`,
  },
  reconcile: {
    summary: 'Sweep the open work a missed webhook should have started, and decide each item as route does.',
    usage: `usage: review.ts reconcile --repo O/R   (in a checkout of the repo, as route)
  Lists open issues labelled ready-for-agent (unless paused), open PRs with no run state at their head, the
  newest hand-off and maintainer /recheck on each open PR, and needs-info issues and PRs with a maintainer
  comment after their pause record.
  Prints one line per item: route's decision plus app (reviewer or implementer), and exits 0. Work takes its lock
  as route does: start a run for each line whose action is not ignore. A ticket or spec that an open PR by the
  maintainer or contract-implementer[bot] closes (itself, or one of its sub-issues) is ignore, has-pr. An item
  that fails prints its error on stderr, the other lines still stand, and the exit code is the first failure's.`,
  },
} as const satisfies Record<string, { summary: string; usage: string }>

export type CommandName = keyof typeof COMMANDS

// What `review.ts <name> --help` prints: the summary, then the usage text.
export function helpText(name: CommandName): string {
  const { summary, usage } = COMMANDS[name]
  return `review.ts ${name}: ${summary}\n\n${usage}\n`
}

// What `review.ts help` prints: every subcommand in the table with its
// summary, and how to get one subcommand's usage.
export function listText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length))
  const lines = Object.entries(COMMANDS).map(([name, { summary }]) => `  ${name.padEnd(width)}  ${summary}`)
  return `usage: review.ts <subcommand> [options]

subcommands:
${lines.join('\n')}

Run review.ts <subcommand> --help for one subcommand's usage.
`
}

// A failure with its exit code (1 refused, 2 usage, 3 absent, 4 broken).
export class Failure extends Error {
  code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

// Exit 1 with `message` unless `ok`.
export function refuse(ok: boolean, message: string): void {
  if (!ok) throw new Failure(message, 1)
}

// A usage error (exit 2): the message, then the subcommand's usage text.
export type Usage = (message: string) => Failure

export function usageFor(name: CommandName): Usage {
  return (message) => new Failure(`${message}\n${COMMANDS[name].usage}`, 2)
}

const REPO = /^[\w.-]+\/[\w.-]+$/
const WHOLE = /^[0-9]+$/

export const isRepo = (v: unknown): v is string => typeof v === 'string' && REPO.test(v)

// `--<name>` as a positive whole number, or a usage error.
export function positive(name: string, value: unknown, usage: Usage): number {
  if (typeof value !== 'string' || !WHOLE.test(value) || Number(value) < 1) {
    throw usage(`--${name} must be a positive whole number`)
  }
  return Number(value)
}

export function repoOption(value: unknown, usage: Usage): string {
  if (!isRepo(value)) throw usage('--repo must be OWNER/REPO')
  return value
}

// parseArgs in strict mode; any parse error is a usage error.
export function parse<T extends NonNullable<ParseArgsConfig['options']>>(
  argv: string[],
  options: T,
  usage: Usage,
  allowPositionals = false,
) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals })
  } catch (error) {
    throw usage((error as Error).message)
  }
}

// The subcommand entry point. `--help` anywhere before a `--` prints the
// subcommand's entry and exits 0, whatever the other arguments are. Else `fn`
// returns the stdout text, or an exit code when it wrote its own output. A
// Failure becomes one stderr line, prefixed `review.ts <name>: `, and its exit
// code.
export function runMain(name: CommandName, fn: (argv: string[]) => Promise<string | number>): (argv: string[]) => Promise<number> {
  return async (argv) => {
    const end = argv.indexOf('--')
    if ((end === -1 ? argv : argv.slice(0, end)).includes('--help')) {
      process.stdout.write(helpText(name))
      return 0
    }
    try {
      const result = await fn(argv)
      if (typeof result === 'number') return result
      process.stdout.write(result)
      return 0
    } catch (error) {
      if (!(error instanceof Failure)) throw error
      process.stderr.write(`review.ts ${name}: ${error.message}\n`)
      return error.code
    }
  }
}
