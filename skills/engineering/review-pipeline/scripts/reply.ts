// `review.ts reply` (usage in the table in cli.ts).
// Post the Implementer's Adjudication on the PR: one reply per inline
// finding in its own thread (`ACCEPT: <reason>` or `REFUTE: <reason>`), and
// one PR comment with every answered finding, walkthrough items included.
//
// Round 1 answers the whole ledger. A later round passes the previous
// round's re-check and answers only the entries that re-check did not close.
// Each post carries a hidden marker, so a re-run skips what is already on the
// PR (counting only posts by the same poster).
//
// The PR author answers the review. On a PR the Implementer App opened (an
// AFK build), the replies and the comment post as that App, with a token this
// process mints; on any other PR they post as the user. GitHub says who the
// author is: with `app: enabled`, a bot author is checked against the login
// the Implementer App's own credentials give. With no Implementer env file,
// the user answers. Broken Implementer credentials on a bot-authored PR exit
// 4 and post nothing.
import { access } from 'node:fs/promises'
import { appEnvPath } from './app-token.ts'
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
import { CLOSED, DECISIONS, loadLedger, loadRecheck, type LedgerEntry } from './ledger.ts'
import { hasOwnMarker, marker, refuseMarkerIn, withMarker } from './marker.ts'
import { loadState } from './run-state.ts'
import { refuseSecretsIn } from './secrets.ts'

const usage = usageFor('reply')

const cell = (text: string) => text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')

const replyMarker = (pr: number, round: number, id: string) => marker({ pr, round, kind: 'reply', id })
// The adjudication comment also names the run's review, so a new run on the
// same PR (after a supersede) posts its own comment.
const commentMarker = (pr: number, round: number, review: number | undefined) =>
  marker({ pr, round, kind: 'adjudication', ...(review === undefined ? {} : { review }) })
// The exact objects posted: a finding's thread reply, and the PR comment.
const replyPost = (pr: number, round: number, entry: LedgerEntry) => ({
  body: withMarker(`${entry.decision}: ${entry.reason}`, replyMarker(pr, round, entry.id)),
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

// Who answers: the Implementer App when it is the PR's author, else the user.
// No Implementer env file means no Implementer App on this machine, so the
// user answers. With one, the App's own login tells it from another bot, and
// broken credentials throw Failure 4: the CLI cannot tell whose PR it is.
async function poster(repo: string, pr: number, app: boolean): Promise<Identity> {
  if (!app) return userIdentity()
  const read = await gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.user.login'])
  const author = read.stdout.trim()
  refuse(read.code === 0 && author !== '', `cannot read the author of PR #${pr}: ${oneLine(read.stderr)}`)
  if (!author.endsWith('[bot]')) return userIdentity()
  const envFile = await access(appEnvPath('implementer')).then(() => true, () => false)
  if (!envFile) return userIdentity()
  const implementer = await appIdentity(repo, 'implementer')
  return implementer.login === author ? implementer : userIdentity()
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
      config: { type: 'string' },
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

  // As in post-review, any config problem is broken (4).
  const loaded = await loadConfig(values.config)
  if (!loaded.ok) throw new Failure(loaded.message, 4)

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
  refuseMarkerIn(
    targets.flatMap((e) => [e.id, e.reason, typeof e.where === 'string' ? e.where : '']),
    `ledger ${ledgerPath}`,
  )
  const state = await loadState(pr)
  const runReview = state.reviews.find((r) => r.kind === 'review')?.id
  const commentPost = { body: summary(round, targets, commentMarker(pr, round, runReview)) }
  refuseSecretsIn([...targets.map((e) => replyPost(pr, round, e)), commentPost], `ledger ${ledgerPath}`)

  const me = await poster(repo, pr, loaded.config.app)
  const comments = await listInlineComments(repo, pr, me.token)
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
    const mark = replyMarker(pr, round, entry.id)
    let postedAny = false
    for (const thread of threads) {
      const done = comments.some((c) => c.in_reply_to_id === thread && c.login === me.login && hasOwnMarker(c.body, mark))
      if (done) continue
      const result = await gh(
        ['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/comments/${thread}/replies`, '--input', '-'],
        JSON.stringify(replyPost(pr, round, entry)),
        me.token,
      )
      refuse(result.code === 0, `GitHub rejected the reply to ${entry.id} (comment ${thread}): ${oneLine(result.stderr || result.stdout)}`)
      postedAny = true
    }
    ;(postedAny ? replied : skipped).push(entry.id)
  }

  let comment: { id: number; posted: boolean } | null = null
  if (targets.length > 0) {
    const mark = commentMarker(pr, round, runReview)
    const existing = (
      await listLines<{ id: number; body: string | null; login: string | null }>(
        ['api', '--paginate', '--jq', '.[] | {id, body, login: .user.login}', `repos/${repo}/issues/${pr}/comments`],
        `the comments of PR #${pr}`,
        me.token,
      )
    ).find((c) => c.login === me.login && hasOwnMarker(c.body, mark))
    if (existing !== undefined) {
      comment = { id: existing.id, posted: false }
    } else {
      const result = await gh(
        ['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '-'],
        JSON.stringify(commentPost),
        me.token,
      )
      refuse(result.code === 0, `GitHub rejected the adjudication comment: ${oneLine(result.stderr || result.stdout)}`)
      comment = { id: json<{ id: number }>(result.stdout, 'post comment').id, posted: true }
    }
  }
  return `${JSON.stringify({ round, replied, skipped, walkthrough, comment })}\n`
}

export const main = runMain('reply', reply)
