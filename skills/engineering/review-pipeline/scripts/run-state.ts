// `review.ts run-state <path|create|read|advance|set|next-round> --pr <N> ...`: the
// per-PR checkpoint that lets an interrupted pipeline run resume without
// repeating a step that already reached GitHub.
//
// The run dir is `${HERO_POCOCK_STATE_DIR:-<git common dir>/hero-pocock}/pr-<N>/`.
// It holds `state.json` plus the pipeline's own files (briefs, reviewer
// output, the review payload). `phase` is the last completed checkpoint.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Failure, parse, positive, refuse, runMain, usageFor } from './cli.ts'

export const PHASES = [
  'created',
  'review-dispatched',
  'review-posted',
  'adjudicated',
  'rechecked',
  'verdict-posted',
  'body-rewritten',
  'ready',
  'explained',
  'merged',
  'complete',
  'aborted',
  'stopped',
] as const
export type Phase = (typeof PHASES)[number]
const TERMINAL: readonly Phase[] = ['complete', 'aborted', 'stopped']
export const MODES = ['single', 'layer', 'stack-final'] as const
export type Mode = (typeof MODES)[number]
export const RUNTIMES = ['codex', 'claude'] as const
export type Runtime = (typeof RUNTIMES)[number]
export const KINDS = ['review', 'recheck', 'verdict'] as const
export type Kind = (typeof KINDS)[number]
const SETTABLE = ['round', 'head_sha', 'reviewer_login', 'explainer']

// `includes` for a const list, narrowing the value to the list's type.
export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return (list as readonly unknown[]).includes(value)
}

export type ReviewRecord = { round: number; kind: Kind; id: number; commit: string; as: string }

export type State = {
  schema: 1
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
  schema: (v) => v === 1,
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
  explainer: (v) => v === null || isText(v),
  created_at: isText,
  updated_at: isText,
}

function isReviewRecord(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    isPositiveInt(r.round) && isOneOf(KINDS, r.kind) && isPositiveInt(r.id) && isSha(r.commit) && isText(r.as)
  )
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
  const override = process.env.HERO_POCOCK_STATE_DIR
  if (override !== undefined && override !== '') return override
  const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' })
  refuse(git.status === 0, 'not inside a git repository (or set HERO_POCOCK_STATE_DIR)')
  return join(git.stdout.trim(), 'hero-pocock')
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

const USAGE = `usage:
  review.ts run-state path    --pr N
  review.ts run-state create  --pr N --repo O/R --base <ref> --head <ref> --head-sha <sha>
                              --runtime codex|claude --reviewer-login <slug[bot]|none>
                              [--mode single|layer|stack-final] [--force]
  review.ts run-state read    --pr N [<key>]
  review.ts run-state advance --pr N <phase>
  review.ts run-state set     --pr N <key> <value>    (key: ${SETTABLE.join(' | ')})
  review.ts run-state next-round --pr N --max-rounds M  (after a failed re-check: next round, or stopped)`

const usage = usageFor(USAGE)

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
} as const

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
    schema: 1,
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
    explainer: null,
    created_at: now,
    updated_at: now,
  }

  if (values.force !== true) {
    try {
      const old = await loadState(pr)
      refuse(TERMINAL.includes(old.phase), `run in flight for PR #${pr} (phase ${old.phase}): resume it, or create --force`)
    } catch (error) {
      if (!(error instanceof Failure) || error.code !== 3) throw error
    }
  }
  await saveState(state)
  return `${JSON.stringify(state, null, 2)}\n`
}

function setValue(key: string, raw: string): unknown {
  switch (key) {
    case 'round':
      refuse(/^[0-9]+$/.test(raw) && Number(raw) > 0, `round must be a positive whole number, got "${raw}"`)
      return Number(raw)
    case 'head_sha':
      refuse(isSha(raw), `head_sha must be 40 hex characters, got "${raw}"`)
      return raw
    case 'reviewer_login':
      refuse(isLogin(raw), `reviewer_login must be "none" or <slug>[bot], got "${raw}"`)
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
      await update(pr, (state) => {
        refuse(!TERMINAL.includes(state.phase), `run for PR #${pr} is ${state.phase} (terminal): create a new run`)
        state.phase = phase
      })
      return ''
    }
    case 'next-round': {
      arity(0)
      const max = positive('max-rounds', values['max-rounds'], usage)
      let result = {}
      await update(pr, (state) => {
        refuse(state.phase === 'rechecked', `next-round needs phase rechecked, but PR #${pr} is at ${state.phase}`)
        if (state.round < max) {
          state.round += 1
          state.phase = 'review-posted'
        } else {
          state.phase = 'stopped'
        }
        result = { round: state.round, phase: state.phase }
      })
      return `${JSON.stringify(result)}\n`
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
