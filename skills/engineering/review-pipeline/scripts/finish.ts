// The Finish subcommands, each run with `--repo O/R --pr N`:
//
//   review.ts merge-gate   one read of the PR: is it safe to squash-merge now?
//                          Prints {gate: go|wait|stop|merged, ...}. It never
//                          waits: the caller waits and runs it again.
//   review.ts merge        runs the gate again and, on go, squash-merges the
//                          re-checked head. A PR already merged is a no-op.
//   review.ts explainer    records the explainer path in the run state and
//                          links it from the PR in one comment, posted once.
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { gh, json, listLines, oneLine, refuse, userIdentity } from './github.ts'
import { Failure, loadState, saveState, type State } from './run-state.ts'

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

function judge(view: PrView, state: State): Gate {
  const checks = { passed: 0, pending: [] as string[], failed: [] as string[] }
  for (const check of view.statusCheckRollup ?? []) {
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
    stop.push(`the head moved since the re-check: the PR is at ${view.headRefOid}, the re-check graded ${state.head_sha}`)
  }
  if (view.isDraft) stop.push('the PR is still a draft: flip it to ready first')
  // With the reviewer App, its APPROVE verdict on the re-checked head is part
  // of the gate. post-review records a verdict only after it posts, refuses an
  // APPROVE on a failing gate, and posts REQUEST_CHANGES only when the run
  // stops, so a recorded verdict at this head by the App is its approval.
  if (state.reviewer_login !== 'none') {
    const approved = state.reviews.some(
      (r) => r.kind === 'verdict' && r.commit === state.head_sha && r.as === state.reviewer_login,
    )
    if (!approved) {
      stop.push(
        `the reviewer App ${state.reviewer_login} has not approved the re-checked head ${state.head_sha}: post its APPROVE verdict first`,
      )
    }
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

export async function readGate(repo: string, pr: number, state: State): Promise<Gate> {
  const viewed = await gh(['pr', 'view', String(pr), '--repo', repo, '--json', VIEW_FIELDS])
  refuse(viewed.code === 0, `cannot read PR #${pr}: ${oneLine(viewed.stderr)}`)
  return judge(json<PrView>(viewed.stdout, 'pr view'), state)
}

type Args = { repo: string; pr: number; file?: string }

function parse(argv: string[], usage: (message: string) => Failure, withFile: boolean): Args {
  let values
  try {
    values = parseArgs({
      args: argv,
      strict: true,
      options: { repo: { type: 'string' }, pr: { type: 'string' }, ...(withFile ? { file: { type: 'string' } } : {}) },
    }).values as { repo?: string; pr?: string; file?: string }
  } catch (error) {
    throw usage((error as Error).message)
  }
  if (values.repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) throw usage('--repo must be OWNER/REPO')
  if (values.pr === undefined || !/^[0-9]+$/.test(values.pr) || Number(values.pr) < 1) {
    throw usage('--pr must be a positive whole number')
  }
  return { repo: values.repo, pr: Number(values.pr), file: values.file }
}

async function stateFor(args: Args): Promise<State> {
  const state = await loadState(args.pr)
  refuse(state.repo === args.repo, `the run state for PR #${args.pr} is for ${state.repo}, not ${args.repo}`)
  return state
}

function usageFor(usage: string): (message: string) => Failure {
  return (message) => new Failure(`${message}\n${usage}`, 2)
}

const MERGE_GATE_USAGE = 'usage: review.ts merge-gate --repo O/R --pr N'
const MERGE_USAGE = 'usage: review.ts merge --repo O/R --pr N'
const EXPLAINER_USAGE = 'usage: review.ts explainer --repo O/R --pr N --file <absolute path to explainer.html>'

async function mergeGate(argv: string[]): Promise<string> {
  const args = parse(argv, usageFor(MERGE_GATE_USAGE), false)
  const state = await stateFor(args)
  return `${JSON.stringify(await readGate(args.repo, args.pr, state))}\n`
}

async function merge(argv: string[]): Promise<string> {
  const args = parse(argv, usageFor(MERGE_USAGE), false)
  const state = await stateFor(args)
  refuse(
    state.mode === 'single',
    `the run for PR #${args.pr} is in ${state.mode} mode: review-pipeline does not merge it (the stack lands its layers)`,
  )
  refuse(
    state.phase === 'explained' || state.phase === 'merged',
    `merge needs phase explained, but PR #${args.pr} is at ${state.phase}`,
  )
  return squashMerge(args.repo, args.pr, state)
}

// Run the gate again and, on go, squash-merge the run's head. A PR already
// merged changes nothing. Shared by `merge` and `stack merge-layer`.
export async function squashMerge(repo: string, pr: number, state: State): Promise<string> {
  const gate = await readGate(repo, pr, state)
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
  const usage = usageFor(EXPLAINER_USAGE)
  const args = parse(argv, usage, true)
  const file = args.file
  if (file === undefined || !isAbsolute(file)) throw usage('--file must be an absolute path')
  const state = await stateFor(args)
  const found = await stat(file).catch(() => undefined)
  refuse(found?.isFile() === true, `no explainer file at ${file}: build it first`)

  if (state.explainer !== file) {
    state.explainer = file
    state.updated_at = new Date().toISOString()
    await saveState(state)
  }

  const marker = `<!-- hero-pocock:review-pipeline pr=${args.pr} kind=explainer -->`
  const me = await userIdentity()
  const existing = (
    await listLines<{ id: number; body: string | null; login: string | null }>(
      ['api', '--paginate', '--jq', '.[] | {id, body, login: .user.login}', `repos/${args.repo}/issues/${args.pr}/comments`],
      `the comments of PR #${args.pr}`,
    )
  ).find((c) => c.login === me.login && (c.body ?? '').includes(marker))
  if (existing !== undefined) return `${JSON.stringify({ explainer: file, comment: { id: existing.id, posted: false } })}\n`

  const body = `Explainer (local, not published): \`${file}\`\n\n${marker}`
  const posted = await gh(['api', '-X', 'POST', `repos/${args.repo}/issues/${args.pr}/comments`, '--input', '-'], JSON.stringify({ body }))
  refuse(posted.code === 0, `GitHub rejected the explainer comment: ${oneLine(posted.stderr || posted.stdout)}`)
  const id = json<{ id: number }>(posted.stdout, 'post comment').id
  return `${JSON.stringify({ explainer: file, comment: { id, posted: true } })}\n`
}

function runner(name: string, fn: (argv: string[]) => Promise<string>): (argv: string[]) => Promise<number> {
  return async (argv) => {
    try {
      process.stdout.write(await fn(argv))
      return 0
    } catch (error) {
      if (!(error instanceof Failure)) throw error
      process.stderr.write(`review.ts ${name}: ${error.message}\n`)
      return error.code
    }
  }
}

export const mergeGateMain = runner('merge-gate', mergeGate)
export const mergeMain = runner('merge', merge)
export const explainerMain = runner('explainer', explainer)
