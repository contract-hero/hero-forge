// `review.ts post-review` (usage in the table in cli.ts).
// Post one review payload (event, body, inline comments) to a PR through
// `gh api`, at most once per PR, round, kind and commit.
//
// Before posting it checks for this round's review twice: first in the run
// state, then (in case the state lost the record) on GitHub, by a hidden
// marker on the last line of a review by the same poster on the same commit.
// A review that the run state records at another commit, and that GitHub
// now shows on this one, was carried over by a restack. It counts as this
// commit's review only when `stack restack --pr` recorded that restack with
// no content change; otherwise a fresh review posts.
//
// With a run state, the post must be at the run's `head_sha` and `round`,
// and the config and the run state must agree on the reviewer App.
//
// `recheck` and `verdict` posts also run the gate (ledger.ts), record its
// result at the commit, and print it, on a duplicate too. A verdict needs
// the App. An APPROVE needs a passing gate and a PR that is ready for review
// (lfg order: the ready flip first, then the approval); a REQUEST_CHANGES
// goes on a stopped run.
import { readFile } from 'node:fs/promises'
import { Failure, parse, positive, refuse, repoOption, runMain, usageFor } from './cli.ts'
import { loadConfig } from './config.ts'
import {
  appIdentity,
  gh,
  json,
  listInlineComments,
  listLines,
  oneLine,
  postedFindings,
  userIdentity,
  type Identity,
} from './github.ts'
import { gateProblems, loadLedger, loadRecheck } from './ledger.ts'
import { hasOwnMarker, marker, refuseMarkerIn, withMarker } from './marker.ts'
import {
  EVENTS,
  isOneOf,
  KINDS,
  loadRestack,
  loadState,
  saveState,
  usesApp,
  type Event,
  type GateRecord,
  type Kind,
  type ReviewRecord,
  type State,
} from './run-state.ts'
import { refuseSecretsIn } from './secrets.ts'

const SIDES = ['RIGHT', 'LEFT']

type Comment = {
  path: string
  line: number
  side: string
  body: string
  start_line?: number
  start_side?: string
}
type Payload = { event: Event; body: string; comments: Comment[] }

const isPositiveInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0

const usage = usageFor('post-review')

const PAYLOAD_KEYS = ['event', 'body', 'comments']
const COMMENT_KEYS = ['path', 'line', 'side', 'start_line', 'start_side', 'body']

function onlyKeys(value: Record<string, unknown>, allowed: string[], at: string): void {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k))
  refuse(unknown.length === 0, `${at} has unknown keys: ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`)
}

function checkPayload(value: unknown): Payload {
  refuse(typeof value === 'object' && value !== null && !Array.isArray(value), 'payload must be a JSON object')
  const p = value as Record<string, unknown>
  onlyKeys(p, PAYLOAD_KEYS, 'payload')
  refuse(isOneOf(EVENTS, p.event), 'payload.event must be COMMENT, APPROVE or REQUEST_CHANGES')
  refuse(typeof p.body === 'string', 'payload.body must be a string')
  refuse(Array.isArray(p.comments), 'payload.comments must be an array')
  ;(p.comments as unknown[]).forEach((raw, i) => {
    const at = `payload.comments[${i}]`
    refuse(typeof raw === 'object' && raw !== null, `${at} must be an object`)
    const c = raw as Record<string, unknown>
    onlyKeys(c, COMMENT_KEYS, at)
    refuse(typeof c.path === 'string' && c.path !== '', `${at}.path must be a string`)
    refuse(isPositiveInt(c.line), `${at}.line must be a positive whole number`)
    refuse(SIDES.includes(c.side as string), `${at}.side must be RIGHT or LEFT`)
    refuse(typeof c.body === 'string', `${at}.body must be a string`)
    if (c.start_line !== undefined || c.start_side !== undefined) {
      refuse(isPositiveInt(c.start_line), `${at}.start_line must be a positive whole number`)
      refuse((c.start_line as number) < (c.line as number), `${at}.start_line must be less than line`)
      refuse(SIDES.includes(c.start_side as string), `${at}.start_side must be RIGHT or LEFT`)
    }
  })
  return p as Payload
}

// Record the review (once per round, kind and commit, the key of the
// duplicate check) and the gate result (once per round, commit and result) in
// the PR's run state, when there is one. One review id can be on record at
// two commits: GitHub carried it from the old head to the new one.
async function record(state: State | undefined, entry: ReviewRecord | undefined, gate: GateRecord | undefined): Promise<void> {
  if (state === undefined) return
  const fresh = await loadState(state.pr)
  let changed = false
  const same = (r: ReviewRecord) => entry !== undefined && r.round === entry.round && r.kind === entry.kind && r.commit === entry.commit
  if (entry !== undefined && !fresh.reviews.some(same)) {
    fresh.reviews.push(entry)
    changed = true
  }
  const last = gate === undefined ? undefined : fresh.gates.filter((g) => g.commit === gate.commit).at(-1)
  if (gate !== undefined && (last?.round !== gate.round || last.result !== gate.result)) {
    fresh.gates.push(gate)
    changed = true
  }
  if (!changed) return
  fresh.updated_at = new Date().toISOString()
  await saveState(fresh)
}

// The phases a verdict may post at. An APPROVE goes on a PR that is out of
// draft: after the ready flip (or on its re-run), or on a landed stack layer
// whose head moved (implement-spec-stack's landing). A REQUEST_CHANGES goes
// on a run that ran out of rounds.
function verdictPhaseProblem(state: State, event: Event): string | undefined {
  if (event === 'APPROVE') {
    const ok = state.phase === 'ready' || state.phase === 'verdict-posted' || (state.mode === 'layer' && state.phase === 'complete')
    return ok
      ? undefined
      : `an APPROVE goes on a PR that is ready for review, but PR #${state.pr} is at ${state.phase} (${state.mode} mode): flip it to ready first, then approve`
  }
  return state.phase === 'stopped'
    ? undefined
    : `a REQUEST_CHANGES goes on a run that ran out of rounds, but PR #${state.pr} is at ${state.phase}: run next-round first`
}

async function post(argv: string[]): Promise<string> {
  const { values } = parse(
    argv,
    {
      repo: { type: 'string' },
      pr: { type: 'string' },
      commit: { type: 'string' },
      round: { type: 'string' },
      kind: { type: 'string' },
      payload: { type: 'string' },
      config: { type: 'string' },
      ledger: { type: 'string' },
      recheck: { type: 'string' },
    },
    usage,
  )
  const { commit, kind, payload: payloadPath } = values
  const repo = repoOption(values.repo, usage)
  const pr = positive('pr', values.pr, usage)
  if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) throw usage('--commit must be a 40-hex commit SHA')
  const round = positive('round', values.round, usage)
  if (!isOneOf(KINDS, kind)) throw usage('--kind must be review, recheck or verdict')
  if (payloadPath === undefined) throw usage('--payload is required')
  const gated = kind !== 'review'
  if (gated && (values.ledger === undefined || values.recheck === undefined)) {
    throw usage(`--kind ${kind} needs --ledger and --recheck (the gate)`)
  }
  if (!gated && (values.ledger !== undefined || values.recheck !== undefined)) {
    throw usage('--ledger and --recheck go with --kind recheck or verdict only')
  }

  // The pipeline never gets here without a valid config, so any problem is broken (4).
  const loaded = await loadConfig(values.config)
  if (!loaded.ok) throw new Failure(loaded.message, 4)
  const app = loaded.config.app

  let raw: string
  try {
    raw = await readFile(payloadPath, 'utf8')
  } catch (error) {
    throw new Failure(`cannot read payload ${payloadPath}: ${(error as Error).message}`, 1)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Failure(`payload ${payloadPath} is not valid JSON`, 1)
  }
  const payload = checkPayload(parsed)
  refuseMarkerIn([payload.body, ...payload.comments.map((c) => c.body)], `payload ${payloadPath}`)
  // The exact object that is sent, built from the allowed fields only, and
  // scanned for secrets before any gh call.
  const mark = marker({ pr, round, kind })
  const outgoing = {
    event: payload.event,
    body: withMarker(payload.body, mark),
    commit_id: commit,
    comments: payload.comments.map(({ path, line, side, start_line, start_side, body }) =>
      start_line === undefined ? { path, line, side, body } : { path, line, side, start_line, start_side, body }),
  }
  refuseSecretsIn(outgoing, `payload ${payloadPath}`)
  if (kind === 'verdict') refuse(payload.event !== 'COMMENT', '--kind verdict posts APPROVE or REQUEST_CHANGES only')
  else refuse(payload.event === 'COMMENT', `--kind ${kind} posts COMMENT only`)
  // Without the App the review posts as the PR author, who cannot approve or
  // request changes on their own PR.
  refuse(app || kind !== 'verdict', 'APPROVE/REQUEST_CHANGES need the reviewer App: the PR author cannot approve their own PR')

  const ledger = gated ? await loadLedger(values.ledger as string) : []
  const recheck = gated ? await loadRecheck(values.recheck as string) : []

  let state: State | undefined
  try {
    state = await loadState(pr)
  } catch (error) {
    // The gate counts the findings of the reviews the run state records.
    if (gated || !(error instanceof Failure) || error.code !== 3) throw error
  }
  if (state !== undefined) {
    refuse(state.repo === repo, `the run state for PR #${pr} is for ${state.repo}, not ${repo}`)
    refuse(
      commit === state.head_sha,
      `--commit ${commit} is not the head the run pinned (${state.head_sha}): pin it with run-state set head_sha first`,
    )
    refuse(round === state.round, `--round ${round} is not the run's round (${state.round})`)
    refuse(
      app === usesApp(state),
      `the config ${app ? 'enables' : 'does not enable'} the reviewer App, but the run state for PR #${pr} has reviewer_login ${state.reviewer_login}: re-create the run with the reviewer login the config implies`,
    )
    if (kind === 'verdict') {
      const problem = verdictPhaseProblem(state, payload.event)
      refuse(problem === undefined, problem ?? '')
    }
  }

  let gate: { gate: 'pass' | 'fail'; problems: string[] } | undefined
  if (gated) {
    const reviewIds = (state as State).reviews.filter((r) => r.kind === 'review').map((r) => r.id)
    const posted = postedFindings(await listInlineComments(repo, pr), reviewIds)
    const problems = gateProblems(ledger, recheck, posted)
    gate = { gate: problems.length === 0 ? 'pass' : 'fail', problems }
    refuse(
      payload.event !== 'APPROVE' || problems.length === 0,
      `the gate fails, so the PR cannot be approved: ${problems.join('; ')}`,
    )
  }
  const gateRecord: GateRecord | undefined = gate === undefined ? undefined : { round, commit, result: gate.gate }

  // Primary resume check: the run state already records this round's review.
  const recorded = state?.reviews.find((r) => r.round === round && r.kind === kind && r.commit === commit)
  if (recorded !== undefined) {
    await record(state, undefined, gateRecord)
    return `${JSON.stringify({ posted: false, duplicate: true, id: recorded.id, ...gate })}\n`
  }

  // With the App, a token that cannot be minted stops here (exit 4), before
  // any gh call: never post as the user instead.
  const poster = app ? await appIdentity(repo) : await userIdentity()
  if (state !== undefined && app) {
    refuse(
      poster.login === state.reviewer_login,
      `the reviewer App posts as ${poster.login}, but the run state for PR #${pr} expects ${state.reviewer_login}`,
    )
  }
  const reviewsPath = `repos/${repo}/pulls/${pr}/reviews`
  const entry = (id: number): ReviewRecord => ({ round, kind, id, commit, as: poster.as, event: payload.event })
  const reviews = await listReviews(reviewsPath, pr, poster)
  const existing = findOwnReview(reviews, mark, poster, commit)
  if (existing !== undefined) {
    // The run state records this review at another commit: GitHub carried it
    // to `commit`. It counts only after a restack with no content change;
    // otherwise the new head gets a fresh review. After two carries (A to B,
    // then B to C) the review is on record at A and B: the latest record, B,
    // is where the last restack started.
    const earlier = state?.reviews
      .filter((r) => r.id === existing.id && r.round === round && r.kind === kind && r.commit !== commit)
      .at(-1)
    if (earlier === undefined) {
      await record(state, entry(existing.id), gateRecord)
      return `${JSON.stringify({ posted: false, duplicate: true, id: existing.id, ...gate })}\n`
    }
    if (await carries(pr, earlier.commit, commit, existing, reviews, poster, kind, payload.event)) {
      await record(state, entry(existing.id), gateRecord)
      return `${JSON.stringify({ posted: false, duplicate: true, id: existing.id, carried_from: earlier.commit, ...gate })}\n`
    }
  }

  const posted = await gh(['api', '-X', 'POST', reviewsPath, '--input', '-'], JSON.stringify(outgoing), poster.token)
  refuse(posted.code === 0, `GitHub rejected the review: ${oneLine(posted.stderr || posted.stdout)}`)
  const { id } = json<{ id: number }>(posted.stdout, 'post review')
  await record(state, entry(id), gateRecord)
  return `${JSON.stringify({ posted: true, id, as: poster.as, event: payload.event, round, kind, ...gate })}\n`
}

type GitHubReview = { id: number; state: string; body: string | null; commit_id: string | null; login: string | null }

// The PR's reviews, oldest first, as GitHub lists them.
function listReviews(reviewsPath: string, pr: number, poster: Identity): Promise<GitHubReview[]> {
  return listLines<GitHubReview>(
    ['api', '--paginate', '--jq', '.[] | {id, state, body, commit_id, login: .user.login}', reviewsPath],
    `the reviews of PR #${pr}`,
    poster.token,
  )
}

// Fallback resume check, for a run state that lost its record: a review on
// the PR whose last line is the marker, posted by the poster's login (the
// App's `<slug>[bot]` when it posts as the App), on `commit`. A marker in
// anyone else's review, on another commit, or anywhere but the last line,
// does not count, so nobody can suppress the pipeline's review by copying it.
function findOwnReview(reviews: GitHubReview[], mark: string, poster: Identity, commit: string): GitHubReview | undefined {
  return reviews.filter((r) => r.login === poster.login && r.commit_id === commit && hasOwnMarker(r.body, mark)).at(-1)
}

// The state GitHub gives a review of each event.
const STATE_OF: Record<Event, string> = { COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' }

// Whether the review GitHub carried from `from` to `to` counts at `to`. The
// layer's run dir must hold the record of `stack restack --pr` that moved the
// layer from `from` to `to` with no content change. On GitHub the review must
// still be the event this post would send, and a verdict must be the poster's
// latest review that is not a COMMENT (nor PENDING), as the merge gate reads it.
async function carries(
  pr: number,
  from: string,
  to: string,
  review: GitHubReview,
  reviews: GitHubReview[],
  poster: Identity,
  kind: Kind,
  event: Event,
): Promise<boolean> {
  const restack = await loadRestack(pr)
  if (restack === undefined || restack.old_tip !== from || restack.new_tip !== to || restack.same !== true) return false
  if (review.state !== STATE_OF[event]) return false
  if (kind !== 'verdict') return true
  const latest = reviews.filter((r) => r.login === poster.login && r.state !== 'COMMENTED' && r.state !== 'PENDING').at(-1)
  return latest?.id === review.id
}

export const main = runMain('post-review', post)
