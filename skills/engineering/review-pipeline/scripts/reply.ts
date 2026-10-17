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
import { parse, positive, refuse, repoOption, runMain, usageFor } from './cli.ts'
import { gh, json, listInlineComments, listLines, oneLine, postedFindings, userIdentity } from './github.ts'
import { CLOSED, DECISIONS, loadLedger, loadRecheck, type LedgerEntry } from './ledger.ts'
import { loadState } from './run-state.ts'
import { refuseSecretsIn } from './secrets.ts'

const USAGE = `usage: review.ts reply --repo O/R --pr N --round R --ledger <findings.json>
                       [--recheck <recheck-r(R-1).json>]   (round 2 and later)`

const usage = usageFor(USAGE)

const cell = (text: string) => text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')

const replyMarker = (pr: number, round: number, id: string) => `<!-- hero-pocock:review-pipeline pr=${pr} round=${round} kind=reply id=${id} -->`
const commentMarker = (pr: number, round: number) => `<!-- hero-pocock:review-pipeline pr=${pr} round=${round} kind=adjudication -->`
// The exact objects posted: a finding's thread reply, and the PR comment.
const replyPost = (pr: number, round: number, entry: LedgerEntry) => ({
  body: `${entry.decision}: ${entry.reason}\n\n${replyMarker(pr, round, entry.id)}`,
})

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
  const { values } = parse(
    argv,
    {
      repo: { type: 'string' },
      pr: { type: 'string' },
      round: { type: 'string' },
      ledger: { type: 'string' },
      recheck: { type: 'string' },
    },
    usage,
  )
  const repo = repoOption(values.repo, usage)
  const pr = positive('pr', values.pr, usage)
  const round = positive('round', values.round, usage)
  const ledgerPath = values.ledger
  if (ledgerPath === undefined) throw usage('--ledger is required')
  // Without the last re-check a later round would answer the whole ledger
  // again, as duplicates of round 1's answers.
  if (round > 1 && values.recheck === undefined) {
    throw usage(`--round ${round} needs --recheck <recheck-r${round - 1}.json>: a later round answers only what the last re-check left open`)
  }
  if (round === 1 && values.recheck !== undefined) throw usage('--recheck goes with round 2 and later (round 1 answers the whole ledger)')

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
  const commentPost = { body: summary(round, targets, commentMarker(pr, round)) }
  refuseSecretsIn([...targets.map((e) => replyPost(pr, round, e)), commentPost], `ledger ${ledgerPath}`)

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
    const marker = replyMarker(pr, round, entry.id)
    let postedAny = false
    for (const thread of threads) {
      const done = comments.some((c) => c.in_reply_to_id === thread && c.login === me.login && (c.body ?? '').includes(marker))
      if (done) continue
      const result = await gh(
        ['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/comments/${thread}/replies`, '--input', '-'],
        JSON.stringify(replyPost(pr, round, entry)),
      )
      refuse(result.code === 0, `GitHub rejected the reply to ${entry.id} (comment ${thread}): ${oneLine(result.stderr || result.stdout)}`)
      postedAny = true
    }
    ;(postedAny ? replied : skipped).push(entry.id)
  }

  let comment: { id: number; posted: boolean } | null = null
  if (targets.length > 0) {
    const marker = commentMarker(pr, round)
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
        JSON.stringify(commentPost),
      )
      refuse(result.code === 0, `GitHub rejected the adjudication comment: ${oneLine(result.stderr || result.stdout)}`)
      comment = { id: json<{ id: number }>(result.stdout, 'post comment').id, posted: true }
    }
  }
  return `${JSON.stringify({ round, replied, skipped, walkthrough, comment })}\n`
}

export const main = runMain('reply', reply)
