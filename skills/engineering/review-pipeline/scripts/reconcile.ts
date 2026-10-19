// `review.ts reconcile --repo O/R` (usage in the table in cli.ts): the
// hourly sweep that starts the work a missed webhook delivery should have
// started (the Mac was off, or T3 dropped it). It lists the open work, builds
// for each item the event and payload that `route` would have received, and
// decides it with route's own `decide`, so caps, paused, locks, sender and
// author rules give the same answers. It never holds a rule of its own, but
// one: a ticket or spec that a trusted open PR closes is ignore, has-pr. The
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
//     counts.
//   - an open PR with no run state, or with a run state at another head:
//     pull_request.opened, or ready_for_review for a PR that is not a draft
//     and not contract-implementer[bot]'s (reviewer)
//                                         reconcile-pr-<N>-<head sha>
//   - the newest hand-off marker that contract-reviewer[bot] or
//     contract-implementer[bot] posted on an open PR: issue_comment.created
//     (implementer for review-posted and recheck-failed, reviewer for
//     adjudicated)                        reconcile-handoff-<N>-<comment id>
//   - the newest comment by the maintainer on an open PR whose first line is
//     exactly /recheck, newer than the last hand-off of contract-reviewer[bot]
//     there: issue_comment.created (reviewer)
//                                         reconcile-recheck-<N>-<comment id>
//   - an open issue or PR with needs-info and a pause record, with a comment
//     by the maintainer newer than the record's paused_at: the newest such
//     comment, as issue_comment.created (implementer)
//                                         reconcile-resume-<N>-<comment id>
//
// Only open issues and PRs are swept. The lists are read first, so a list
// that fails starts nothing. Then each item is decided and printed at once:
// a line that took a lock stands even when a later item fails.
import type { AppName } from './app-token.ts'
import { Failure, parse, repoOption, runMain, usageFor } from './cli.ts'
import { listLines } from './github.ts'
import { parseHandoff } from './handoff.ts'
import { readPause } from './pause.ts'
import {
  BUILD_LABEL,
  decide,
  IMPLEMENTER_BOT,
  liveContext,
  PAUSED_LABEL,
  REVIEWER_BOT,
  sameLogin,
  subIssues,
  type Context,
  type Decision,
  type Payload,
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

// The issues of `repo` that an open PR by the maintainer or by
// contract-implementer[bot] closes (GitHub's closing references: "Closes #N"
// in the body, or a link made by hand), every page. Anyone can open a PR that
// says "Closes #N", so a PR by anyone else hides no ticket: the same trust
// set as route's author rule. GraphQL gives a bot's login without [bot].
async function closedByOpenPrs(repo: string, maintainer: string): Promise<Set<number>> {
  const [owner = '', name = ''] = repo.split('/')
  const query = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        author { __typename login }
        closingIssuesReferences(first: 100) { nodes { number repository { nameWithOwner } } }
      }
    }
  }
}`
  const closers = await listLines<{ number: number; author: string | null; bot: boolean; closes: { number: number; repo: string }[] }>(
    [
      'api',
      'graphql',
      '--paginate',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '--jq',
      '.data.repository.pullRequests.nodes[] | {number, author: .author.login, bot: (.author.__typename == "Bot"), closes: [.closingIssuesReferences.nodes[] | {number, repo: .repository.nameWithOwner}]}',
    ],
    'the issues that open PRs close',
  )
  const trusted = (pr: { author: string | null; bot: boolean }) => {
    const login = pr.author === null ? undefined : pr.bot ? `${pr.author}[bot]` : pr.author
    return sameLogin(login, maintainer) || sameLogin(login, IMPLEMENTER_BOT)
  }
  const same = (other: string) => other.toLowerCase() === repo.toLowerCase()
  return new Set(closers.filter(trusted).flatMap((pr) => pr.closes.filter((c) => same(c.repo)).map((c) => c.number)))
}

// Whether an open PR closes ticket `issue`, or one of its sub-issues.
async function hasPr(repo: string, issue: number, closed: Set<number>): Promise<boolean> {
  if (closed.has(issue)) return true
  if (closed.size === 0) return false
  return (await subIssues(repo, issue)).some((sub) => closed.has(sub.number))
}

const labelsOf = (names: string[]) => names.map((name) => ({ name }))

// A missed label: the labeled event of its latest adder.
async function labelItem(repo: string, issue: Listed, closed: Set<number>, context: Context): Promise<Line | null> {
  // A build that paused goes on only through its answer (resumeItem).
  if ((await readPause({ kind: issue.pull_request ? 'pr' : 'issue', number: issue.number }))?.repo === repo) return null
  const events = await listLines<{ id: number; label: string | null; actor: string | null }>(
    [
      'api',
      '--paginate',
      '--jq',
      '.[] | select(.event == "labeled") | {id, label: .label.name, actor: .actor.login}',
      `repos/${repo}/issues/${issue.number}/events?per_page=100`,
    ],
    `the events of #${issue.number}`,
  )
  const labeled = events.filter((e) => e.label === BUILD_LABEL).at(-1)
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
  // has-pr comes after paused and duplicate, as route's rules for both Apps come first.
  const hasPrNow = async () => (!issue.pull_request && (await hasPr(repo, issue.number, closed)) ? 'has-pr' : null)
  return { ...(await decide('implementer', 'issues', delivery, payload, context, hasPrNow)), app: 'implementer' }
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
  const since = Date.parse(record.paused_at)
  const last = (await comments(paused.number))
    .filter((c) => sameLogin(c.author ?? undefined, maintainer) && Date.parse(c.created_at) > since)
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

async function reconcile(argv: string[]): Promise<number> {
  const { values } = parse(argv, { repo: { type: 'string' } }, usage)
  const repo = repoOption(values.repo, usage)

  // The config and the maintainer are read once for every item. A broken
  // config exits 4 before anything is decided.
  const live = liveContext()
  const config = await live.config(repo, undefined)
  const context: Context = { config: async () => config, maintainer: live.maintainer }

  const labelled = await listLabelled(repo, BUILD_LABEL)
  const pulls = await listPulls(repo)
  const paused = await listLabelled(repo, PAUSED_LABEL)
  const comments = commentReader(repo)
  // Only a ticket or a spec can have a PR that closes it.
  const closed = labelled.some((issue) => !issue.pull_request) ? await closedByOpenPrs(repo, await context.maintainer()) : new Set<number>()

  const items: (() => Promise<Line | null>)[] = [
    ...labelled.map((issue) => () => labelItem(repo, issue, closed, context)),
    ...pulls.map((pull) => () => pullItem(repo, pull, context)),
    ...pulls.map((pull) => async () => handoffItem(repo, pull, await comments(pull.number), context)),
    ...pulls.map((pull) => async () => recheckItem(repo, pull, await comments(pull.number), context)),
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
