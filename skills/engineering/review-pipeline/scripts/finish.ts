// The Finish subcommands, each run with `--repo O/R --pr N`:
//
//   review.ts merge-gate   one read of the PR: is it safe to squash-merge now?
//                          Prints {gate: go|wait|stop|merged, ...}. It never
//                          waits: the caller waits and runs it again. On both
//                          paths it needs a passing re-check recorded at the
//                          head; with the reviewer App (the config says so,
//                          not the run state) also the App's APPROVE there,
//                          in the run state and on GitHub, by the login the
//                          App's own credentials give (never the run state's
//                          word alone).
//   review.ts merge        runs the gate again and, on go, squash-merges the
//                          re-checked head. A PR already merged is a no-op.
//   review.ts explainer    records the explainer path in the run state and
//                          links it from the PR in one comment, posted once.
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Failure, parse as parseOptions, positive, refuse, repoOption, runMain, usageFor, type Usage } from './cli.ts'
import { mintAppToken } from './app-token.ts'
import { loadConfig } from './config.ts'
import { GATE_CONTEXT } from './gate-status.ts'
import { gh, json, listLines, oneLine, userIdentity } from './github.ts'
import { hasOwnMarker, marker, refuseMarkerIn, withMarker } from './marker.ts'
import { refuseSecretsIn } from './secrets.ts'
import { latestGate, latestVerdict, loadState, saveState, usesApp, type State } from './run-state.ts'

const VIEW_FIELDS = 'state,isDraft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup'

// A check run or a commit status, as `gh pr view --json statusCheckRollup` lists them.
type Check = { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string }
type PrView = {
  state: string
  isDraft: boolean
  headRefOid: string
  mergeable: string
  mergeStateStatus: string
  statusCheckRollup: Check[] | null
}

export type Gate = {
  gate: 'go' | 'wait' | 'stop' | 'merged'
  ci: 'green' | 'none' | 'pending' | 'red'
  checks: { passed: number; pending: string[]; failed: string[] }
  mergeable: string
  merge_state: string
  problems: string[]
}

const PASSED_RUN = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
const PENDING_STATUS = ['PENDING', 'EXPECTED']
// Merge states that let a squash merge through. UNKNOWN means GitHub has not
// computed it yet; every other state needs a human.
const CLEAN_STATES = ['CLEAN', 'HAS_HOOKS']

// passed, pending or failed, for one check.
function outcome(check: Check): 'passed' | 'pending' | 'failed' {
  if (check.__typename === 'StatusContext') {
    if (check.state === 'SUCCESS') return 'passed'
    return PENDING_STATUS.includes(check.state ?? '') ? 'pending' : 'failed'
  }
  if (check.status !== 'COMPLETED') return 'pending'
  return PASSED_RUN.includes(check.conclusion ?? '') ? 'passed' : 'failed'
}

// A review as the GitHub reviews list has it.
export type GitHubReview = { id: number; state: string; commit_id: string | null; login: string | null }

// Why the reviewer App's approval of the head does not hold, or undefined.
// Locally, the App's latest verdict recorded at the head must be APPROVE. On
// GitHub, the App's latest review that is not a COMMENT (nor PENDING) must be
// APPROVED, on the head commit: a later CHANGES_REQUESTED, a dismissal, or an
// approval of an older commit does not count.
function appApprovalProblem(state: State, bot: string, reviews: GitHubReview[]): string | undefined {
  const head = state.head_sha
  if (latestVerdict(state, head, bot)?.event !== 'APPROVE') {
    return `the reviewer App ${bot} has not approved the re-checked head ${head}: post its APPROVE verdict first`
  }
  const latest = reviews.filter((r) => r.login === bot && r.state !== 'COMMENTED' && r.state !== 'PENDING').at(-1)
  if (latest === undefined) return `GitHub shows no review by ${bot} that approves the head ${head}`
  if (latest.state !== 'APPROVED' || latest.commit_id !== head) {
    return `on GitHub, the latest review by ${bot} is ${latest.state} on ${latest.commit_id}, not APPROVED on the head ${head}`
  }
  return undefined
}

// `appLogin` is the reviewer App's login from its own credentials, or null
// when the config does not enable the App. `reviews` is the PR's GitHub
// reviews, read only with the App.
function judge(view: PrView, state: State, appLogin: string | null, reviews: GitHubReview[]): Gate {
  const app = appLogin !== null
  const checks = { passed: 0, pending: [] as string[], failed: [] as string[] }
  // The reviewer App's own gate status is not CI: the re-check gate below
  // enforces the gate, and counting it would turn a PR with no CI green.
  for (const check of view.statusCheckRollup ?? []) {
    if (check.__typename === 'StatusContext' && check.context === GATE_CONTEXT) continue
    const name = check.name ?? check.context ?? 'unnamed check'
    const result = outcome(check)
    if (result === 'passed') checks.passed += 1
    else checks[result].push(name)
  }
  const ci: Gate['ci'] =
    checks.failed.length > 0 ? 'red' : checks.pending.length > 0 ? 'pending' : checks.passed > 0 ? 'green' : 'none'
  const base = { ci, checks, mergeable: view.mergeable, merge_state: view.mergeStateStatus }
  if (view.state === 'MERGED') return { gate: 'merged', ...base, problems: [] }

  const stop: string[] = []
  const wait: string[] = []
  if (view.state !== 'OPEN') stop.push(`the PR is ${view.state}, not OPEN`)
  if (view.headRefOid !== state.head_sha) {
    stop.push(
      `the head moved since the re-check: the PR is at ${view.headRefOid}, the re-check graded ${state.head_sha}. Start a new run at the new head: review.ts run-state supersede --pr ${state.pr}, then /review-pipeline ${state.pr}`,
    )
  }
  if (view.isDraft) stop.push('the PR is still a draft: flip it to ready first')
  // The re-check gate, on both paths: the latest result at the head.
  const recheck = latestGate(state, state.head_sha)
  if (recheck === undefined) stop.push(`no re-check is recorded at the head ${state.head_sha}: run the re-check first`)
  else if (recheck.result !== 'pass') stop.push(`the latest re-check at the head ${state.head_sha} failed: the PR cannot merge`)
  // The config decides whether the App's approval is part of the gate. A run
  // state that disagrees cannot pass: a run created with no reviewer login
  // would otherwise skip the approval check.
  if (app && !usesApp(state)) {
    stop.push('the config enables the reviewer App, but the run state has reviewer_login none: the App approval cannot be checked')
  } else if (!app && usesApp(state)) {
    stop.push(`the config does not enable the reviewer App, but the run state has reviewer_login ${state.reviewer_login}`)
  } else if (appLogin !== null && appLogin !== state.reviewer_login) {
    stop.push(`the run state names reviewer_login ${state.reviewer_login}, but the reviewer App's credentials say its login is ${appLogin}`)
  } else if (appLogin !== null) {
    const problem = appApprovalProblem(state, appLogin, reviews)
    if (problem !== undefined) stop.push(problem)
  }
  if (ci === 'red') stop.push(`CI failed: ${checks.failed.join(', ')}`)
  if (ci === 'pending') wait.push(`CI is still running: ${checks.pending.join(', ')}`)
  if (view.mergeable === 'CONFLICTING') stop.push('the PR has a merge conflict with its base')
  else if (view.mergeable === 'UNKNOWN') wait.push('GitHub has not computed mergeable yet (UNKNOWN)')
  else if (view.mergeable !== 'MERGEABLE') stop.push(`mergeable is ${view.mergeable}`)
  // A pending CI often shows as BLOCKED, and a draft as DRAFT, so judge the
  // merge state only when nothing above explains it.
  const explained = ci === 'pending' || view.isDraft || view.mergeable !== 'MERGEABLE'
  if (!explained && !CLEAN_STATES.includes(view.mergeStateStatus)) {
    if (view.mergeStateStatus === 'UNKNOWN') wait.push('GitHub has not computed the merge state yet (UNKNOWN)')
    else stop.push(`GitHub reports the merge state ${view.mergeStateStatus}: a human must clear it`)
  }
  if (stop.length > 0) return { gate: 'stop', ...base, problems: [...stop, ...wait] }
  if (wait.length > 0) return { gate: 'wait', ...base, problems: wait }
  return { gate: 'go', ...base, problems: [] }
}

// Read the PR (and with the App, its reviews) and judge it. `appLogin` is
// the App's verified login (appLogin()), or null without the App.
export async function readGate(repo: string, pr: number, state: State, appLogin: string | null): Promise<Gate> {
  const viewed = await gh(['pr', 'view', String(pr), '--repo', repo, '--json', VIEW_FIELDS])
  refuse(viewed.code === 0, `cannot read PR #${pr}: ${oneLine(viewed.stderr)}`)
  const view = json<PrView>(viewed.stdout, 'pr view')
  const reviews =
    appLogin !== null && view.state !== 'MERGED'
      ? await listLines<GitHubReview>(
          ['api', '--paginate', '--jq', '.[] | {id, state, commit_id, login: .user.login}', `repos/${repo}/pulls/${pr}/reviews`],
          `the reviews of PR #${pr}`,
        )
      : []
  return judge(view, state, appLogin, reviews)
}

// The reviewer App's login when the config enables it, from the App's own
// credentials (the in-process path post-review and app-token --login use),
// or null without the App. A broken App throws Failure 4.
export async function appLogin(repo: string, app: boolean): Promise<string | null> {
  return app ? (await mintAppToken(repo)).login : null
}

// Whether the config enables the reviewer App. The pipeline never gets to
// Finish without a valid config, so any problem is broken (4).
export async function configApp(path: string | undefined): Promise<boolean> {
  const loaded = await loadConfig(path)
  if (!loaded.ok) throw new Failure(loaded.message, 4)
  return loaded.config.app
}

type Args = { repo: string; pr: number; file?: string; config?: string }

function parse(argv: string[], usage: Usage, withFile: boolean): Args {
  const common = { repo: { type: 'string' }, pr: { type: 'string' } } as const
  const values: { repo?: string; pr?: string; file?: string; config?: string } = withFile
    ? parseOptions(argv, { ...common, file: { type: 'string' } }, usage).values
    : parseOptions(argv, { ...common, config: { type: 'string' } }, usage).values
  return { repo: repoOption(values.repo, usage), pr: positive('pr', values.pr, usage), file: values.file, config: values.config }
}

async function stateFor(args: Args): Promise<State> {
  const state = await loadState(args.pr)
  refuse(state.repo === args.repo, `the run state for PR #${args.pr} is for ${state.repo}, not ${args.repo}`)
  return state
}

async function mergeGate(argv: string[]): Promise<string> {
  const args = parse(argv, usageFor('merge-gate'), false)
  const app = await configApp(args.config)
  const state = await stateFor(args)
  return `${JSON.stringify(await readGate(args.repo, args.pr, state, await appLogin(args.repo, app)))}\n`
}

async function merge(argv: string[]): Promise<string> {
  const args = parse(argv, usageFor('merge'), false)
  const app = await configApp(args.config)
  const state = await stateFor(args)
  refuse(
    state.mode === 'single',
    `the run for PR #${args.pr} is in ${state.mode} mode: review-pipeline does not merge it (the stack lands its layers)`,
  )
  refuse(
    state.phase === 'explained' || state.phase === 'merged',
    `merge needs phase explained, but PR #${args.pr} is at ${state.phase}`,
  )
  return squashMerge(args.repo, args.pr, state, app)
}

// Run the gate again and, on go, squash-merge the run's head. A PR already
// merged changes nothing. Shared by `merge` and `stack merge-layer`.
export async function squashMerge(repo: string, pr: number, state: State, app: boolean): Promise<string> {
  const gate = await readGate(repo, pr, state, await appLogin(repo, app))
  if (gate.gate === 'merged') return `${JSON.stringify({ merged: true, already: true })}\n`
  refuse(gate.gate === 'go', `not merging PR #${pr} (gate ${gate.gate}): ${gate.problems.join('; ')}`)

  // Never --admin (it skips the checks), never --delete-branch (it fails in a
  // linked worktree). --match-head-commit refuses a head nobody re-checked.
  const merged = await gh(['pr', 'merge', String(pr), '--repo', repo, '--squash', '--match-head-commit', state.head_sha])
  refuse(merged.code === 0, `GitHub refused the squash merge of PR #${pr}: ${oneLine(merged.stderr || merged.stdout)}`)
  const after = await gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'state,mergeCommit'])
  refuse(after.code === 0, `cannot read PR #${pr} after the merge: ${oneLine(after.stderr)}`)
  const view = json<{ state: string; mergeCommit: { oid?: string } | null }>(after.stdout, 'pr view')
  refuse(view.state === 'MERGED', `PR #${pr} is ${view.state} after the merge call, not MERGED`)
  return `${JSON.stringify({ merged: true, already: false, merge_commit: view.mergeCommit?.oid ?? null })}\n`
}

async function explainer(argv: string[]): Promise<string> {
  const usage = usageFor('explainer')
  const args = parse(argv, usage, true)
  const file = args.file
  if (file === undefined || !isAbsolute(file)) throw usage('--file must be an absolute path')
  const state = await stateFor(args)
  const found = await stat(file).catch(() => undefined)
  refuse(found?.isFile() === true, `no explainer file at ${file}: build it first`)
  // The comment holds an agent-supplied path: it is scanned like every post,
  // before anything is recorded or sent.
  const mark = marker({ pr: args.pr, kind: 'explainer' })
  const body = withMarker(`Explainer (local, not published): \`${file}\``, mark)
  refuseMarkerIn([file], '--file')
  refuseSecretsIn({ body }, 'the explainer comment')

  if (state.explainer !== file) {
    state.explainer = file
    state.updated_at = new Date().toISOString()
    await saveState(state)
  }

  const me = await userIdentity()
  const existing = (
    await listLines<{ id: number; body: string | null; login: string | null }>(
      ['api', '--paginate', '--jq', '.[] | {id, body, login: .user.login}', `repos/${args.repo}/issues/${args.pr}/comments`],
      `the comments of PR #${args.pr}`,
    )
  ).find((c) => c.login === me.login && hasOwnMarker(c.body, mark))
  if (existing !== undefined) return `${JSON.stringify({ explainer: file, comment: { id: existing.id, posted: false } })}\n`

  const posted = await gh(['api', '-X', 'POST', `repos/${args.repo}/issues/${args.pr}/comments`, '--input', '-'], JSON.stringify({ body }))
  refuse(posted.code === 0, `GitHub rejected the explainer comment: ${oneLine(posted.stderr || posted.stdout)}`)
  const id = json<{ id: number }>(posted.stdout, 'post comment').id
  return `${JSON.stringify({ explainer: file, comment: { id, posted: true } })}\n`
}

export const mergeGateMain = runMain('merge-gate', mergeGate)
export const mergeMain = runMain('merge', merge)
export const explainerMain = runMain('explainer', explainer)
