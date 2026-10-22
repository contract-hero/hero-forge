// `review.ts reconcile --repo O/R` (usage in the table in cli.ts): the
// hourly sweep that starts the work a missed webhook delivery should have
// started (the Mac was off, or T3 dropped it). It lists the open work, builds
// for each item the event and payload that `route` would have received, and
// decides it with route's own `decide`, so caps, paused, locks, sender and
// author rules give the same answers. It holds three rules of its own: a
// ticket or spec that a trusted open PR closes is ignore, has-pr, and then
// one that an open issue of this repo blocks is ignore, blocked, both before
// route's App rules (route's build rule asks the same late); and a hand-off that no event
// can carry, because it was never posted (the last kind). The
// lists pick which comment stands for an item; route still judges it.
//
// The items, each with its App and its delivery id. A delivery id is the
// same on every sweep, so a done record makes the next sweep a duplicate:
//   - an open issue labelled ready-for-agent: issues.labeled, sent by the
//     actor of the issue's latest labeled event for that label (implementer)
//                                         reconcile-label-<N>-<event id>
//     An issue with a pause record of this repo is no item here: its build
//     goes on only through the answer (the last kind). A ticket that an open
//     PR closes, or a spec one of whose sub-issues an open PR closes, is
//     ignore, has-pr, after route's paused and duplicate rules and before
//     its App rules. Only a PR by the maintainer or contract-implementer[bot]
//     counts. Then a ticket or spec with an open blocker of this repo
//     (GitHub's blocked-by links) is ignore, blocked: a build could only
//     pause. The sweep after its last blocker closes builds it.
//   - an open PR with no run state, or with a run state at another head:
//     pull_request.opened, or ready_for_review for a PR that is not a draft
//     and not contract-implementer[bot]'s (reviewer)
//                                         reconcile-pr-<N>-<head sha>
//   - the newest hand-off marker that contract-reviewer[bot] or
//     contract-implementer[bot] posted on an open PR: issue_comment.created
//     (implementer for review-posted and recheck-failed, reviewer for
//     adjudicated)                        reconcile-handoff-<N>-<comment id>
//     A marker that the PR's run did not record (handoffs.json) for the
//     round it is at is an earlier run's or an earlier round's: no item.
//   - the newest comment by the maintainer on an open PR whose first line is
//     exactly /recheck, newer than the last hand-off of contract-reviewer[bot]
//     there: issue_comment.created (reviewer)
//                                         reconcile-recheck-<N>-<comment id>
//   - an open issue or PR with needs-info and a pause record, with a comment
//     by the maintainer newer than the record's paused_at: the newest such
//     comment, as issue_comment.created (implementer)
//                                         reconcile-resume-<N>-<comment id>
//   - a hand-off that is due and lost: an AFK part ends with `advance`, lock
//     release, then its hand-off, so a session that died between the two
//     leaves a run that nothing starts again. An open PR by
//     contract-implementer[bot] with a single-mode run at its head is one
//     when the run's phase owes a hand-off and `<run dir>/handoffs.json`
//     holds none of this run (its created_at) for that kind and round:
//       review-posted in round 1: review-posted, the review part (reviewer)
//       adjudicated: adjudicated, the adjudicate part (implementer)
//       review-posted in round 2 or later: recheck-failed, the recheck part
//       (reviewer)
//     A round with a gate pass at the run's head was a zero-finding round:
//     its review part goes on to Finish and posts no hand-off, so none is
//     due. The part starts again at the phase it reached, so it only posts
//     the hand-off. It is route's `relaunch`: paused, duplicate, the App's
//     switch, the PR lock and the cap. A held lock is ignore, locked, so a
//     part still running is never started twice. A relaunch whose part gave
//     up its lock (released or expired) with the hand-off still lost is no
//     duplicate: the next sweep starts it again.
//                                         reconcile-due-<N>-<kind>-<round>-<run>
//     <run> is the run's created_at, digits only, so a new run at the same
//     head is a new item.
//
// Only open issues and PRs are swept. The lists are read first, so a list
// that fails starts nothing. Then each item is decided and printed at once:
// a line that took a lock stands even when a later item fails.
import type { AppName } from './app-token.ts'
import { Failure, parse, repoOption, runMain, usageFor } from './cli.ts'
import { listLines } from './github.ts'
import { parseHandoff, type HandoffKind } from './handoff.ts'
import { readPosted } from './handoff-post.ts'
import { readPause } from './pause.ts'
import {
  BUILD_LABEL,
  buildLabelEvent,
  decide,
  IMPLEMENTER_BOT,
  liveContext,
  PAUSED_LABEL,
  pauseSecond,
  relaunch,
  REVIEWER_BOT,
  sameLogin,
  buildVeto,
  type Context,
  type Decision,
  type Payload,
  type RelaunchAction,
} from './route.ts'
import { loadState, type State } from './run-state.ts'

const usage = usageFor('reconcile')

// One line of the sweep: route's decision, and the App it is for.
type Line = Decision & { app: AppName }

// An open issue (or PR) as the issue list gives it.
type Listed = { number: number; author: string | null; labels: string[]; pull_request: boolean }

// The open issues and PRs with `label`, every page, by number.
async function listLabelled(repo: string, label: string): Promise<Listed[]> {
  const listed = await listLines<Listed>(
    [
      'api',
      '--paginate',
      '--jq',
      '.[] | {number, author: .user.login, labels: [.labels[].name], pull_request: (.pull_request != null)}',
      `repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
    ],
    `the open issues labelled ${label}`,
  )
  return listed.sort((a, b) => a.number - b.number)
}

const labelsOf = (names: string[]) => names.map((name) => ({ name }))

// A missed label: the labeled event of its latest adder.
async function labelItem(repo: string, issue: Listed, context: Context): Promise<Line | null> {
  // A build that paused goes on only through its answer (resumeItem).
  if ((await readPause({ kind: issue.pull_request ? 'pr' : 'issue', number: issue.number }))?.repo === repo) return null
  const labeled = await buildLabelEvent(repo, issue.number)
  const payload: Payload = {
    action: 'labeled',
    repository: { full_name: repo },
    sender: { login: labeled?.actor ?? undefined },
    issue: {
      number: issue.number,
      user: { login: issue.author ?? undefined },
      labels: labelsOf(issue.labels),
      ...(issue.pull_request ? { pull_request: prUrl(repo, issue.number) } : {}),
    },
    label: { name: BUILD_LABEL },
  }
  const delivery = `reconcile-label-${issue.number}-${labeled?.id ?? 'none'}`
  // has-pr and blocked come after paused and duplicate, as route's rules for both Apps come first.
  const veto = async () => (issue.pull_request ? null : buildVeto(repo, issue.number, context))
  return { ...(await decide('implementer', 'issues', delivery, payload, context, veto)), app: 'implementer' }
}

// An open PR as the PR list gives it.
type Pull = { number: number; author: string | null; draft: boolean; head_sha: string; labels: string[] }

async function listPulls(repo: string): Promise<Pull[]> {
  const listed = await listLines<Pull>(
    [
      'api',
      '--paginate',
      '--jq',
      '.[] | {number, author: .user.login, draft, head_sha: .head.sha, labels: [.labels[].name]}',
      `repos/${repo}/pulls?state=open&per_page=100`,
    ],
    'the open PRs',
  )
  return listed.sort((a, b) => a.number - b.number)
}

// The run state of PR `pr`, or null when it has none. A corrupt one exits 4.
async function stateOf(pr: number): Promise<State | null> {
  try {
    return await loadState(pr)
  } catch (error) {
    if (error instanceof Failure && error.code === 3) return null
    throw error
  }
}

// A missed review: the PR has no run at its head.
async function pullItem(repo: string, pull: Pull, context: Context): Promise<Line | null> {
  if ((await stateOf(pull.number))?.head_sha === pull.head_sha) return null
  const author = pull.author ?? undefined
  const action = !sameLogin(author, IMPLEMENTER_BOT) && !pull.draft ? 'ready_for_review' : 'opened'
  const payload: Payload = {
    action,
    repository: { full_name: repo },
    sender: { login: author },
    pull_request: { number: pull.number, draft: pull.draft, user: { login: author } },
  }
  const delivery = `reconcile-pr-${pull.number}-${pull.head_sha}`
  return { ...(await decide('reviewer', 'pull_request', delivery, payload, context)), app: 'reviewer' }
}

// A comment on an issue or PR, as the comment list gives it.
type Comment = { id: number; author: string | null; body: string | null; created_at: string }

// The comments of issue or PR `number`, oldest first, every page. Each is
// read once per sweep.
function commentReader(repo: string): (number: number) => Promise<Comment[]> {
  const read = new Map<number, Promise<Comment[]>>()
  return (number) => {
    let comments = read.get(number)
    if (comments === undefined) {
      comments = listLines<Comment>(
        ['api', '--paginate', '--jq', '.[] | {id, author: .user.login, body, created_at}', `repos/${repo}/issues/${number}/comments?per_page=100`],
        `the comments of #${number}`,
      )
      read.set(number, comments)
    }
    return comments
  }
}

const prUrl = (repo: string, pr: number) => ({ url: `https://api.github.com/repos/${repo}/pulls/${pr}` })

// A missed hand-off: the newest marker one of the Apps posted on the PR.
async function handoffItem(repo: string, pull: Pull, comments: Comment[], context: Context): Promise<Line | null> {
  const fromApp = (c: Comment) => sameLogin(c.author ?? undefined, REVIEWER_BOT) || sameLogin(c.author ?? undefined, IMPLEMENTER_BOT)
  const last = comments.filter((c) => fromApp(c) && parseHandoff(c.body) !== null).at(-1)
  if (last === undefined) return null
  // A marker hands off the PR's run only when this run recorded it (its
  // comment id, under its created_at) for the round the run is at. An earlier
  // run's marker, or an earlier round's, hands off nothing: the run's lost
  // hand-off is dueItem's. A record, not a time, because GitHub gives whole
  // seconds.
  const state = await stateOf(pull.number)
  if (state !== null) {
    const run = state.created_at
    const round = parseHandoff(last.body)?.round
    if (round !== state.round || !(await readPosted(pull.number)).some((p) => p.run === run && p.id === last.id && p.round === round)) return null
  }
  // The marker's kind says whose turn it is.
  const app: AppName = parseHandoff(last.body)?.kind === 'adjudicated' ? 'reviewer' : 'implementer'
  const payload: Payload = {
    action: 'created',
    repository: { full_name: repo },
    sender: { login: last.author ?? undefined },
    issue: { number: pull.number, user: { login: pull.author ?? undefined }, labels: labelsOf(pull.labels), pull_request: prUrl(repo, pull.number) },
    comment: { body: last.body, created_at: last.created_at },
  }
  const delivery = `reconcile-handoff-${pull.number}-${last.id}`
  return { ...(await decide(app, 'issue_comment', delivery, payload, context)), app }
}

// A missed answer: the maintainer's newest comment after the run paused.
// A missed /recheck: the maintainer's newest one since the reviewer last
// handed off. An older /recheck answered an earlier round.
async function recheckItem(repo: string, pull: Pull, comments: Comment[], context: Context): Promise<Line | null> {
  const maintainer = await context.maintainer()
  const handedOff = comments.findLastIndex((c) => sameLogin(c.author ?? undefined, REVIEWER_BOT) && parseHandoff(c.body) !== null)
  const last = comments
    .slice(handedOff + 1)
    .filter((c) => sameLogin(c.author ?? undefined, maintainer) && (c.body ?? '').split('\n')[0]?.replace(/\r$/, '') === '/recheck')
    .at(-1)
  if (last === undefined) return null
  const payload: Payload = {
    action: 'created',
    repository: { full_name: repo },
    sender: { login: last.author ?? undefined },
    issue: { number: pull.number, user: { login: pull.author ?? undefined }, labels: labelsOf(pull.labels), pull_request: prUrl(repo, pull.number) },
    comment: { body: last.body, created_at: last.created_at },
  }
  const delivery = `reconcile-recheck-${pull.number}-${last.id}`
  return { ...(await decide('reviewer', 'issue_comment', delivery, payload, context)), app: 'reviewer' }
}

async function resumeItem(repo: string, paused: Listed, comments: (number: number) => Promise<Comment[]>, context: Context): Promise<Line | null> {
  const record = await readPause({ kind: paused.pull_request ? 'pr' : 'issue', number: paused.number })
  if (record === null) return null
  const maintainer = await context.maintainer()
  // From the second the pause began, as route counts a reply (pauseSecond).
  const since = pauseSecond(record.paused_at)
  const last = (await comments(paused.number))
    .filter((c) => sameLogin(c.author ?? undefined, maintainer) && Date.parse(c.created_at) >= since)
    .at(-1)
  if (last === undefined) return null
  const payload: Payload = {
    action: 'created',
    repository: { full_name: repo },
    sender: { login: last.author ?? undefined },
    issue: {
      number: paused.number,
      user: { login: paused.author ?? undefined },
      labels: labelsOf(paused.labels),
      ...(paused.pull_request ? { pull_request: prUrl(repo, paused.number) } : {}),
    },
    comment: { body: last.body, created_at: last.created_at },
  }
  const delivery = `reconcile-resume-${paused.number}-${last.id}`
  return { ...(await decide('implementer', 'issue_comment', delivery, payload, context)), app: 'implementer' }
}

// The hand-off a run at `state` owes, and the part (and its App) that posts it.
function owed(state: State): { kind: HandoffKind; action: RelaunchAction; app: AppName } | null {
  if (state.phase === 'adjudicated') return { kind: 'adjudicated', action: 'adjudicate', app: 'implementer' }
  if (state.phase !== 'review-posted') return null
  return state.round === 1 ? { kind: 'review-posted', action: 'review', app: 'reviewer' } : { kind: 'recheck-failed', action: 'recheck', app: 'reviewer' }
}

// A lost hand-off: the run's phase owes one, and this run recorded none.
async function dueItem(repo: string, pull: Pull, context: Context): Promise<Line | null> {
  // Only a hand-off on the bot's PR starts the other App's part.
  if (!sameLogin(pull.author ?? undefined, IMPLEMENTER_BOT)) return null
  const state = await stateOf(pull.number)
  if (state === null || state.repo !== repo || state.mode !== 'single' || state.head_sha !== pull.head_sha) return null
  const due = owed(state)
  if (due === null) return null
  const { round, head_sha: head, created_at: run } = state
  if (state.gates.some((g) => g.round === round && g.commit === head && g.result === 'pass')) return null
  if ((await readPosted(pull.number)).some((p) => p.run === run && p.kind === due.kind && p.round === round)) return null
  const delivery = `reconcile-due-${pull.number}-${due.kind}-${round}-${run.replace(/[^0-9]/g, '')}`
  return { ...(await relaunch(due.app, due.action, delivery, repo, pull.number, context)), app: due.app }
}

async function reconcile(argv: string[]): Promise<number> {
  const { values } = parse(argv, { repo: { type: 'string' } }, usage)
  const repo = repoOption(values.repo, usage)

  // The config and the maintainer are read once for every item. A broken
  // config exits 4 before anything is decided.
  const live = liveContext()
  const config = await live.config(repo, undefined)
  // No labelEvent: a missed label keys its build by this sweep's own delivery
  // id (labelItem), so a build that ended with no PR and no pause can get one more.
  const context: Context = { config: async () => config, maintainer: live.maintainer, closed: live.closed, blocked: live.blocked }

  const labelled = await listLabelled(repo, BUILD_LABEL)
  const pulls = await listPulls(repo)
  const paused = await listLabelled(repo, PAUSED_LABEL)
  const comments = commentReader(repo)
  // Only a ticket or a spec can have a PR that closes it. The list is read
  // with the others, so a list that fails starts nothing.
  if (labelled.some((issue) => !issue.pull_request)) await context.closed(repo)

  const items: (() => Promise<Line | null>)[] = [
    ...labelled.map((issue) => () => labelItem(repo, issue, context)),
    ...pulls.map((pull) => () => pullItem(repo, pull, context)),
    ...pulls.map((pull) => async () => handoffItem(repo, pull, await comments(pull.number), context)),
    ...pulls.map((pull) => async () => recheckItem(repo, pull, await comments(pull.number), context)),
    // After the hand-off items: a marker that is there takes the PR lock first.
    ...pulls.map((pull) => () => dueItem(repo, pull, context)),
    ...paused.map((issue) => () => resumeItem(repo, issue, comments, context)),
  ]

  let code = 0
  for (const item of items) {
    try {
      const line = await item()
      if (line !== null) process.stdout.write(`${JSON.stringify(line)}\n`)
    } catch (error) {
      if (!(error instanceof Failure)) throw error
      process.stderr.write(`review.ts reconcile: ${error.message}\n`)
      if (code === 0) code = error.code
    }
  }
  return code
}

export const main = runMain('reconcile', reconcile)
