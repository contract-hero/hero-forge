// `review.ts post-review --repo O/R --pr N --commit <sha> --round R
//   --kind review|recheck|verdict --payload <file> [--config <path>]`
// Post one review payload (event, body, inline comments) to a PR through
// `gh api`, at most once per PR, round and kind.
//
// The body gets a hidden marker. Before posting, the PR's reviews are listed:
// a review that already carries the marker is reported as a duplicate and
// not posted again, even when the run state lost the record of it.
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { loadConfig } from './config.ts'
import { Failure, loadState, saveState, type State } from './run-state.ts'

const PREFIX = 'review.ts post-review: '
const EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']
const SIDES = ['RIGHT', 'LEFT']
const KINDS = ['review', 'recheck', 'verdict']

const USAGE = `usage: review.ts post-review --repo O/R --pr N --commit <sha> --round R
                             --kind review|recheck|verdict --payload <file> [--config <path>]`

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

function refuse(ok: boolean, message: string): void {
  if (!ok) throw new Failure(message, 1)
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

// Run `gh` with `input` on stdin (closed either way, so the call returns).
function gh(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

function json<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Failure(`unexpected output from gh (${what}): ${oneLine(text)}`, 1)
  }
}

function oneLine(text: string): string {
  return text.trim().split('\n').filter((l) => l.trim() !== '').join(' ') || 'no output'
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
  if (kind === 'verdict') {
    refuse(payload.event !== 'COMMENT', '--kind verdict posts APPROVE or REQUEST_CHANGES only')
    throw new Failure('APPROVE/REQUEST_CHANGES need the reviewer App: the PR author cannot approve their own PR', 1)
  }
  refuse(payload.event === 'COMMENT', `--kind ${kind} posts COMMENT only`)

  let state: State | undefined
  try {
    state = await loadState(pr)
  } catch (error) {
    if (!(error instanceof Failure) || error.code !== 3) throw error
  }

  const marker = `<!-- hero-pocock:review-pipeline pr=${pr} round=${round} kind=${kind} -->`
  const reviewsPath = `repos/${repo}/pulls/${pr}/reviews`
  const listed = await gh(['api', '--paginate', '--jq', '.[] | {id, body}', reviewsPath])
  refuse(listed.code === 0, `cannot list the reviews of PR #${pr}: ${oneLine(listed.stderr)}`)
  for (const line of listed.stdout.split('\n')) {
    if (line.trim() === '') continue
    const existing = json<{ id: number; body: string | null }>(line, 'list reviews')
    if ((existing.body ?? '').includes(marker)) {
      await record(state, { round, kind, id: existing.id, commit, as: 'user' })
      return `${JSON.stringify({ posted: false, duplicate: true, id: existing.id })}\n`
    }
  }

  const body = { ...payload, body: `${payload.body}\n\n${marker}`, commit_id: commit }
  const posted = await gh(['api', '-X', 'POST', reviewsPath, '--input', '-'], JSON.stringify(body))
  refuse(posted.code === 0, `GitHub rejected the review: ${oneLine(posted.stderr || posted.stdout)}`)
  const { id } = json<{ id: number }>(posted.stdout, 'post review')
  await record(state, { round, kind, id, commit, as: 'user' })
  return `${JSON.stringify({ posted: true, id, as: 'user', event: payload.event, round, kind })}\n`
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
