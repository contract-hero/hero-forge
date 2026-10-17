// `review.ts stack <order|path|restack|merge-layer> ...`: the deterministic
// steps of implement-spec-stack.
//
//   stack order        reads a spec's sub-issues and their blocked_by edges and
//                      prints the stack plan: one layer per open ticket, each
//                      with the parent layer it branches from.
//   stack path         prints the stack dir of a spec, beside the per-PR run dirs.
//   stack restack      after a parent layer lands, moves the checked-out child
//                      layer onto the default branch from the parent's
//                      pre-landing tip, and checks with git range-diff that no
//                      patch changed.
//   stack merge-layer  squash-merges one reviewed layer at its re-checked head,
//                      only after the stack-final review of the whole stack
//                      is complete.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { Failure, parse, positive, refuse, repoOption, runMain, usageFor } from './cli.ts'
import { configApp, squashMerge } from './finish.ts'
import { gh, json, listLines, oneLine } from './github.ts'
import { loadState, stateRoot } from './run-state.ts'

const usage = usageFor('stack')

type Issue = { number: number; title: string; state: string }
type Blocker = { number: number; state: string; repository_url: string }

// An edge the two-blocker rule changed: `ticket` now branches from `to`
// (it branched from `from`) so that `for` can have one base.
export type Rewire = { ticket: number; from: number | null; to: number; for: number }

export type Layer = {
  ticket: number
  title: string
  branch: string
  parent: number | null
  depth: number
  blockers: number[]
  children: number[]
}

// A branch-safe slug of the title, cut at a word boundary to 40 characters.
function slug(title: string): string {
  const words = title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== '')
  let out = ''
  for (const word of words) {
    const next = out === '' ? word : `${out}-${word}`
    if (next.length > 40) break
    out = next
  }
  return out || (words[0] ?? 'ticket').slice(0, 40)
}

// OWNER/REPO from an issue's repository_url (https://api.github.com/repos/O/R).
function repoOf(url: string): string {
  return url.split('/').slice(-2).join('/')
}

// No ticket left is ready, so the rest hold a cycle. Walk from the lowest
// ticket to its lowest blocker still pending until a ticket repeats.
function cycle(pending: Set<number>, blockers: Map<number, number[]>): Failure {
  const path: number[] = []
  let at = Math.min(...pending)
  while (!path.includes(at)) {
    path.push(at)
    at = Math.min(...(blockers.get(at) ?? []).filter((b) => pending.has(b)))
  }
  const loop = [...path.slice(path.indexOf(at)), at].map((n) => `#${n}`).join(' -> ')
  return new Failure(
    `the blocked_by graph has a cycle: ${loop} (each is blocked by the next). Break the cycle on the issue tracker, then run order again`,
    1,
  )
}

async function order(values: Record<string, string | boolean | undefined>): Promise<string> {
  const repo = repoOption(values.repo, usage)
  const spec = positive('spec', values.spec, usage)

  const children = await listLines<Issue>(
    ['api', '--paginate', '--jq', '.[] | {number, title, state}', `repos/${repo}/issues/${spec}/sub_issues`],
    `the sub-issues of #${spec}`,
  )
  const open = children.filter((c) => c.state === 'open').sort((a, b) => a.number - b.number)
  if (open.length === 0) throw new Failure(`spec #${spec} has no open sub-issues: nothing to stack`, 1)

  // Open blockers only: a closed blocker is already on the default branch.
  const inSpec = new Set(open.map((t) => t.number))
  const blockers = new Map<number, number[]>()
  const excluded: { ticket: number; reason: string }[] = []
  for (const ticket of open) {
    const listed = await listLines<Blocker>(
      ['api', '--paginate', '--jq', '.[] | {number, state, repository_url}', `repos/${repo}/issues/${ticket.number}/dependencies/blocked_by`],
      `the blockers of #${ticket.number}`,
    )
    const openBlockers = listed.filter((b) => b.state === 'open').sort((a, b) => a.number - b.number)
    const outside = openBlockers.find((b) => repoOf(b.repository_url) !== repo || !inSpec.has(b.number))
    if (outside !== undefined) {
      const ref = repoOf(outside.repository_url) === repo ? `#${outside.number}` : `${repoOf(outside.repository_url)}#${outside.number}`
      excluded.push({ ticket: ticket.number, reason: `blocked by ${ref}, an open issue outside spec #${spec}` })
    }
    blockers.set(ticket.number, openBlockers.map((b) => b.number))
  }
  // A ticket that waits on a ticket left out is not ready either.
  for (let changed = true; changed; ) {
    changed = false
    for (const ticket of open) {
      if (excluded.some((e) => e.ticket === ticket.number)) continue
      const waits = (blockers.get(ticket.number) ?? []).find((b) => excluded.some((e) => e.ticket === b))
      if (waits === undefined) continue
      excluded.push({ ticket: ticket.number, reason: `blocked by #${waits}, which is not in the stack` })
      changed = true
    }
  }
  excluded.sort((a, b) => a.ticket - b.ticket)
  for (const { ticket } of excluded) blockers.delete(ticket)
  const stacked = open.filter((t) => blockers.has(t.number))
  if (stacked.length === 0) {
    throw new Failure(`no ticket of spec #${spec} is ready to stack: ${excluded.map((e) => `#${e.ticket} is ${e.reason}`).join('; ')}`, 1)
  }

  // Kahn's algorithm, lowest ticket number first among the ready ones.
  const parent = new Map<number, number | null>()
  const chain = (n: number): number[] => {
    const up: number[] = []
    for (let at: number | null = n; at !== null; at = parent.get(at) ?? null) up.push(at)
    return up
  }
  const depth = (n: number) => chain(n).length
  const placed: number[] = []
  const rewired: Rewire[] = []
  const pending = new Set(stacked.map((t) => t.number))
  while (pending.size > 0) {
    const ready = [...pending].filter((n) => (blockers.get(n) ?? []).every((b) => !pending.has(b)))
    if (ready.length === 0) throw cycle(pending, blockers)
    const next = Math.min(...ready)
    const bs = blockers.get(next) ?? []
    // A PR has one base: the deepest blocker (on a tie, the higher number).
    const deepest = bs.reduce<number | null>((best, b) => (best === null || depth(b) >= depth(best) ? b : best), null)
    if (deepest !== null) {
      // Every other blocker must be below that base. One that is not sits on
      // an independent branch: stack the deepest blocker's branch (from just
      // below the point the two share, or from its root) onto it.
      const others = bs.filter((b) => b !== deepest).sort((a, b) => depth(b) - depth(a) || a - b)
      for (const other of others) {
        const below = chain(other)
        if (chain(deepest).includes(other)) continue
        const top = chain(deepest).find((n) => {
          const up = parent.get(n) ?? null
          return up === null || below.includes(up)
        })!
        rewired.push({ ticket: top, from: parent.get(top) ?? null, to: other, for: next })
        parent.set(top, other)
      }
    }
    parent.set(next, deepest)
    placed.push(next)
    pending.delete(next)
  }

  const byNumber = new Map(open.map((t) => [t.number, t]))
  const layers: Layer[] = placed
    .sort((a, b) => depth(a) - depth(b) || a - b)
    .map((n) => ({
      ticket: n,
      title: byNumber.get(n)!.title,
      branch: `ticket/${n}-${slug(byNumber.get(n)!.title)}`,
      parent: parent.get(n) ?? null,
      depth: depth(n),
      blockers: blockers.get(n) ?? [],
      children: placed.filter((c) => parent.get(c) === n),
    }))
  return `${JSON.stringify({ repo, spec, layers, rewired, excluded }, null, 2)}\n`
}

function git(args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

function mustGit(args: string[], what: string): string {
  const r = git(args)
  if (!r.ok) throw new Failure(`${what}: ${oneLine(r.err)}`, 1)
  return r.out
}

// One `git range-diff` pair line: `1:  abc1234 = 1:  def5678 subject`. The
// marker is `=` (same patch), `!` (changed), `<` (dropped) or `>` (added).
const PAIR = /^\s*(?:\d+|-+):\s+\S+\s+([=!<>])\s+(?:\d+|-+):\s+\S+/

// The checked-out layer branch moves onto `onto`, keeping only its own
// commits (those after `from`, the parent layer's pre-landing tip). It passes
// only when `git range-diff` pairs every commit with an unchanged patch.
// Otherwise the branch goes back to its old tip, and nothing was pushed.
async function restack(values: Record<string, string | boolean | undefined>): Promise<string> {
  const { from, onto } = values
  if (typeof from !== 'string' || from === '') throw usage('restack needs --from <the parent layer pre-landing tip>')
  if (typeof onto !== 'string' || onto === '') throw usage('restack needs --onto <ref>, for example origin/main')
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  refuse(branch.ok, 'restack needs the layer branch checked out (HEAD is detached)')
  refuse(
    mustGit(['status', '--porcelain'], 'cannot read the worktree status') === '',
    'the worktree has uncommitted changes: commit or remove them before restack',
  )
  const oldTip = mustGit(['rev-parse', 'HEAD'], 'cannot read HEAD')
  mustGit(['rev-parse', '--verify', '--quiet', `${from}^{commit}`], `--from ${from} is not a commit`)
  mustGit(['rev-parse', '--verify', '--quiet', `${onto}^{commit}`], `--onto ${onto} is not a commit`)
  // With no commit of its own the range-diff would be empty, and an empty
  // range-diff proves nothing.
  refuse(
    mustGit(['rev-list', '--count', `${from}..HEAD`], `cannot count the commits after --from ${from}`) !== '0',
    `${branch.out} has no commits of its own after --from ${from}: there is nothing to restack. Check --from`,
  )
  // The parent's tip can be past the point this layer branched from (a fix
  // from the stack review), so it need not be an ancestor: git takes
  // `<from>..HEAD` as this layer's own commits either way. But a `--from`
  // that shares no more history with the layer than `--onto` does would
  // replay the parent's commits too.
  refuse(
    mustGit(['merge-base', from, 'HEAD'], `--from ${from} shares no history with ${branch.out}`) !==
      mustGit(['merge-base', onto, 'HEAD'], `--onto ${onto} shares no history with ${branch.out}`),
    `--from ${from} cuts no deeper into ${branch.out} than --onto ${onto}: pass the parent layer's pre-landing tip`,
  )

  const rebased = git(['rebase', '--onto', onto, from])
  if (!rebased.ok) {
    git(['rebase', '--abort'])
    throw new Failure(`the rebase of ${branch.out} onto ${onto} conflicts: aborted, ${branch.out} is back at ${oldTip}`, 1)
  }
  // From here on the branch is rebased: every way out that does not pass puts
  // it back at its old tip first.
  const putBack = (why: string): Failure => {
    mustGit(['reset', '--quiet', '--hard', oldTip], `${why}, and cannot put ${branch.out} back at ${oldTip}`)
    return new Failure(`${why}. ${branch.out} is back at ${oldTip}`, 1)
  }
  const newTip = git(['rev-parse', 'HEAD'])
  if (!newTip.ok) throw putBack(`cannot read HEAD after the rebase: ${oneLine(newTip.err)}`)
  const ranged = git(['range-diff', '--no-color', `${from}..${oldTip}`, `${onto}..${newTip.out}`])
  if (!ranged.ok) throw putBack(`git range-diff failed: ${oneLine(ranged.err)}`)
  const diff = ranged.out
  const markers = diff
    .split('\n')
    .map((line) => PAIR.exec(line)?.[1])
    .filter((m) => m !== undefined)
  const differ = markers.filter((m) => m !== '=').length
  if (markers.length === 0 || differ > 0) {
    mustGit(['reset', '--quiet', '--hard', oldTip], `cannot put ${branch.out} back at ${oldTip}`)
    throw new Failure(
      `the range-diff of ${branch.out} shows a content change (${differ} of ${markers.length} commits differ): ${branch.out} is back at ${oldTip}, the rebased result was ${newTip.out}\n${diff}`,
      1,
    )
  }
  return `${JSON.stringify({ branch: branch.out, from, onto, old_tip: oldTip, new_tip: newTip.out, commits: markers.length, same: true })}\n`
}

// Land one layer: its review passed (`mode: layer`, phase complete), the
// review of the whole stack passed (the stack-final run of `--stack-pr` is
// complete), its PR now targets the default branch, and the gate of
// review.ts merge says go.
async function mergeLayer(values: Record<string, string | boolean | undefined>): Promise<string> {
  const repo = repoOption(values.repo, usage)
  const pr = positive('pr', values.pr, usage)
  const { base } = values
  if (typeof base !== 'string' || base === '') throw usage('merge-layer needs --base <the default branch>')
  const stackPr = positive('stack-pr', values['stack-pr'], usage)
  const app = await configApp(typeof values.config === 'string' ? values.config : undefined)
  const state = await loadState(pr)
  refuse(state.repo === repo, `the run state for PR #${pr} is for ${state.repo}, not ${repo}`)
  refuse(state.mode === 'layer', `the run for PR #${pr} is in ${state.mode} mode, not layer: use review.ts merge`)
  refuse(
    state.phase === 'complete',
    `merge-layer needs phase complete (the layer review passed), but PR #${pr} is at ${state.phase}`,
  )
  const stack = await loadState(stackPr)
  refuse(stack.repo === repo, `the run state for PR #${stackPr} is for ${stack.repo}, not ${repo}`)
  refuse(
    stack.mode === 'stack-final',
    `PR #${stackPr} is not the review of a whole stack: its run is in ${stack.mode} mode, not stack-final`,
  )
  refuse(
    stack.phase === 'complete',
    `merge-layer waits for the review of the whole stack: the stack-final run of PR #${stackPr} is at ${stack.phase}, not complete`,
  )
  const viewed = await gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'baseRefName'])
  refuse(viewed.code === 0, `cannot read PR #${pr}: ${oneLine(viewed.stderr)}`)
  const target = json<{ baseRefName: string }>(viewed.stdout, 'pr view').baseRefName
  refuse(
    target === base,
    `PR #${pr} targets ${target}, not ${base}: restack it onto ${base} and run gh pr edit ${pr} --base ${base} first`,
  )
  return squashMerge(repo, pr, state, app)
}

const OPTIONS = {
  repo: { type: 'string' },
  spec: { type: 'string' },
  from: { type: 'string' },
  onto: { type: 'string' },
  pr: { type: 'string' },
  base: { type: 'string' },
  'stack-pr': { type: 'string' },
  config: { type: 'string' },
} as const

async function dispatch(argv: string[]): Promise<string> {
  const [command, ...rest] = argv
  const { values } = parse(rest, OPTIONS, usage)
  switch (command) {
    case 'order':
      return order(values)
    case 'restack':
      return restack(values)
    case 'merge-layer':
      return mergeLayer(values)
    case 'path':
      return `${join(stateRoot(), `stack-${positive('spec', values.spec, usage)}`)}\n`
    default:
      throw usage(`unknown command "${command ?? ''}"`)
  }
}

export const main = runMain('stack', dispatch)
