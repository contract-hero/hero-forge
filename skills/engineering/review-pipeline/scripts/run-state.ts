// `review.ts run-state <path|create|read|advance|set|next-round> --pr <N> ...`: the
// per-PR checkpoint that lets an interrupted pipeline run resume without
// repeating a step that already reached GitHub.
//
// The run dir is `${HERO_FORGE_STATE_DIR:-<git common dir>/hero-forge}/pr-<N>/`.
// It holds `state.json` plus the pipeline's own files (briefs, reviewer
// output, the review payload). `phase` is the last completed checkpoint, and
// `advance` moves it one step at a time, in the order of the run's mode.
// `reviews` and `gates` are what post-review recorded; some steps need them.
// `supersede` ends a run whose PR head moved after a review was posted: it
// marks the run `superseded` and moves the whole run dir aside, so a new run
// at the new head starts with no file of the old one.
//
// With the reviewer App, a run that stops (`next-round` out of rounds, or
// `advance stopped`) posts the `contract-reviewer/gate` failure status at its
// head (gate-status.ts) before the stop is saved, so a failed post leaves the
// run where it was and the same step posts it on a re-run.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Failure, parse, positive, refuse, runMain, SETTABLE, usageFor } from './cli.ts'
import { loadConfig } from './config.ts'
import { postGateStatus } from './gate-status.ts'

export const PHASES = [
  'created',
  'review-dispatched',
  'review-posted',
  'adjudicated',
  'rechecked',
  'body-rewritten',
  'ready',
  'verdict-posted',
  'explained',
  'merged',
  'complete',
  'aborted',
  'stopped',
  'superseded',
] as const
export type Phase = (typeof PHASES)[number]
const TERMINAL: readonly Phase[] = ['complete', 'aborted', 'stopped', 'superseded']
export const MODES = ['single', 'layer', 'stack-final'] as const
export type Mode = (typeof MODES)[number]
export const RUNTIMES = ['codex', 'claude'] as const
export type Runtime = (typeof RUNTIMES)[number]
export const KINDS = ['review', 'recheck', 'verdict'] as const
export type Kind = (typeof KINDS)[number]

// `includes` for a const list, narrowing the value to the list's type.
export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return (list as readonly unknown[]).includes(value)
}

export const EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const
export type Event = (typeof EVENTS)[number]
export const RESULTS = ['pass', 'fail'] as const

// One posted review, and one gate result (a re-check or verdict post ran the
// gate at `commit`).
export type ReviewRecord = { round: number; kind: Kind; id: number; commit: string; as: string; event: Event }
export type GateRecord = { round: number; commit: string; result: (typeof RESULTS)[number] }

export type State = {
  schema: 2
  repo: string
  pr: number
  mode: Mode
  base_ref: string
  head_ref: string
  head_sha: string
  runtime: Runtime
  reviewer_login: string
  round: number
  phase: Phase
  reviews: ReviewRecord[]
  gates: GateRecord[]
  explainer: string | null
  created_at: string
  updated_at: string
}

const isPositiveInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0
const isSha = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v)
const isLogin = (v: unknown) => v === 'none' || (typeof v === 'string' && /^[A-Za-z0-9-]+\[bot\]$/.test(v))
const isText = (v: unknown) => typeof v === 'string' && v !== ''

// Each field of the schema and the check its value must pass.
const FIELDS: Record<string, (v: unknown) => boolean> = {
  schema: (v) => v === 2,
  repo: (v) => typeof v === 'string' && /^[\w.-]+\/[\w.-]+$/.test(v),
  pr: isPositiveInt,
  mode: (v) => isOneOf(MODES, v),
  base_ref: isText,
  head_ref: isText,
  head_sha: isSha,
  runtime: (v) => isOneOf(RUNTIMES, v),
  reviewer_login: isLogin,
  round: isPositiveInt,
  phase: (v) => isOneOf(PHASES, v),
  reviews: (v) => Array.isArray(v) && v.every(isReviewRecord),
  gates: (v) => Array.isArray(v) && v.every(isGateRecord),
  explainer: (v) => v === null || isText(v),
  created_at: isText,
  updated_at: isText,
}

function isReviewRecord(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    isPositiveInt(r.round) && isOneOf(KINDS, r.kind) && isPositiveInt(r.id) && isSha(r.commit) && isText(r.as) &&
    isOneOf(EVENTS, r.event)
  )
}

function isGateRecord(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const g = v as Record<string, unknown>
  return isPositiveInt(g.round) && isSha(g.commit) && isOneOf(RESULTS, g.result)
}

export const usesApp = (state: State) => state.reviewer_login !== 'none'

// The last gate result recorded at `commit`, if any.
export function latestGate(state: State, commit: string): GateRecord | undefined {
  return state.gates.filter((g) => g.commit === commit).at(-1)
}

// The last verdict posted at `commit` by `login` (default: the run's
// reviewer_login), if any.
export function latestVerdict(state: State, commit: string, login = state.reviewer_login): ReviewRecord | undefined {
  return state.reviews.filter((r) => r.kind === 'verdict' && r.commit === commit && r.as === login && firstRecord(state, r)).at(-1)
}

// Whether `r` is the first record of its review id. hero-forge 1.0.1 recorded
// a review that GitHub moved to a restacked head a second time, at the new
// head: that later record is not a review of its commit.
export function firstRecord(state: State, r: ReviewRecord): boolean {
  return state.reviews.find((x) => x.id === r.id) === r
}

// The one step after `state.phase` (aborted and stopped aside, which any
// non-terminal phase may take). Finish depends on the mode and the App:
//   single       body-rewritten, ready, [verdict-posted], explained, merged, complete
//   layer        body-rewritten, ready, [verdict-posted], complete
//   stack-final  body-rewritten, explained, complete (a draft PR that never merges)
// where [verdict-posted] is the App's APPROVE, only with the App.
function nextPhase(state: State): Phase | undefined {
  switch (state.phase) {
    case 'created':
      return 'review-dispatched'
    case 'review-dispatched':
      return 'review-posted'
    case 'review-posted':
      return 'adjudicated'
    case 'adjudicated':
      return 'rechecked'
    case 'rechecked':
      return 'body-rewritten'
    case 'body-rewritten':
      return state.mode === 'stack-final' ? 'explained' : 'ready'
    case 'ready':
      if (usesApp(state)) return 'verdict-posted'
      return state.mode === 'layer' ? 'complete' : 'explained'
    case 'verdict-posted':
      return state.mode === 'layer' ? 'complete' : 'explained'
    case 'explained':
      return state.mode === 'stack-final' ? 'complete' : 'merged'
    case 'merged':
      return 'complete'
    default:
      return undefined
  }
}

// What a step needs on record before the run may reach it, or undefined.
function missing(state: State, to: Phase): string | undefined {
  const { round, head_sha: head } = state
  switch (to) {
    case 'review-posted':
      return state.reviews.some((r) => r.kind === 'review' && r.round === round)
        ? undefined
        : `no review of round ${round} is recorded. Post it first`
    case 'rechecked':
      return state.gates.some((g) => g.round === round && g.commit === head)
        ? undefined
        : `no re-check gate of round ${round} at ${head} is recorded. Post the re-check first`
    case 'body-rewritten':
      return latestGate(state, head)?.result === 'pass' ? undefined : `the re-check gate at ${head} did not pass. Run next-round`
    case 'verdict-posted':
      return latestVerdict(state, head)?.event === 'APPROVE'
        ? undefined
        : `the reviewer App ${state.reviewer_login} has no APPROVE recorded at ${head}. Post it first`
    default:
      return undefined
  }
}

function advance(state: State, to: Phase): void {
  const pr = state.pr
  refuse(!TERMINAL.includes(state.phase), `run for PR #${pr} is ${state.phase} (terminal): create a new run`)
  if (to === 'aborted' || to === 'stopped') {
    state.phase = to
    return
  }
  const next = nextPhase(state)
  refuse(to === next, `cannot advance PR #${pr} from ${state.phase} to ${to}: the next step is ${next}`)
  const need = missing(state, to)
  refuse(need === undefined, `cannot advance PR #${pr} to ${to}: ${need}`)
  state.phase = to
}

// Why `value` is not a valid state, or undefined when it is.
function problem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not a JSON object'
  const obj = value as Record<string, unknown>
  if (!('schema' in obj)) return 'no schema field'
  if (!('phase' in obj)) return 'no phase field'
  for (const key of Object.keys(obj)) if (!(key in FIELDS)) return `unknown field "${key}"`
  for (const [key, ok] of Object.entries(FIELDS)) {
    if (!(key in obj)) return `missing field "${key}"`
    if (!ok(obj[key])) return `bad value for "${key}"`
  }
  return undefined
}

export function stateRoot(): string {
  const override = process.env.HERO_FORGE_STATE_DIR
  if (override !== undefined && override !== '') return override
  const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' })
  refuse(git.status === 0, 'not inside a git repository (or set HERO_FORGE_STATE_DIR)')
  return join(git.stdout.trim(), 'hero-forge')
}

export function runDir(pr: number): string {
  return join(stateRoot(), `pr-${pr}`)
}

export function stateFile(pr: number): string {
  return join(runDir(pr), 'state.json')
}

// Read and check the state file. No file: exit 3. Bad contents: exit 4.
export async function loadState(pr: number): Promise<State> {
  const file = stateFile(pr)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw new Failure(`no run state for PR #${pr} at ${file}`, 3)
    throw new Failure(`cannot read ${file}: ${(error as Error).message}`, 1)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Failure(`corrupt state file ${file}: ${(error as Error).message}`, 4)
  }
  const reason = problem(value)
  if (reason !== undefined) throw new Failure(`corrupt state file ${file}: ${reason}`, 4)
  return value as State
}

// Write the whole state atomically: a temp file in the same dir, then rename.
export async function saveState(state: State): Promise<void> {
  const dir = runDir(state.pr)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'state.json')
  const tmp = `${file}.${randomBytes(6).toString('hex')}`
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

async function update(pr: number, change: (state: State) => void): Promise<void> {
  const state = await loadState(pr)
  change(state)
  state.updated_at = new Date().toISOString()
  await saveState(state)
}

const usage = usageFor('run-state')

const OPTIONS = {
  pr: { type: 'string' },
  repo: { type: 'string' },
  base: { type: 'string' },
  head: { type: 'string' },
  'head-sha': { type: 'string' },
  runtime: { type: 'string' },
  'reviewer-login': { type: 'string' },
  mode: { type: 'string' },
  force: { type: 'boolean' },
  'max-rounds': { type: 'string' },
  config: { type: 'string' },
} as const

// Post the gate failure status for a run that stops, with the App only: the
// run must have the App's login and the config must enable it. Without the
// App nothing posts, never as the user. The pipeline never gets here without
// a valid config, so any problem with it is broken (4).
async function announceStop(state: State, config: string | undefined, description: string): Promise<void> {
  if (!usesApp(state)) return
  const loaded = await loadConfig(config)
  if (!loaded.ok) throw new Failure(loaded.message, 4)
  if (!loaded.config.app) return
  await postGateStatus(state, 'failure', description)
}

async function create(pr: number, values: Record<string, string | boolean | undefined>): Promise<string> {
  const need = (name: string): string => {
    const v = values[name]
    if (typeof v !== 'string' || v === '') throw usage(`create needs --${name}`)
    return v
  }
  const repo = need('repo')
  const headSha = need('head-sha')
  const runtime = need('runtime')
  const login = need('reviewer-login')
  const mode = typeof values.mode === 'string' ? values.mode : 'single'
  refuse(FIELDS.repo!(repo), `repo must be OWNER/REPO, got "${repo}"`)
  refuse(isSha(headSha), `head_sha must be 40 hex characters, got "${headSha}"`)
  if (!isOneOf(RUNTIMES, runtime)) throw new Failure(`runtime must be codex or claude, got "${runtime}"`, 1)
  refuse(isLogin(login), `reviewer_login must be "none" or <slug>[bot], got "${login}"`)
  if (!isOneOf(MODES, mode)) throw new Failure(`mode must be ${MODES.join(', ')}, got "${mode}"`, 1)
  const now = new Date().toISOString()
  const state: State = {
    schema: 2,
    repo,
    pr,
    mode,
    base_ref: need('base'),
    head_ref: need('head'),
    head_sha: headSha,
    runtime,
    reviewer_login: login,
    round: 1,
    phase: 'created',
    reviews: [],
    gates: [],
    explainer: null,
    created_at: now,
    updated_at: now,
  }

  if (values.force !== true) {
    try {
      const old = await loadState(pr)
      refuse(
        TERMINAL.includes(old.phase),
        `run in flight for PR #${pr} (phase ${old.phase}): resume it, or, when the PR head moved, run-state supersede --pr ${pr} first (create --force is for a corrupt state file)`,
      )
    } catch (error) {
      if (!(error instanceof Failure) || error.code !== 3) throw error
    }
  }
  await saveState(state)
  return `${JSON.stringify(state, null, 2)}\n`
}

// End the run of PR `pr` because its head moved after a review was posted:
// phase `superseded`, and the run dir renamed to `pr-<N>.superseded-<sha7>`
// beside it, where nothing reads it. At `created` nothing was reviewed yet, so
// the new head is pinned with `set` instead.
async function supersede(pr: number): Promise<string> {
  const state = await loadState(pr)
  refuse(
    state.phase !== 'created',
    `run for PR #${pr} is at created: nothing was reviewed yet, so pin the new head with run-state set --pr ${pr} head_sha <sha>`,
  )
  const dir = runDir(pr)
  const archive = `${dir}.superseded-${state.head_sha.slice(0, 7)}`
  const taken = await stat(archive).then(
    () => true,
    () => false,
  )
  refuse(!taken, `${archive} already exists: move it away, then run supersede again`)
  const phase = state.phase
  // Move the dir first: if the marker write then fails, the old run is still
  // out of the new run's way.
  await rename(dir, archive)
  state.phase = 'superseded'
  state.updated_at = new Date().toISOString()
  await writeFile(join(archive, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  return `${JSON.stringify({ superseded: pr, phase, head_sha: state.head_sha, archive })}\n`
}

function setValue(key: string, raw: string): unknown {
  switch (key) {
    case 'round':
      refuse(/^[0-9]+$/.test(raw) && Number(raw) > 0, `round must be a positive whole number, got "${raw}"`)
      return Number(raw)
    case 'head_sha':
      refuse(isSha(raw), `head_sha must be 40 hex characters, got "${raw}"`)
      return raw
    case 'explainer':
      refuse(raw !== '', 'explainer must be a path')
      return raw
    default:
      throw new Failure(`cannot set "${key}" (settable: ${SETTABLE.join(', ')})`, 1)
  }
}

async function dispatch(argv: string[]): Promise<string> {
  const [command, ...rest] = argv
  const { values, positionals } = parse(rest, OPTIONS, usage, true)
  const pr = positive('pr', values.pr, usage)
  const arity = (n: number) => {
    if (positionals.length !== n) throw usage(`${command} takes ${n} argument(s) after the options`)
  }

  switch (command) {
    case 'path':
      arity(0)
      return `${runDir(pr)}\n`
    case 'create':
      arity(0)
      return create(pr, values)
    case 'read': {
      if (positionals.length > 1) throw usage('read takes at most one key')
      const state = await loadState(pr)
      const [key] = positionals
      if (key === undefined) return `${JSON.stringify(state, null, 2)}\n`
      refuse(key in FIELDS, `unknown key "${key}"`)
      const value = (state as Record<string, unknown>)[key]
      return `${typeof value === 'string' ? value : JSON.stringify(value)}\n`
    }
    case 'advance': {
      arity(1)
      const phase = positionals[0] ?? ''
      if (!isOneOf(PHASES, phase)) throw new Failure(`unknown phase "${phase}" (${PHASES.join(', ')})`, 1)
      const state = await loadState(pr)
      // A resumed step may repeat its advance: already there is success.
      if (state.phase === phase) return ''
      advance(state, phase)
      if (phase === 'stopped') await announceStop(state, values.config, 'The review stopped: the re-checker failed twice')
      state.updated_at = new Date().toISOString()
      await saveState(state)
      return ''
    }
    case 'supersede':
      arity(0)
      return supersede(pr)
    case 'next-round': {
      arity(0)
      const max = positive('max-rounds', values['max-rounds'], usage)
      const state = await loadState(pr)
      refuse(state.phase === 'rechecked', `next-round needs phase rechecked, but PR #${pr} is at ${state.phase}`)
      if (state.round < max) {
        state.round += 1
        state.phase = 'review-posted'
      } else {
        await announceStop(state, values.config, `The review stopped: the gate did not pass in ${state.round} round(s)`)
        state.phase = 'stopped'
      }
      state.updated_at = new Date().toISOString()
      await saveState(state)
      return `${JSON.stringify({ round: state.round, phase: state.phase })}\n`
    }
    case 'set': {
      arity(2)
      const [key = '', raw = ''] = positionals
      const value = setValue(key, raw)
      await update(pr, (state) => {
        ;(state as Record<string, unknown>)[key] = value
      })
      return ''
    }
    default:
      throw usage(`unknown command "${command ?? ''}"`)
  }
}

export const main = runMain('run-state', dispatch)
