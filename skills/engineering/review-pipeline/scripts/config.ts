// `review.ts config [--config <path>]`: read docs/agents/review.md, validate
// its one YAML block, apply defaults, print the resolved config as JSON.
//
// The block is a small YAML subset, parsed by hand. This is the whole grammar:
//   top     KEY: SCALAR        column 0; runtime | pairs | max_rounds | app
//   open    KEY:               column 0; orchestrator | reviewer; opens a map
//   nested    KEY: SCALAR      exactly 2 spaces; model | effort; inside a map
//   SCALAR  [A-Za-z0-9._-]+ | "..." | '...'
// plus blank lines, `#` comment lines, and ` # ...` after a value. Nothing else.
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const PREFIX = 'review.ts config: '

type Runtime = 'codex' | 'claude'

const DEFAULTS: Record<Runtime, Record<RoleName, { model: string; effort: string }>> = {
  codex: { orchestrator: { model: 'gpt-6-astra', effort: 'low' }, reviewer: { model: 'gpt-6.1-sol', effort: 'high' } },
  claude: {
    orchestrator: { model: 'claude-opus-5-5', effort: 'medium' },
    reviewer: { model: 'claude-sonnet-5-5', effort: 'high' },
  },
}

// Codex accepts these at the API level; whether a given model supports one is
// checked by Codex at call time. Claude: the sub-agent effort values.
const EFFORTS: Record<Runtime, string[]> = {
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
}

const AGENT_MODELS = ['opus', 'sonnet', 'haiku', 'fable']

type RoleName = 'orchestrator' | 'reviewer'
const ROLES: RoleName[] = ['orchestrator', 'reviewer']
const TOP_KEYS = ['runtime', 'pairs', 'max_rounds', 'app']
const ROLE_KEYS = ['model', 'effort']

// A value from the block, with its 1-based line in the file.
type Value = { text: string; quoted: boolean; line: number }

type Parsed = {
  top: Map<string, Value>
  roles: Map<RoleName, Map<string, Value>>
}

// Thrown for anything wrong with the file's contents (exit 4).
class Invalid extends Error {
  line: number | undefined
  constructor(reason: string, line?: number) {
    super(reason)
    this.line = line
  }
}

const SCALAR = String.raw`[A-Za-z0-9._-]+|"[^"\\]*"|'[^']*'`
const TRAIL = String.raw`(?:[ ]+#.*)?`
const TOP = new RegExp(String.raw`^([a-z_]+):[ ]+(${SCALAR})${TRAIL}$`)
const OPEN = new RegExp(String.raw`^([a-z_]+):${TRAIL}$`)
const NESTED = new RegExp(String.raw`^  ([a-z_]+):[ ]+(${SCALAR})${TRAIL}$`)

function scalar(raw: string, line: number): Value {
  const quoted = raw.startsWith('"') || raw.startsWith("'")
  return { text: quoted ? raw.slice(1, -1) : raw, quoted, line }
}

// Find the one ```yaml block; return its lines with their file line numbers.
function findBlock(text: string): { text: string; line: number }[] {
  const lines = text.split(/\r?\n/)
  let found: { text: string; line: number }[] | undefined
  for (let i = 0; i < lines.length; i++) {
    if (!/^```ya?ml\s*$/.test(lines[i] ?? '')) continue
    if (found !== undefined) throw new Invalid('more than one ```yaml block (keep exactly one)', i + 1)
    const open = i
    const body: { text: string; line: number }[] = []
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i] ?? ''); i++) body.push({ text: lines[i] ?? '', line: i + 1 })
    if (i >= lines.length) throw new Invalid('the ```yaml block is never closed', open + 1)
    found = body
  }
  if (found === undefined) throw new Invalid('no ```yaml block found')
  return found
}

function parse(text: string): Parsed {
  const parsed: Parsed = { top: new Map(), roles: new Map() }
  let open: Map<string, Value> | undefined
  let openName = ''
  for (const { text: line, line: n } of findBlock(text)) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    if (/^\s*\t/.test(line)) throw new Invalid('tab indentation (indent with 2 spaces)', n)
    let m: RegExpExecArray | null
    if ((m = NESTED.exec(line))) {
      const [, key = '', raw = ''] = m
      if (open === undefined) throw new Invalid(`indented line outside orchestrator or reviewer`, n)
      if (!ROLE_KEYS.includes(key)) throw new Invalid(`unknown key ${openName}.${key} (model or effort)`, n)
      if (open.has(key)) throw new Invalid(`duplicate key ${openName}.${key}`, n)
      open.set(key, scalar(raw, n))
    } else if ((m = TOP.exec(line))) {
      const [, key = '', raw = ''] = m
      open = undefined
      if ((ROLES as string[]).includes(key)) throw new Invalid(`${key} must be a map (put model and effort on indented lines)`, n)
      if (!TOP_KEYS.includes(key)) throw new Invalid(`unknown key ${key}`, n)
      if (parsed.top.has(key)) throw new Invalid(`duplicate key ${key}`, n)
      parsed.top.set(key, scalar(raw, n))
    } else if ((m = OPEN.exec(line))) {
      const [, key = ''] = m
      if (TOP_KEYS.includes(key)) throw new Invalid(`${key} needs a value`, n)
      if (!(ROLES as string[]).includes(key)) throw new Invalid(`unknown key ${key}`, n)
      const role = key as RoleName
      if (parsed.roles.has(role)) throw new Invalid(`duplicate key ${role}`, n)
      open = new Map()
      openName = role
      parsed.roles.set(role, open)
    } else {
      throw new Invalid('line is outside the supported YAML subset (KEY: value, or a 2-space indented model/effort)', n)
    }
  }
  return parsed
}

function count(name: string, value: Value | undefined): number {
  if (value === undefined) return 2
  if (value.quoted || !/^[0-9]+$/.test(value.text)) {
    throw new Invalid(`${name} must be a whole number, got "${value.text}"`, value.line)
  }
  const n = Number(value.text)
  if (n < 1) throw new Invalid(`${name} must be 1 or more, got ${n}`, value.line)
  return n
}

function isClaudeModel(model: string): boolean {
  return model.startsWith('claude-') || AGENT_MODELS.includes(model)
}

function agentModel(model: string, where: string, line: number | undefined): string {
  if (AGENT_MODELS.includes(model)) return model
  const family = /^claude-([a-z]+)(?:-|$)/.exec(model)?.[1]
  if (family !== undefined && AGENT_MODELS.includes(family)) return family
  throw new Invalid(`cannot map ${where} "${model}" to a sub-agent model (${AGENT_MODELS.join('|')})`, line)
}

function resolveConfig(path: string, parsed: Parsed) {
  const runtimeValue = parsed.top.get('runtime')
  if (runtimeValue === undefined) throw new Invalid('runtime is missing (codex or claude)')
  if (runtimeValue.text !== 'codex' && runtimeValue.text !== 'claude') {
    throw new Invalid(`unknown runtime "${runtimeValue.text}" (codex or claude)`, runtimeValue.line)
  }
  const runtime: Runtime = runtimeValue.text
  const pairs = count('pairs', parsed.top.get('pairs'))
  const maxRounds = count('max_rounds', parsed.top.get('max_rounds'))
  const appValue = parsed.top.get('app')
  if (appValue !== undefined && appValue.text !== 'enabled') {
    throw new Invalid(`app must be "enabled" or left out, got "${appValue.text}"`, appValue.line)
  }

  const roles = ROLES.map((role) => {
    const given = parsed.roles.get(role) ?? new Map<string, Value>()
    const modelValue = given.get('model')
    const effortValue = given.get('effort')
    const model = modelValue?.text ?? DEFAULTS[runtime][role].model
    const effort = effortValue?.text ?? DEFAULTS[runtime][role].effort
    if (!EFFORTS[runtime].includes(effort)) {
      throw new Invalid(
        `${role}.effort "${effort}" is not a ${runtime} effort (${EFFORTS[runtime].join(', ')})`,
        effortValue?.line,
      )
    }
    const claude = isClaudeModel(model)
    if (runtime === 'codex' && claude) {
      throw new Invalid(`mixed runtime: runtime is codex but ${role}.model "${model}" is a Claude model`, modelValue?.line)
    }
    if (runtime === 'claude' && !claude) {
      throw new Invalid(`mixed runtime: runtime is claude but ${role}.model "${model}" is not a Claude model`, modelValue?.line)
    }
    const agent = runtime === 'claude' ? agentModel(model, `${role}.model`, modelValue?.line) : null
    return { model, effort, agent_model: agent }
  })

  return {
    config_path: path,
    runtime,
    pairs,
    orchestrator: roles[0],
    reviewer: roles[1],
    max_rounds: maxRounds,
    app: appValue !== undefined,
  }
}

function fail(message: string, code: number): number {
  process.stderr.write(`${PREFIX}${message}\n`)
  return code
}

function defaultPath(): string {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  const root = git.status === 0 ? git.stdout.trim() : process.cwd()
  return resolve(root, 'docs/agents/review.md')
}

export type ResolvedConfig = ReturnType<typeof resolveConfig>

// Read, check and resolve a review config. `path` undefined means the default
// location. A failure carries the message and exit code `config` itself uses
// (1 unreadable, 3 missing, 4 invalid).
export async function loadConfig(
  path: string | undefined,
): Promise<{ ok: true; config: ResolvedConfig } | { ok: false; code: number; message: string }> {
  const file = path === undefined ? defaultPath() : resolve(path)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { ok: false, code: 3, message: `no review config at ${file}. Tell the user to run /setup-review-pipeline.` }
    }
    return { ok: false, code: 1, message: `cannot read ${file}: ${(error as Error).message}` }
  }
  try {
    return { ok: true, config: resolveConfig(file, parse(text)) }
  } catch (error) {
    if (!(error instanceof Invalid)) throw error
    const where = error.line === undefined ? file : `${file}:${error.line}`
    return { ok: false, code: 4, message: `${where}: ${error.message}. Edit the file or re-run /setup-review-pipeline.` }
  }
}

export async function main(argv: string[]): Promise<number> {
  let path: string | undefined
  try {
    const { values } = parseArgs({ args: argv, options: { config: { type: 'string' } }, strict: true })
    path = values.config
  } catch (error) {
    return fail(`${(error as Error).message}\nusage: review.ts config [--config <path>]`, 2)
  }
  const loaded = await loadConfig(path)
  if (!loaded.ok) return fail(loaded.message, loaded.code)
  process.stdout.write(`${JSON.stringify(loaded.config, null, 2)}\n`)
  return 0
}
