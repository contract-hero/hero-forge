// `review.ts post-review --repo O/R --pr N --commit <sha> --round R
//   --kind review|recheck|verdict --payload <file> [--config <path>]
//   [--ledger <findings.json> --recheck <recheck-rN.json>]`
// Post one review payload (event, body, inline comments) to a PR through
// `gh api`, at most once per PR, round and kind.
//
// Before posting it checks for this round's review twice: first in the run
// state, then (in case the state lost the record) on GitHub, by a hidden
// marker in the body of a review by the same poster on the same commit.
//
// `recheck` and `verdict` posts also run the gate (ledger.ts) and print its
// result, on a duplicate too. An APPROVE on a failing gate is refused.
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { loadConfig } from './config.ts'
import { gh, json, listInlineComments, listLines, oneLine, postedFindings, refuse, userIdentity } from './github.ts'
import { gateProblems, loadLedger, loadRecheck } from './ledger.ts'
import { Failure, loadState, saveState, type State } from './run-state.ts'

const PREFIX = 'review.ts post-review: '
const EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']
const SIDES = ['RIGHT', 'LEFT']
const KINDS = ['review', 'recheck', 'verdict']

const USAGE = `usage: review.ts post-review --repo O/R --pr N --commit <sha> --round R
                             --kind review|recheck|verdict --payload <file> [--config <path>]
                             [--ledger <findings.json> --recheck <recheck-rN.json>]   (recheck, verdict)`

type Comment = {
  path: string
  line: number
  side: string
  body: string
  start_line?: number
  start_side?: string
}
type Payload = { event: string; body: string; comments: Comment[] }

const isPositiveInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0

function usage(message: string): Failure {
  return new Failure(`${message}\n${USAGE}`, 2)
}

function checkPayload(value: unknown): Payload {
  refuse(typeof value === 'object' && value !== null && !Array.isArray(value), 'payload must be a JSON object')
  const p = value as Record<string, unknown>
  refuse(EVENTS.includes(p.event as string), 'payload.event must be COMMENT, APPROVE or REQUEST_CHANGES')
  refuse(typeof p.body === 'string', 'payload.body must be a string')
  refuse(Array.isArray(p.comments), 'payload.comments must be an array')
  ;(p.comments as unknown[]).forEach((raw, i) => {
    const at = `payload.comments[${i}]`
    refuse(typeof raw === 'object' && raw !== null, `${at} must be an object`)
    const c = raw as Record<string, unknown>
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

// Append a review record to the PR's run state, when there is one.
async function record(state: State | undefined, entry: State['reviews'][number]): Promise<void> {
  if (state === undefined) return
  const fresh = await loadState(state.pr)
  if (fresh.reviews.some((r) => r.id === entry.id)) return
  fresh.reviews.push(entry)
  fresh.updated_at = new Date().toISOString()
  await saveState(fresh)
}

async function post(argv: string[]): Promise<string> {
  let values
  try {
    values = parseArgs({
      args: argv,
      strict: true,
      options: {
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
    }).values
  } catch (error) {
    throw usage((error as Error).message)
  }
  const { repo, pr: prText, commit, round: roundText, kind, payload: payloadPath } = values
  if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw usage('--repo must be OWNER/REPO')
  if (prText === undefined || !/^[0-9]+$/.test(prText) || Number(prText) < 1) throw usage('--pr must be a positive whole number')
  if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) throw usage('--commit must be a 40-hex commit SHA')
  if (roundText === undefined || !/^[0-9]+$/.test(roundText) || Number(roundText) < 1) {
    throw usage('--round must be a positive whole number')
  }
  if (kind === undefined || !KINDS.includes(kind)) throw usage('--kind must be review, recheck or verdict')
  if (payloadPath === undefined) throw usage('--payload is required')
  const gated = kind !== 'review'
  if (gated && (values.ledger === undefined || values.recheck === undefined)) {
    throw usage(`--kind ${kind} needs --ledger and --recheck (the gate)`)
  }
  if (!gated && (values.ledger !== undefined || values.recheck !== undefined)) {
    throw usage('--ledger and --recheck go with --kind recheck or verdict only')
  }
  const pr = Number(prText)
  const round = Number(roundText)

  // The pipeline never gets here without a valid config, so any problem is broken (4).
  const loaded = await loadConfig(values.config)
  if (!loaded.ok) throw new Failure(loaded.message, 4)
  if (loaded.config.app) {
    throw new Failure('App identity is not built yet: remove "app: enabled" from the config to post as the user', 4)
  }

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
  if (kind === 'verdict') refuse(payload.event !== 'COMMENT', '--kind verdict posts APPROVE or REQUEST_CHANGES only')
  else refuse(payload.event === 'COMMENT', `--kind ${kind} posts COMMENT only`)

  const ledger = gated ? await loadLedger(values.ledger as string) : []
  const recheck = gated ? await loadRecheck(values.recheck as string) : []

  let state: State | undefined
  try {
    state = await loadState(pr)
  } catch (error) {
    // The gate counts the findings of the reviews the run state records.
    if (gated || !(error instanceof Failure) || error.code !== 3) throw error
  }

  let gate: { gate: string; problems: string[] } | undefined
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
  if (kind === 'verdict') {
    throw new Failure('APPROVE/REQUEST_CHANGES need the reviewer App: the PR author cannot approve their own PR', 1)
  }

  // Primary resume check: the run state already records this round's review.
  const recorded = state?.reviews.find((r) => r.round === round && r.kind === kind && r.commit === commit)
  if (recorded !== undefined) return `${JSON.stringify({ posted: false, duplicate: true, id: recorded.id, ...gate })}\n`

  const poster = await userIdentity()
  const marker = `<!-- hero-pocock:review-pipeline pr=${pr} round=${round} kind=${kind} -->`
  const reviewsPath = `repos/${repo}/pulls/${pr}/reviews`
  const existing = await findOwnReview(reviewsPath, pr, marker, poster.login, commit)
  if (existing !== undefined) {
    await record(state, { round, kind, id: existing, commit, as: poster.as })
    return `${JSON.stringify({ posted: false, duplicate: true, id: existing, ...gate })}\n`
  }

  const body = { ...payload, body: `${payload.body}\n\n${marker}`, commit_id: commit }
  const posted = await gh(['api', '-X', 'POST', reviewsPath, '--input', '-'], JSON.stringify(body))
  refuse(posted.code === 0, `GitHub rejected the review: ${oneLine(posted.stderr || posted.stdout)}`)
  const { id } = json<{ id: number }>(posted.stdout, 'post review')
  await record(state, { round, kind, id, commit, as: poster.as })
  return `${JSON.stringify({ posted: true, id, as: poster.as, event: payload.event, round, kind, ...gate })}\n`
}

// Fallback resume check, for a run state that lost its record: a review on
// the PR that carries the marker, was posted by `login`, and is on `commit`.
// A marker in anyone else's review, or on another commit, does not count, so
// a third party cannot suppress the pipeline's review by copying the marker.
async function findOwnReview(
  reviewsPath: string,
  pr: number,
  marker: string,
  login: string,
  commit: string,
): Promise<number | undefined> {
  const reviews = await listLines<{ id: number; body: string | null; commit_id: string | null; login: string | null }>(
    ['api', '--paginate', '--jq', '.[] | {id, body, commit_id, login: .user.login}', reviewsPath],
    `the reviews of PR #${pr}`,
  )
  return reviews.find((r) => r.login === login && r.commit_id === commit && (r.body ?? '').includes(marker))?.id
}

export async function main(argv: string[]): Promise<number> {
  try {
    process.stdout.write(await post(argv))
    return 0
  } catch (error) {
    if (!(error instanceof Failure)) throw error
    process.stderr.write(`${PREFIX}${error.message}\n`)
    return error.code
  }
}
