// `review.ts reply --repo O/R --pr N --round R --ledger <findings.json>
//   [--recheck <recheck-r(R-1).json>]`
// Post the coding agent's Adjudication on the PR: one reply per inline
// finding in its own thread (`ACCEPT: <reason>` or `REFUTE: <reason>`), and
// one PR comment with every answered finding, walkthrough items included.
//
// Round 1 answers the whole ledger. A later round passes the previous
// round's re-check and answers only the entries that re-check did not close.
// Each post carries a hidden marker, so a re-run skips what is already on the
// PR (counting only posts by the same gh user). Replies always post as the
// user: the PR author answers the review.
import { parseArgs } from 'node:util'
import { gh, json, listInlineComments, listLines, oneLine, postedFindings, refuse, userIdentity } from './github.ts'
import { CLOSED, DECISIONS, loadLedger, loadRecheck, type LedgerEntry } from './ledger.ts'
import { Failure, loadState } from './run-state.ts'
import { refuseSecrets } from './secrets.ts'

const PREFIX = 'review.ts reply: '
const USAGE = `usage: review.ts reply --repo O/R --pr N --round R --ledger <findings.json>
                       [--recheck <recheck-r(R-1).json>]   (round 2 and later)`

function usage(message: string): Failure {
  return new Failure(`${message}\n${USAGE}`, 2)
}

const cell = (text: string) => text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')

// The answer posted in a finding's thread.
const replyBody = (entry: LedgerEntry, marker: string) => `${entry.decision}: ${entry.reason}\n\n${marker}`

function summary(round: number, targets: LedgerEntry[], marker: string): string {
  return [
    `## Adjudication: round ${round}`,
    '',
    '| ID | Where | Decision | Reason |',
    '| --- | --- | --- | --- |',
    ...targets.map((e) => `| ${e.id} | ${cell(typeof e.where === 'string' ? e.where : '')} | ${e.decision} | ${cell(e.reason)} |`),
    '',
    'Each inline finding also has this answer in its thread.',
    '',
    marker,
  ].join('\n')
}

async function reply(argv: string[]): Promise<string> {
  let values
  try {
    values = parseArgs({
      args: argv,
      strict: true,
      options: {
        repo: { type: 'string' },
        pr: { type: 'string' },
        round: { type: 'string' },
        ledger: { type: 'string' },
        recheck: { type: 'string' },
      },
    }).values
  } catch (error) {
    throw usage((error as Error).message)
  }
  const { repo, pr: prText, round: roundText, ledger: ledgerPath } = values
  if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw usage('--repo must be OWNER/REPO')
  if (prText === undefined || !/^[0-9]+$/.test(prText) || Number(prText) < 1) throw usage('--pr must be a positive whole number')
  if (roundText === undefined || !/^[0-9]+$/.test(roundText) || Number(roundText) < 1) {
    throw usage('--round must be a positive whole number')
  }
  if (ledgerPath === undefined) throw usage('--ledger is required')
  const pr = Number(prText)
  const round = Number(roundText)

  const ledger = await loadLedger(ledgerPath)
  const closed = new Set(
    values.recheck === undefined
      ? []
      : (await loadRecheck(values.recheck)).filter((i) => CLOSED.includes(i.status)).map((i) => i.id),
  )
  const targets = ledger.filter((e) => !closed.has(e.id))
  const undecided = targets.filter((e) => !DECISIONS.includes(e.decision) || e.reason.trim() === '')
  refuse(
    undecided.length === 0,
    `every finding needs a decision (ACCEPT or REFUTE) and a reason first: ${undecided.map((e) => e.id).join(', ')}`,
  )
  refuseSecrets(
    [...targets.flatMap((e) => [replyBody(e, ''), e.id, String(e.where ?? ''), e.reason]), summary(round, targets, '')],
    `ledger ${ledgerPath}`,
  )

  const state = await loadState(pr)
  const me = await userIdentity()
  const comments = await listInlineComments(repo, pr)
  const reviewIds = state.reviews.filter((r) => r.kind === 'review').map((r) => r.id)
  const posted = postedFindings(comments, reviewIds)
  const ids = new Set(ledger.map((e) => e.id))
  for (const p of posted) {
    refuse(p.finding !== null, `inline comment ${p.comment} starts with no **F<n>** finding id`)
    refuse(
      ids.has(p.finding as string),
      `${p.finding} is posted inline (comment ${p.comment}) but is not in the ledger: add its entry, then decide it`,
    )
  }

  const replied: string[] = []
  const skipped: string[] = []
  const walkthrough: string[] = []
  for (const entry of targets) {
    const threads = posted.filter((p) => p.finding === entry.id).map((p) => p.comment)
    if (threads.length === 0) {
      walkthrough.push(entry.id)
      continue
    }
    const marker = `<!-- hero-pocock:review-pipeline pr=${pr} round=${round} kind=reply id=${entry.id} -->`
    let postedAny = false
    for (const thread of threads) {
      const done = comments.some((c) => c.in_reply_to_id === thread && c.login === me.login && (c.body ?? '').includes(marker))
      if (done) continue
      const body = replyBody(entry, marker)
      const result = await gh(
        ['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/comments/${thread}/replies`, '--input', '-'],
        JSON.stringify({ body }),
      )
      refuse(result.code === 0, `GitHub rejected the reply to ${entry.id} (comment ${thread}): ${oneLine(result.stderr || result.stdout)}`)
      postedAny = true
    }
    ;(postedAny ? replied : skipped).push(entry.id)
  }

  let comment: { id: number; posted: boolean } | null = null
  if (targets.length > 0) {
    const marker = `<!-- hero-pocock:review-pipeline pr=${pr} round=${round} kind=adjudication -->`
    const existing = (
      await listLines<{ id: number; body: string | null; login: string | null }>(
        ['api', '--paginate', '--jq', '.[] | {id, body, login: .user.login}', `repos/${repo}/issues/${pr}/comments`],
        `the comments of PR #${pr}`,
      )
    ).find((c) => c.login === me.login && (c.body ?? '').includes(marker))
    if (existing !== undefined) {
      comment = { id: existing.id, posted: false }
    } else {
      const result = await gh(
        ['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '-'],
        JSON.stringify({ body: summary(round, targets, marker) }),
      )
      refuse(result.code === 0, `GitHub rejected the adjudication comment: ${oneLine(result.stderr || result.stdout)}`)
      comment = { id: json<{ id: number }>(result.stdout, 'post comment').id, posted: true }
    }
  }
  return `${JSON.stringify({ round, replied, skipped, walkthrough, comment })}\n`
}

export async function main(argv: string[]): Promise<number> {
  try {
    process.stdout.write(await reply(argv))
    return 0
  } catch (error) {
    if (!(error instanceof Failure)) throw error
    process.stderr.write(`${PREFIX}${error.message}\n`)
    return error.code
  }
}
