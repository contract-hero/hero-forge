// `review.ts route` (usage in the table in cli.ts): turn one GitHub webhook
// delivery into one decision for an App, so the T3 router prompt only calls
// this and holds no filtering of its own.
//
// The config is the repo's docs/agents/review.md on its default branch, read
// through `gh api`, never from the local checkout. "The maintainer" is the
// local gh user. First match wins, and every ignore has a reason.
//
// Both Apps:
//   1. paused: true                                 ignore, paused
//   2. this App saw the delivery id before          ignore, duplicate
//
// --app reviewer, a pull_request event:
//   3. not a trigger action                         ignore, action:<name>
//      contract-implementer[bot]'s PR: opened, reopened
//      any other PR: ready_for_review, or opened or reopened when not a draft
//      (a by-hand /implement-pr opens a draft and reviews it in its own session)
//   4. no docs/agents/review.md on the default branch
//                                                   ignore, no-config
//   5. the PR author is not the maintainer or contract-implementer[bot]
//                                                   ignore, author
//   6. a run state of a stack (mode layer or stack-final), terminal or not:
//      the stack owns the PR                        ignore, stack
//   7. a run state that is not terminal             ignore, locked
//   8. review
// --app reviewer, an issue_comment event:
//   3. not created (an edit never counts)           ignore, action:<name>
//   4. not on a PR                                  ignore, not-pull-request
//   5. no docs/agents/review.md                     ignore, no-config
//   6. sender contract-implementer[bot]: the last line is not an adjudicated
//      hand-off for this PR                         ignore, marker
//      or the PR is not the bot's                   ignore, author
//      sender the maintainer: the first line is not exactly /recheck
//                                                   ignore, not-recheck
//      or the PR is not the maintainer's            ignore, author
//      anyone else                                  ignore, sender
//   7. the run state phase is not adjudicated       ignore, phase
//   8. recheck
// --app reviewer, any other event                   ignore, event:<name>
//
// --app implementer, an issues event:
//   3. not labeled or unlabeled                     ignore, action:<name>
//   4. no docs/agents/review.md                     ignore, no-config
//   5. no implementer.app: enabled                  ignore, disabled
//   6. labeled: a label other than ready-for-agent, or unlabeled: a label
//      other than needs-triage                      ignore, label:<name>
//      (the triage hand-off moves needs-triage to ready-for-agent, and GitHub
//      sends its two deliveries in the same second; either one alone starts
//      the build, so a router that fails on one loses nothing. Removing
//      another label, such as needs-info, from a ready ticket starts nothing)
//   7. the issue is a PR                            ignore, pull-request
//   8. the sender is not the maintainer             ignore, sender
//   9. ready-for-agent is not on the issue now, as GitHub says (not as the
//      payload said)                                ignore, not-ready
//  10. the issue has a parent issue                 ignore, has-parent
//  11. the issue's author, or (for a spec) the author of any of its
//      sub-issues, is not the maintainer: the build agent reads that text
//                                                   ignore, author (issue: the one at fault)
//  12. build-spec when it has sub-issues, else build-ticket, once the issue
//      lock is held and one of implementer.attempts is reserved (below).
//      The second delivery of a hand-off then finds the lock held, or the
//      attempt spent, or the delivery a duplicate.
// --app implementer, an issue_comment event:
//   3. not created                                  ignore, action:<name>
//   4, 5 as above
//   6. sender contract-reviewer[bot]: not on a PR   ignore, not-pull-request
//      the last line is not a review-posted or recheck-failed hand-off for
//      this PR                                      ignore, marker
//      the PR is not contract-implementer[bot]'s    ignore, author
//      the run state phase is not review-posted     ignore, phase
//      a pause record for the PR (only resume goes on)
//                                                   ignore, paused-run
//      adjudicate
//      sender the maintainer: no needs-info label   ignore, not-paused
//      no pause record for the issue or PR          ignore, no-pause-record
//      the comment is not later than the record's paused_at (a reply to an
//      earlier pause)                               ignore, stale-reply
//      resume
//      anyone else                                  ignore, sender
// --app implementer, any other event                ignore, event:<name>
//
// Then, for every decision that starts work: a held lock (per PR, or per
// issue for a build or a resume on an issue) is ignore, locked; for a build,
// a ticket whose builds reached implementer.attempts is ignore, attempts;
// the App's daily run cap is ignore, cap. Else take the lock, reserve the
// attempt, record the delivery, count the run, and print the decision with
// the lock's owner token (lock_token), for the run to release it.
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { APPS, type AppName } from './app-token.ts'
import { countRun, releaseAttempt, reserveAttempt, uncountRun } from './cap.ts'
import { Failure, isRepo, parse, runMain, usageFor } from './cli.ts'
import { resolveConfigText, type ResolvedConfig } from './config.ts'
import { gh, json, listLines, oneLine, userIdentity } from './github.ts'
import { parseHandoff, type HandoffKind } from './handoff.ts'
import { issueLockFile, prLockFile, releaseIssueLock, releasePrLock, takeIssueLock, takePrLock, underPrLockGuard, whileHolding } from './lock.ts'
import { readPause } from './pause.ts'
import { loadState, stateRoot, TERMINAL, type Phase } from './run-state.ts'

const usage = usageFor('route')

// The two Apps' bot logins.
export const IMPLEMENTER_BOT = 'contract-implementer[bot]'
export const REVIEWER_BOT = 'contract-reviewer[bot]'

// The label that asks the Implementer to build, the one a paused run carries,
// and the one the triage hand-off to ready-for-agent removes.
export const BUILD_LABEL = 'ready-for-agent'
export const PAUSED_LABEL = 'needs-info'
export const TRIAGE_LABEL = 'needs-triage'

// GitHub logins are case-insensitive.
export const sameLogin = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase()

// Whether `action` on a PR by `author` starts a review. An author who is not
// the bot gets the maintainer's actions here: the author rule then ignores
// anyone who is not the maintainer, so this needs no maintainer lookup.
function triggers(action: string, author: string | undefined, draft: boolean): boolean {
  if (sameLogin(author, IMPLEMENTER_BOT)) return action === 'opened' || action === 'reopened'
  return action === 'ready_for_review' || ((action === 'opened' || action === 'reopened') && !draft)
}

export type Action = 'review' | 'recheck' | 'build-ticket' | 'build-spec' | 'adjudicate' | 'resume' | 'ignore'

// `pr` is set when the delivery is about a PR, `issue` when it is about an
// issue that is not a PR (a label, or a comment on an issue). `lock_token` is
// the owner token of the lock that work took, for the launched thread to
// release it at its end; null on an ignore, which takes no lock.
export type Decision = {
  action: Action
  repo: string | null
  pr: number | null
  issue: number | null
  reason: string | null
  lock_token: string | null
}

// What a rule found: an ignore with its reason, or work to start. Work names
// the lock it takes and, for a build, the ticket whose attempt it reserves
// under the cap `limit`.
type Start = {
  action: Exclude<Action, 'ignore'>
  lock: { kind: 'pr' | 'issue'; number: number }
  attempt?: { issue: number; limit: number }
}
// An ignore may name another issue than the delivery's: the one at fault.
type Outcome = { ignore: string; issue?: number } | Start

const why = (reason: string, issue?: number): Outcome => (issue === undefined ? { ignore: reason } : { ignore: reason, issue })

// The fields of a webhook payload that route reads. GitHub sends them; route
// trusts that the payload came from GitHub (the router checks the signature).
export type Payload = {
  action?: unknown
  repository?: { full_name?: unknown; default_branch?: unknown }
  sender?: { login?: unknown }
  pull_request?: { number?: unknown; draft?: unknown; user?: { login?: unknown } }
  issue?: { number?: unknown; pull_request?: unknown; user?: { login?: unknown }; labels?: unknown }
  label?: { name?: unknown }
  comment?: { body?: unknown; created_at?: unknown }
}

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)

async function readPayload(file: string): Promise<Payload> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    throw new Failure(`cannot read the payload ${file}: ${(error as Error).message}`, 1)
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Failure(`the payload ${file} is not JSON`, 1)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Failure(`the payload ${file} is not a JSON object`, 1)
  }
  return value as Payload
}

// The review config on the repo's default branch, or null when the file is
// not there. A file that is there but invalid exits 4.
async function remoteConfig(repo: string, branch: string | undefined): Promise<ResolvedConfig | null> {
  const path = 'docs/agents/review.md'
  const ref = branch === undefined ? '' : `?ref=${encodeURIComponent(branch)}`
  const got = await gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${path}${ref}`])
  if (got.code !== 0) {
    if (/HTTP 404/.test(got.stderr)) return null
    throw new Failure(`cannot read ${path} of ${repo}: ${oneLine(got.stderr)}`, 1)
  }
  const loaded = resolveConfigText(got.stdout, `${repo}:${path}`)
  if (!loaded.ok) throw new Failure(loaded.message, loaded.code)
  return loaded.config
}

// Whether issue `issue` has a parent issue, how many sub-issues it has, and
// its labels, as GitHub says now (not as the payload said when the label
// landed or left).
async function relations(repo: string, issue: number): Promise<{ parent: boolean; subIssues: number; labels: string[] }> {
  const got = await gh(['api', `repos/${repo}/issues/${issue}`, '--jq', '{parent_issue_url, sub_issues_summary, labels: [.labels[].name]}'])
  if (got.code !== 0) throw new Failure(`cannot read issue #${issue} of ${repo}: ${oneLine(got.stderr)}`, 1)
  const found = json<{ parent_issue_url?: unknown; sub_issues_summary?: { total?: unknown } | null; labels?: unknown }>(got.stdout, `issue #${issue}`)
  const total = found.sub_issues_summary?.total
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
    throw new Failure(`GitHub sent no sub-issue count for issue #${issue} of ${repo}`, 1)
  }
  if (!Array.isArray(found.labels) || !found.labels.every((l) => typeof l === 'string')) {
    throw new Failure(`GitHub sent no labels for issue #${issue} of ${repo}`, 1)
  }
  return { parent: typeof found.parent_issue_url === 'string', subIssues: total, labels: found.labels }
}

// The sub-issues of `issue`, each with its author, every page.
export function subIssues(repo: string, issue: number): Promise<{ number: number; author: string | null }[]> {
  return listLines(
    ['api', '--paginate', '--jq', '.[] | {number, author: .user.login}', `repos/${repo}/issues/${issue}/sub_issues?per_page=100`],
    `the sub-issues of #${issue}`,
  )
}

// The deliveries that started work, per App: one record each, under
// `<state root>/deliveries/<app>/<id>`, `{state, pr, token}` (or `issue` in
// place of `pr`, for an issue lock). A call writes it `pending`, with its
// lock token, before it counts the run, and `done` after. Only a `done`
// record makes a repeat a duplicate. A `pending` record (a call that was
// killed between the two, or one still running) is decided again: its lock,
// while held and fresh, makes the repeat `locked`; once the lock is released
// or expired, the repeat can start the work and overwrite it. An ignored
// delivery is not recorded, so GitHub may send it again once the reason is
// gone.
type DeliveryState = 'pending' | 'done'

function deliveryFile(app: AppName, delivery: string): string {
  return join(stateRoot(), 'deliveries', app, delivery)
}

// Whether work already came from `delivery` for `app`: its record is done.
// No record, or one that is pending or cannot be read, is not a duplicate.
// The reviewer also reads `<state root>/deliveries/<id>`, where 1.0.9 kept
// its records before they moved under the App's name.
async function doneDelivery(app: AppName, delivery: string): Promise<boolean> {
  const files = [deliveryFile(app, delivery), ...(app === 'reviewer' ? [join(stateRoot(), 'deliveries', delivery)] : [])]
  for (const file of files) {
    try {
      if ((JSON.parse(await readFile(file, 'utf8')) as { state?: unknown }).state === 'done') return true
    } catch {
      // No record there, or not one that can be read: not a duplicate.
    }
  }
  return false
}

// What a done record also keeps, so `route undo` can give it back: the repo,
// the ticket whose attempt the decision reserved (null for no build), and
// the time its run was counted.
type Taken = { repo: string; attempt: number | null; counted_at: string }

// Write the record whole: a temp file in the same dir, then rename.
async function recordDelivery(
  app: AppName,
  delivery: string,
  state: DeliveryState,
  lock: Start['lock'],
  token: string,
  taken?: Taken,
): Promise<void> {
  const file = deliveryFile(app, delivery)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${randomBytes(6).toString('hex')}`
  try {
    await writeFile(tmp, `${JSON.stringify({ state, [lock.kind]: lock.number, token, ...taken })}\n`, { mode: 0o600 })
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
}

// The record of `delivery` for `app`, or null when there is none or it
// cannot be read.
async function deliveryRecord(app: AppName, delivery: string): Promise<{ state?: unknown; token?: unknown } | null> {
  try {
    return JSON.parse(await readFile(deliveryFile(app, delivery), 'utf8')) as { state?: unknown; token?: unknown }
  } catch {
    return null
  }
}

async function forgetDelivery(app: AppName, delivery: string): Promise<void> {
  await rm(deliveryFile(app, delivery), { force: true })
}

// The run state phase of PR `pr`, or null when it has no run state. A
// corrupt state file exits 4.
async function phaseOf(pr: number): Promise<Phase | null> {
  return (await runOf(pr))?.phase ?? null
}

// The run state of PR `pr`, or null when it has none. Corrupt: exit 4.
async function runOf(pr: number): Promise<{ phase: Phase; mode: string } | null> {
  try {
    return await loadState(pr)
  } catch (error) {
    if (error instanceof Failure && error.code === 3) return null
    throw error
  }
}

// One delivery, as the rules read it.
type Event = {
  name: string
  action: string
  payload: Payload
  repo: string | null
  config: ResolvedConfig | null
  pr: number | null
  issue: number | null
  sender: string | undefined
  maintainer: () => Promise<string>
}

function reviewerRule(e: Event): Promise<Outcome> | Outcome {
  if (e.name === 'pull_request') return reviewRule(e)
  if (e.name === 'issue_comment') return recheckRule(e)
  return why(`event:${e.name}`)
}

async function reviewRule(e: Event): Promise<Outcome> {
  const author = text(e.payload.pull_request?.user?.login)
  if (!triggers(e.action, author, e.payload.pull_request?.draft === true)) return why(`action:${e.action}`)
  if (e.config === null) return why('no-config')
  if (author === undefined) return why('author')
  if (!sameLogin(author, IMPLEMENTER_BOT) && !sameLogin(author, await e.maintainer())) return why('author')
  // A pull_request event always carries its number: a payload without one is not GitHub's.
  if (e.pr === null) throw new Failure('the pull_request payload has no pull_request.number', 1)
  const run = await runOf(e.pr)
  // A stack owns its layers and its stack PR, terminal or not: a late
  // ready_for_review or opened never starts a single-mode review of one.
  if (run !== null && run.mode !== 'single') return why('stack')
  if (run !== null && !TERMINAL.includes(run.phase)) return why('locked')
  return { action: 'review', lock: { kind: 'pr', number: e.pr } }
}

async function recheckRule(e: Event): Promise<Outcome> {
  if (e.action !== 'created') return why(`action:${e.action}`)
  if (e.pr === null) return why('not-pull-request')
  if (e.config === null) return why('no-config')
  const author = text(e.payload.issue?.user?.login)
  const body = text(e.payload.comment?.body) ?? ''
  if (sameLogin(e.sender, IMPLEMENTER_BOT)) {
    const handoff = parseHandoff(body)
    if (handoff === null || handoff.kind !== 'adjudicated' || handoff.pr !== e.pr) return why('marker')
    if (!sameLogin(author, IMPLEMENTER_BOT)) return why('author')
  } else if (e.sender !== undefined && sameLogin(e.sender, await e.maintainer())) {
    if (body.split('\n')[0]?.replace(/\r$/, '') !== '/recheck') return why('not-recheck')
    if (!sameLogin(author, await e.maintainer())) return why('author')
  } else {
    return why('sender')
  }
  if ((await phaseOf(e.pr)) !== 'adjudicated') return why('phase')
  return { action: 'recheck', lock: { kind: 'pr', number: e.pr } }
}

// The hand-off kinds that start an Adjudication.
const ADJUDICATE_ON: HandoffKind[] = ['review-posted', 'recheck-failed']

async function implementerRule(e: Event): Promise<Outcome> {
  if (e.name !== 'issues' && e.name !== 'issue_comment') return why(`event:${e.name}`)
  const actions = e.name === 'issues' ? ['labeled', 'unlabeled'] : ['created']
  if (!actions.includes(e.action)) return why(`action:${e.action}`)
  if (e.config === null) return why('no-config')
  if (!e.config.implementer.app) return why('disabled')
  return e.name === 'issues' ? buildRule(e, e.config) : commentRule(e)
}

async function buildRule(e: Event, config: ResolvedConfig): Promise<Outcome> {
  const label = text(e.payload.label?.name) ?? ''
  if (label !== (e.action === 'labeled' ? BUILD_LABEL : TRIAGE_LABEL)) return why(`label:${label}`)
  if (e.pr !== null) return why('pull-request')
  if (e.repo === null || e.issue === null) throw new Failure('the issues payload has no repository.full_name or issue.number', 1)
  if (!sameLogin(e.sender, await e.maintainer())) return why('sender')
  const maintainer = await e.maintainer()
  const { parent, subIssues: count, labels } = await relations(e.repo, e.issue)
  if (!labels.includes(BUILD_LABEL)) return why('not-ready')
  if (parent) return why('has-parent')
  // The author of an issue never changes, so the payload's is GitHub's.
  if (!sameLogin(text(e.payload.issue?.user?.login), maintainer)) return why('author')
  if (count > 0) {
    const stranger = (await subIssues(e.repo, e.issue)).find((sub) => !sameLogin(sub.author ?? undefined, maintainer))
    if (stranger !== undefined) return why('author', stranger.number)
  }
  return {
    action: count > 0 ? 'build-spec' : 'build-ticket',
    lock: { kind: 'issue', number: e.issue },
    attempt: { issue: e.issue, limit: config.implementer.attempts },
  }
}

async function commentRule(e: Event): Promise<Outcome> {
  if (sameLogin(e.sender, REVIEWER_BOT)) {
    if (e.pr === null) return why('not-pull-request')
    const handoff = parseHandoff(text(e.payload.comment?.body))
    if (handoff === null || !ADJUDICATE_ON.includes(handoff.kind) || handoff.pr !== e.pr) return why('marker')
    if (!sameLogin(text(e.payload.issue?.user?.login), IMPLEMENTER_BOT)) return why('author')
    if ((await phaseOf(e.pr)) !== 'review-posted') return why('phase')
    // A paused Adjudication goes on only through resume, on the maintainer's answer.
    if ((await readPause({ kind: 'pr', number: e.pr })) !== null) return why('paused-run')
    return { action: 'adjudicate', lock: { kind: 'pr', number: e.pr } }
  }
  if (e.sender === undefined || !sameLogin(e.sender, await e.maintainer())) return why('sender')
  const labels = Array.isArray(e.payload.issue?.labels) ? (e.payload.issue.labels as { name?: unknown }[]) : []
  if (!labels.some((l) => l?.name === PAUSED_LABEL)) return why('not-paused')
  const subject = e.pr !== null ? { kind: 'pr' as const, number: e.pr } : e.issue !== null ? { kind: 'issue' as const, number: e.issue } : null
  if (subject === null) throw new Failure('the issue_comment payload has no issue.number', 1)
  const record = await readPause(subject)
  if (record === null || record.repo !== e.repo) return why('no-pause-record')
  // The record is the current pause. A reply written before it (a late
  // delivery of the answer to an earlier pause) does not answer it. GitHub
  // gives comment times in whole seconds, so a reply counts from the second
  // the pause began (pauseSecond): one written while the pause was being set
  // up answers it.
  const written = Date.parse(text(e.payload.comment?.created_at) ?? '')
  if (!(written >= pauseSecond(record.paused_at))) return why('stale-reply')
  return { action: 'resume', lock: subject }
}

// The start of the whole second a pause began in, as epoch milliseconds
// (NaN for an unreadable time, which no reply passes).
export function pauseSecond(pausedAt: string): number {
  return Math.floor(Date.parse(pausedAt) / 1000) * 1000
}

function takeFor(lock: Start['lock'], holder: Record<string, unknown>): Promise<string | null> {
  return lock.kind === 'pr' ? takePrLock(lock.number, holder) : takeIssueLock(lock.number, holder)
}

function releaseFor(lock: Start['lock'], token: string): Promise<boolean> {
  return lock.kind === 'pr' ? releasePrLock(lock.number, token) : releaseIssueLock(lock.number, token)
}

// What a decision reads besides the delivery: the review config of a repo
// and the maintainer's login. `route` reads them for each delivery; a sweep
// gives them once for all its items.
export type Context = {
  config: (repo: string, branch: string | undefined) => Promise<ResolvedConfig | null>
  maintainer: () => Promise<string>
}

// The context of one delivery: the config on the default branch, and the
// maintainer, looked up once and only when a rule needs it.
export function liveContext(): Context {
  let maintainer: Promise<string> | undefined
  return { config: remoteConfig, maintainer: () => (maintainer ??= userIdentity().then((u) => u.login)) }
}

// Decide one delivery for `app`, and for work take its lock, reserve the
// attempt, record the delivery and count the run, as the rules at the top of
// this file say. `before` is a caller's own ignore reason, asked after the
// rules for both Apps (paused, duplicate) and before the App's rules; route
// gives none.
export function decide(
  app: AppName,
  name: string,
  delivery: string,
  payload: Payload,
  context: Context,
  before?: () => Promise<string | null>,
): Promise<Decision> {
  return decideBy(app, name, delivery, payload, context, before, (e) => (app === 'reviewer' ? reviewerRule(e) : implementerRule(e)))
}

// The parts that a lost hand-off starts again (reconcile.ts finds them).
export type RelaunchAction = 'review' | 'adjudicate' | 'recheck'

// Decide the relaunch of part `action` of the AFK run on PR `pr`, for `app`,
// whose hand-off reconcile found due. GitHub sent no event for it, so its one
// rule is the App's switch (the part posts the hand-off as that App):
// no app: enabled, or no implementer.app: enabled, is ignore, disabled. The
// rules for both Apps come first, and the lock and the cap after, as decide.
// A relaunch is a duplicate only while the part it started holds its lock:
// a part that released the lock (or let it expire) with the hand-off still
// lost is started again, so its done record is forgotten first. The record
// is read and forgotten under the PR lock's guard: a relaunch writes its new
// record only after it takes the lock, so an overlapping sweep sees either
// no record or one whose token holds the lock, and never forgets it.
export async function relaunch(app: AppName, action: RelaunchAction, delivery: string, repo: string, pr: number, context: Context): Promise<Decision> {
  await underPrLockGuard(pr, async (holds) => {
    const started = await deliveryRecord(app, delivery)
    if (started?.state === 'done' && !(typeof started.token === 'string' && (await holds(started.token)))) {
      await forgetDelivery(app, delivery)
    }
  })
  const payload: Payload = { repository: { full_name: repo }, pull_request: { number: pr } }
  return decideBy(app, 'relaunch', delivery, payload, context, undefined, (e) => {
    if (e.config === null) return why('no-config')
    if (!(app === 'reviewer' ? e.config.app : e.config.implementer.app)) return why('disabled')
    return { action, lock: { kind: 'pr', number: pr } }
  })
}

async function decideBy(
  app: AppName,
  name: string,
  delivery: string,
  payload: Payload,
  context: Context,
  before: (() => Promise<string | null>) | undefined,
  rule: (e: Event) => Promise<Outcome> | Outcome,
): Promise<Decision> {
  const full = payload.repository?.full_name
  const repo = isRepo(full) ? full : null
  // A comment or a label on a PR comes as an issue event with issue.pull_request set.
  const issueNumber = whole(payload.issue?.number)
  const onPr = payload.issue !== undefined && payload.issue.pull_request !== undefined && payload.issue.pull_request !== null
  const pr = whole(payload.pull_request?.number) ?? (onPr ? issueNumber : null)
  const issue = onPr || payload.pull_request !== undefined ? null : issueNumber
  const decided = (action: Action, reason: string | null, token: string | null = null): Decision =>
    ({ action, repo, pr, issue, reason, lock_token: token })
  // An ignore about another issue than the delivery's names that issue.
  const decidedOn = (other: number, reason: string): Decision =>
    ({ action: 'ignore', repo, pr: null, issue: other, reason, lock_token: null })

  const branch = payload.repository?.default_branch
  const config = repo === null ? null : await context.config(repo, typeof branch === 'string' ? branch : undefined)

  if (config?.paused === true) return decided('ignore', 'paused')
  if (await doneDelivery(app, delivery)) return decided('ignore', 'duplicate')
  const vetoed = (await before?.()) ?? null
  if (vetoed !== null) return decided('ignore', vetoed)

  const event: Event = {
    name,
    action: text(payload.action) ?? '',
    payload,
    repo,
    config,
    pr,
    issue,
    sender: text(payload.sender?.login),
    maintainer: context.maintainer,
  }
  const outcome = await rule(event)
  if ('ignore' in outcome) return outcome.issue === undefined ? decided('ignore', outcome.ignore) : decidedOn(outcome.issue, outcome.ignore)
  // Every rule that starts work has checked the config is there.
  if (config === null || repo === null) throw new Failure('no config for a decision that starts work', 1)

  const token = await takeFor(outcome.lock, { app, delivery })
  if (token === null) return decided('ignore', 'locked')
  // The lock is taken first, so a held lock is reported before the attempts
  // and the cap. The delivery is recorded pending before anything is
  // counted, so a failed record counts nothing, and done after. A build
  // reserves its attempt (one check and increment under the attempts
  // file's lock) before the run is counted, so a ticket at its cap counts
  // no run. A call that the attempts or the cap stops, or that fails, gives
  // back what it reserved, forgets the delivery and gives the lock back.
  // When the done record fails, the run stays counted, which errs toward
  // the cap.
  const limit = app === 'reviewer' ? config.app_daily_runs : config.implementer.daily_runs
  const attempt = outcome.attempt
  let reserved = false
  const stop = async (reason: string): Promise<Decision> => {
    if (reserved && attempt !== undefined) {
      reserved = false
      await releaseAttempt(repo, attempt.issue)
    }
    await releaseFor(outcome.lock, token)
    await forgetDelivery(app, delivery)
    return decided('ignore', reason)
  }
  try {
    await recordDelivery(app, delivery, 'pending', outcome.lock, token)
    if (attempt !== undefined) {
      if (!(await reserveAttempt(repo, attempt.issue, attempt.limit))) return await stop('attempts')
      reserved = true
    }
    const counted = await countRun(app, limit)
    if (counted === null) return await stop('cap')
    await recordDelivery(app, delivery, 'done', outcome.lock, token, {
      repo,
      attempt: attempt === undefined ? null : attempt.issue,
      counted_at: counted,
    })
  } catch (error) {
    if (reserved && attempt !== undefined) await releaseAttempt(repo, attempt.issue).catch(() => {})
    await releaseFor(outcome.lock, token)
    // The error that stopped the call is the one to report: when the record
    // itself failed, there may be nothing to forget, or no way to reach it.
    await forgetDelivery(app, delivery).catch(() => {})
    throw error
  }
  return decided(outcome.action, null, token)
}

// `route undo`: the router could not launch the thread a decision started,
// so it gives back what the decision took. It finds the done record that
// holds `token` (a reconcile line has the token but no delivery id), and,
// only while the token still owns the decision's lock: deletes the record,
// so the same delivery is decided again; gives back the build attempt and
// the counted run; then releases the lock. Running it again finds no record
// and changes nothing: it exits 0 either way.
type DeliveryRecord = { state?: unknown; pr?: unknown; issue?: unknown; token?: unknown } & Partial<Taken>

async function findRecord(app: AppName, token: string): Promise<{ file: string; record: DeliveryRecord } | null> {
  const dir = join(stateRoot(), 'deliveries', app)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  for (const name of names) {
    const file = join(dir, name)
    try {
      const record = JSON.parse(await readFile(file, 'utf8')) as DeliveryRecord
      if (record.token === token) return { file, record }
    } catch {
      // A temp file or a record that cannot be read: not this one.
    }
  }
  return null
}

async function undo(argv: string[]): Promise<string> {
  const { values } = parse(argv, { app: { type: 'string' }, token: { type: 'string' } }, usage)
  const app = values.app as AppName
  if (!APPS.includes(app)) throw usage(`--app must be ${APPS.join(' or ')}`)
  const token = values.token
  if (token === undefined || !/^[0-9a-f]{32}$/.test(token)) throw usage('--token must be the lock_token that route printed')

  const found = await findRecord(app, token)
  const pr = whole(found?.record.pr)
  const issue = whole(found?.record.issue)
  if (found === null || (pr === null) === (issue === null)) {
    return `${JSON.stringify({ undone: false, reason: 'no delivery record holds this token' })}\n`
  }
  const lock: Start['lock'] = pr !== null ? { kind: 'pr', number: pr } : { kind: 'issue', number: issue as number }
  const { record } = found
  let gave: { attempt: boolean; run: boolean }
  try {
    gave = await whileHolding(lock.kind === 'pr' ? prLockFile(lock.number) : issueLockFile(lock.number), token, async () => {
      await rm(found.file, { force: true })
      let attempt = false
      if (typeof record.repo === 'string' && typeof record.attempt === 'number') {
        await releaseAttempt(record.repo, record.attempt)
        attempt = true
      }
      const run = typeof record.counted_at === 'string' ? await uncountRun(app, record.counted_at) : false
      return { attempt, run }
    })
  } catch (error) {
    if (error instanceof Failure && /^lost the lock/.test(error.message)) {
      return `${JSON.stringify({ undone: false, reason: 'the token no longer owns the lock' })}\n`
    }
    throw error
  }
  const released = await releaseFor(lock, token)
  return `${JSON.stringify({ undone: true, [lock.kind]: lock.number, ...gave, released })}\n`
}

async function route(argv: string[]): Promise<string> {
  if (argv[0] === 'undo') return undo(argv.slice(1))
  const { values } = parse(
    argv,
    { app: { type: 'string' }, event: { type: 'string' }, delivery: { type: 'string' }, payload: { type: 'string' } },
    usage,
  )
  const app = values.app as AppName
  if (!APPS.includes(app)) throw usage(`--app must be ${APPS.join(' or ')}`)
  const name = values.event
  if (name === undefined || !/^[a-z_]+$/.test(name)) throw usage('--event must be the X-GitHub-Event name, such as pull_request')
  const delivery = values.delivery
  if (delivery === undefined || !/^[A-Za-z0-9-]+$/.test(delivery)) throw usage('--delivery must be the X-GitHub-Delivery id')
  if (values.payload === undefined) throw usage('route needs --payload')

  const payload = await readPayload(values.payload)
  return `${JSON.stringify(await decide(app, name, delivery, payload, liveContext()))}\n`
}

export const main = runMain('route', route)
