// `review.ts handoff` (usage in the table in cli.ts).
// Post the hand-off marker comment (handoff.ts) on a PR, as the App named,
// with a token minted in this process. It is the last action of each AFK
// part of a run: `run-state advance`, then `lock release`, then this. A
// webhook fires the moment the comment lands, so the run state must already
// be at the phase the marker reports: handoff refuses the marker otherwise.
//
// The body is fixed text written here, never an agent's, so the marker is
// always its exact last line. It does not go through post-review, reply or
// explainer, which put the review-pipeline marker last.
//
// Each kind belongs to one App, as route reads it: review-posted and
// recheck-failed to the reviewer App, adjudicated to the Implementer App.
// A comment by the same App whose last line is the same marker is already
// the hand-off: a re-run posts nothing and prints `already: true`.
//
// Exit 3: the App is not switched on in the config, or the PR has no run
// state. Exit 4: the config is invalid, or the App is enabled but broken.
import { APPS, type AppName } from './app-token.ts'
import { Failure, parse, positive, refuse, repoOption, runMain, usageFor } from './cli.ts'
import { loadConfig } from './config.ts'
import { appIdentity, gh, json, listLines, oneLine } from './github.ts'
import { HANDOFF_KINDS, handoffMarker, type HandoffKind } from './handoff.ts'
import { hasOwnMarker } from './marker.ts'
import { loadState, type Phase } from './run-state.ts'

const usage = usageFor('handoff')

const an = (kind: HandoffKind) => `${kind === 'adjudicated' ? 'an' : 'a'} ${kind}`

// Who posts each kind, the phase the run must be at, and the text above the marker.
const KINDS: Record<HandoffKind, { app: AppName; phase: Phase; text: (round: number) => string }> = {
  'review-posted': {
    app: 'reviewer',
    phase: 'review-posted',
    text: (r) => `Hand-off: review round ${r} is posted. The PR author answers it next (the Adjudication).`,
  },
  'recheck-failed': {
    app: 'reviewer',
    phase: 'review-posted',
    text: (r) => `Hand-off: the re-check of round ${r - 1} did not pass, so round ${r} starts. The PR author answers what it left open.`,
  },
  adjudicated: {
    app: 'implementer',
    phase: 'adjudicated',
    text: (r) => `Hand-off: the Adjudication of round ${r} is done. The re-check is next.`,
  },
}

async function handoff(argv: string[]): Promise<string> {
  const { values } = parse(
    argv,
    {
      app: { type: 'string' },
      repo: { type: 'string' },
      pr: { type: 'string' },
      kind: { type: 'string' },
      round: { type: 'string' },
      config: { type: 'string' },
    },
    usage,
  )
  const app = values.app as AppName
  if (!APPS.includes(app)) throw usage(`--app must be ${APPS.join(' or ')}`)
  const repo = repoOption(values.repo, usage)
  const pr = positive('pr', values.pr, usage)
  const kind = values.kind as HandoffKind
  if (!HANDOFF_KINDS.includes(kind)) throw usage(`--kind must be ${HANDOFF_KINDS.join(', ')}`)
  const round = positive('round', values.round, usage)
  const rule = KINDS[kind]
  if (rule.app !== app) throw usage(`${an(kind)} hand-off is posted by the ${rule.app} App, not the ${app} App`)

  const loaded = await loadConfig(values.config)
  if (!loaded.ok) throw new Failure(loaded.message, 4)
  const on = app === 'implementer' ? loaded.config.implementer.app : loaded.config.app
  if (!on) {
    const key = app === 'implementer' ? 'implementer.app: enabled' : 'app: enabled'
    throw new Failure(`no ${app} App configured for this repo (no "${key}" in the config): an AFK hand-off needs the App`, 3)
  }

  const state = await loadState(pr)
  refuse(state.repo === repo, `the run state of PR #${pr} is for ${state.repo}, not ${repo}`)
  refuse(kind !== 'recheck-failed' || round >= 2, `a recheck-failed hand-off needs round 2 or later: next-round prints the new round`)
  refuse(
    state.phase === rule.phase && state.round === round,
    `PR #${pr} is at phase ${state.phase}, round ${state.round}: ${an(kind)} hand-off needs phase ${rule.phase} at round ${round}. Run run-state advance first, then lock release, then handoff`,
  )

  const me = await appIdentity(repo, app)
  if (app === 'reviewer') {
    refuse(me.login === state.reviewer_login, `the reviewer App posts as ${me.login}, but the run state for PR #${pr} expects ${state.reviewer_login}`)
  }
  const mark = handoffMarker({ kind, pr, round })
  const done = (id: number, already: boolean) => `${JSON.stringify({ id, kind, pr, round, as: me.login, already })}\n`

  const comments = await listLines<{ id: number; login: string | null; body: string | null }>(
    ['api', '--paginate', '--jq', '.[] | {id, login: .user.login, body}', `repos/${repo}/issues/${pr}/comments`],
    `the comments of PR #${pr}`,
    me.token,
  )
  const earlier = comments.find((c) => c.login === me.login && hasOwnMarker(c.body, mark))
  if (earlier !== undefined) return done(earlier.id, true)

  const post = { body: `${rule.text(round)}\n\n${mark}` }
  const result = await gh(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '-'], JSON.stringify(post), me.token)
  refuse(result.code === 0, `GitHub rejected the hand-off comment on PR #${pr}: ${oneLine(result.stderr || result.stdout)}`)
  return done(json<{ id: number }>(result.stdout, 'post the hand-off comment').id, false)
}

export const main = runMain('handoff', handoff)
