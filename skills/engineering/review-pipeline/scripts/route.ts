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
//   6. a run state that is not terminal             ignore, locked
//   7. review
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
//   3. not labeled                                  ignore, action:<name>
//   4. no docs/agents/review.md                     ignore, no-config
//   5. no implementer.app: enabled                  ignore, disabled
//   6. a label other than ready-for-agent           ignore, label:<name>
//   7. the issue is a PR                            ignore, pull-request
//   8. the sender is not the maintainer             ignore, sender
//   9. the issue has a parent issue                 ignore, has-parent
//  10. the ticket's builds reached implementer.attempts
//                                                   ignore, attempts
//  11. build-spec when it has sub-issues, else build-ticket
// --app implementer, an issue_comment event:
//   3. not created                                  ignore, action:<name>
//   4, 5 as above
//   6. sender contract-reviewer[bot]: not on a PR   ignore, not-pull-request
//      the last line is not a review-posted or recheck-failed hand-off for
//      this PR                                      ignore, marker
//      the PR is not contract-implementer[bot]'s    ignore, author
//      the run state phase is not review-posted     ignore, phase
//      adjudicate
//      sender the maintainer: no needs-info label   ignore, not-paused
//      no pause record for the issue or PR          ignore, no-pause-record
//      resume
//      anyone else                                  ignore, sender
// --app implementer, any other event                ignore, event:<name>
//
// Then, for every decision that starts work: a held lock (per PR, or per
// issue for a build or a resume on an issue) is ignore, locked; the App's
// daily run cap is ignore, cap. Else take the lock, record the delivery,
// count the run (and, for a build, the attempt), and print the decision.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { APPS, type AppName } from './app-token.ts'
import { attemptsOf, countAttempt, countRun } from './cap.ts'
import { Failure, isRepo, parse, runMain, usageFor } from './cli.ts'
import { resolveConfigText, type ResolvedConfig } from './config.ts'
import { gh, json, oneLine, userIdentity } from './github.ts'
import { parseHandoff, type HandoffKind } from './handoff.ts'
import { releaseIssueLock, releasePrLock, takeIssueLock, takePrLock } from './lock.ts'
import { readPause } from './pause.ts'
import { loadState, stateRoot, TERMINAL, type Phase } from './run-state.ts'

const usage = usageFor('route')

// The two Apps' bot logins.
const IMPLEMENTER_BOT = 'contract-implementer[bot]'
const REVIEWER_BOT = 'contract-reviewer[bot]'

// The label that asks the Implementer to build, and the one a paused run carries.
const BUILD_LABEL = 'ready-for-agent'
const PAUSED_LABEL = 'needs-info'

// GitHub logins are case-insensitive.
const sameLogin = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase()

// Whether `action` on a PR by `author` starts a review. An author who is not
// the bot gets the maintainer's actions here: the author rule then ignores
// anyone who is not the maintainer, so this needs no maintainer lookup.
function triggers(action: string, author: string | undefined, draft: boolean): boolean {
  if (sameLogin(author, IMPLEMENTER_BOT)) return action === 'opened' || action === 'reopened'
  return action === 'ready_for_review' || ((action === 'opened' || action === 'reopened') && !draft)
}

type Action = 'review' | 'recheck' | 'build-ticket' | 'build-spec' | 'adjudicate' | 'resume' | 'ignore'

// `pr` is set when the delivery is about a PR, `issue` when it is about an
// issue that is not a PR (a label, or a comment on an issue).
type Decision = { action: Action; repo: string | null; pr: number | null; issue: number | null; reason: string | null }

// What a rule found: an ignore with its reason, or work to start. Work names
// the lock it takes and, for a build, the ticket whose attempt it counts.
type Start = { action: Exclude<Action, 'ignore'>; lock: { kind: 'pr' | 'issue'; number: number }; attempt?: number }
type Outcome = { ignore: string } | Start

const why = (reason: string): Outcome => ({ ignore: reason })

// The fields of a webhook payload that route reads. GitHub sends them; route
// trusts that the payload came from GitHub (the router checks the signature).
type Payload = {
  action?: unknown
  repository?: { full_name?: unknown; default_branch?: unknown }
  sender?: { login?: unknown }
  pull_request?: { number?: unknown; draft?: unknown; user?: { login?: unknown } }
  issue?: { number?: unknown; pull_request?: unknown; user?: { login?: unknown }; labels?: unknown }
  label?: { name?: unknown }
  comment?: { body?: unknown }
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

// Whether issue `issue` has a parent issue, and how many sub-issues it has,
// as GitHub says now (not as the payload said when the label landed).
async function relations(repo: string, issue: number): Promise<{ parent: boolean; subIssues: number }> {
  const got = await gh(['api', `repos/${repo}/issues/${issue}`, '--jq', '{parent_issue_url, sub_issues_summary}'])
  if (got.code !== 0) throw new Failure(`cannot read issue #${issue} of ${repo}: ${oneLine(got.stderr)}`, 1)
  const found = json<{ parent_issue_url?: unknown; sub_issues_summary?: { total?: unknown } | null }>(got.stdout, `issue #${issue}`)
  const total = found.sub_issues_summary?.total
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
    throw new Failure(`GitHub sent no sub-issue count for issue #${issue} of ${repo}`, 1)
  }
  return { parent: typeof found.parent_issue_url === 'string', subIssues: total }
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
async function doneDelivery(app: AppName, delivery: string): Promise<boolean> {
  try {
    return (JSON.parse(await readFile(deliveryFile(app, delivery), 'utf8')) as { state?: unknown }).state === 'done'
  } catch {
    return false
  }
}

// Write the record whole: a temp file in the same dir, then rename.
async function recordDelivery(app: AppName, delivery: string, state: DeliveryState, lock: Start['lock'], token: string): Promise<void> {
  const file = deliveryFile(app, delivery)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${randomBytes(6).toString('hex')}`
  try {
    await writeFile(tmp, `${JSON.stringify({ state, [lock.kind]: lock.number, token })}\n`, { mode: 0o600 })
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
}

async function forgetDelivery(app: AppName, delivery: string): Promise<void> {
  await rm(deliveryFile(app, delivery), { force: true })
}

// The run state phase of PR `pr`, or null when it has no run state. A
// corrupt state file exits 4.
async function phaseOf(pr: number): Promise<Phase | null> {
  try {
    return (await loadState(pr)).phase
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
  const phase = await phaseOf(e.pr)
  if (phase !== null && !TERMINAL.includes(phase)) return why('locked')
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
  if (e.action !== (e.name === 'issues' ? 'labeled' : 'created')) return why(`action:${e.action}`)
  if (e.config === null) return why('no-config')
  if (!e.config.implementer.app) return why('disabled')
  return e.name === 'issues' ? buildRule(e, e.config) : commentRule(e)
}

async function buildRule(e: Event, config: ResolvedConfig): Promise<Outcome> {
  const label = text(e.payload.label?.name) ?? ''
  if (label !== BUILD_LABEL) return why(`label:${label}`)
  if (e.pr !== null) return why('pull-request')
  if (e.repo === null || e.issue === null) throw new Failure('the issues payload has no repository.full_name or issue.number', 1)
  if (!sameLogin(e.sender, await e.maintainer())) return why('sender')
  const { parent, subIssues } = await relations(e.repo, e.issue)
  if (parent) return why('has-parent')
  if ((await attemptsOf(e.repo, e.issue)) >= config.implementer.attempts) return why('attempts')
  return { action: subIssues > 0 ? 'build-spec' : 'build-ticket', lock: { kind: 'issue', number: e.issue }, attempt: e.issue }
}

async function commentRule(e: Event): Promise<Outcome> {
  if (sameLogin(e.sender, REVIEWER_BOT)) {
    if (e.pr === null) return why('not-pull-request')
    const handoff = parseHandoff(text(e.payload.comment?.body))
    if (handoff === null || !ADJUDICATE_ON.includes(handoff.kind) || handoff.pr !== e.pr) return why('marker')
    if (!sameLogin(text(e.payload.issue?.user?.login), IMPLEMENTER_BOT)) return why('author')
    if ((await phaseOf(e.pr)) !== 'review-posted') return why('phase')
    return { action: 'adjudicate', lock: { kind: 'pr', number: e.pr } }
  }
  if (e.sender === undefined || !sameLogin(e.sender, await e.maintainer())) return why('sender')
  const labels = Array.isArray(e.payload.issue?.labels) ? (e.payload.issue.labels as { name?: unknown }[]) : []
  if (!labels.some((l) => l?.name === PAUSED_LABEL)) return why('not-paused')
  const subject = e.pr !== null ? { kind: 'pr' as const, number: e.pr } : e.issue !== null ? { kind: 'issue' as const, number: e.issue } : null
  if (subject === null) throw new Failure('the issue_comment payload has no issue.number', 1)
  const record = await readPause(subject)
  if (record === null || record.repo !== e.repo) return why('no-pause-record')
  return { action: 'resume', lock: subject }
}

function takeFor(lock: Start['lock'], holder: Record<string, unknown>): Promise<string | null> {
  return lock.kind === 'pr' ? takePrLock(lock.number, holder) : takeIssueLock(lock.number, holder)
}

function releaseFor(lock: Start['lock'], token: string): Promise<boolean> {
  return lock.kind === 'pr' ? releasePrLock(lock.number, token) : releaseIssueLock(lock.number, token)
}

async function route(argv: string[]): Promise<string> {
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
  const full = payload.repository?.full_name
  const repo = isRepo(full) ? full : null
  // A comment or a label on a PR comes as an issue event with issue.pull_request set.
  const issueNumber = whole(payload.issue?.number)
  const onPr = payload.issue !== undefined && payload.issue.pull_request !== undefined && payload.issue.pull_request !== null
  const pr = whole(payload.pull_request?.number) ?? (onPr ? issueNumber : null)
  const issue = onPr || payload.pull_request !== undefined ? null : issueNumber
  const decide = (action: Action, reason: string | null): string =>
    `${JSON.stringify({ action, repo, pr, issue, reason } satisfies Decision)}\n`

  const branch = payload.repository?.default_branch
  const config = repo === null ? null : await remoteConfig(repo, typeof branch === 'string' ? branch : undefined)

  if (config?.paused === true) return decide('ignore', 'paused')
  if (await doneDelivery(app, delivery)) return decide('ignore', 'duplicate')

  // The maintainer is looked up once, and only when a rule needs it.
  let maintainer: Promise<string> | undefined
  const event: Event = {
    name,
    action: text(payload.action) ?? '',
    payload,
    repo,
    config,
    pr,
    issue,
    sender: text(payload.sender?.login),
    maintainer: () => (maintainer ??= userIdentity().then((u) => u.login)),
  }
  const outcome = await (app === 'reviewer' ? reviewerRule(event) : implementerRule(event))
  if ('ignore' in outcome) return decide('ignore', outcome.ignore)
  // Every rule that starts work has checked the config is there.
  if (config === null || repo === null) throw new Failure('no config for a decision that starts work', 1)

  const token = await takeFor(outcome.lock, { app, delivery })
  if (token === null) return decide('ignore', 'locked')
  // The lock is taken first, so a held lock is reported before the cap. The
  // delivery is recorded pending before the run is counted, so a failed
  // record counts nothing, and done after the run (and, for a build, the
  // attempt) is counted. A call that the cap stops, or that fails, forgets
  // the delivery and gives the lock back. When the attempt count fails, the
  // run stays counted, which errs toward the cap.
  const limit = app === 'reviewer' ? config.app_daily_runs : config.implementer.daily_runs
  try {
    await recordDelivery(app, delivery, 'pending', outcome.lock, token)
    if (!(await countRun(app, limit))) {
      await releaseFor(outcome.lock, token)
      await forgetDelivery(app, delivery)
      return decide('ignore', 'cap')
    }
    if (outcome.attempt !== undefined) await countAttempt(repo, outcome.attempt)
    await recordDelivery(app, delivery, 'done', outcome.lock, token)
  } catch (error) {
    await releaseFor(outcome.lock, token)
    // The error that stopped the call is the one to report: when the record
    // itself failed, there may be nothing to forget, or no way to reach it.
    await forgetDelivery(app, delivery).catch(() => {})
    throw error
  }
  return decide(outcome.action, null)
}

export const main = runMain('route', route)
