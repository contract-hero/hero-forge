// `review.ts resolve-base <prepare|record> --repo O/R --pr N` (usage in the
// table in cli.ts): Finish's way past a merge conflict that only the version
// bump and the CHANGELOG entry cause. Parallel PRs each bump the version and
// add an entry, so the first to merge makes every other one conflict there.
//
//   prepare  in the worktree at the run's head: fetch the base branch, merge
//            it, resolve the version file and CHANGELOG.md, and move the
//            checked-out branch to the merge commit. Any other conflict, or a
//            version or CHANGELOG change it cannot read, refuses with nothing
//            changed. The caller runs the tests, then pushes as the PR author.
//   record   the re-check of the pushed merge commit: GitHub's head must be
//            that commit, its parents the run's head and a commit of the base
//            branch, and its tree exactly the one `prepare` computes from
//            those parents. Then (with the reviewer App) it posts the gate
//            status at the new head, records a gate pass there, pins it as
//            the run's head, and moves the run back to `ready`, so Finish
//            approves the new head before it merges.
//
// The resolution is one deterministic function of the two parents, so the
// re-check computes it again instead of trusting the commit.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Failure, parse, positive, refuse, repoOption, runMain, usageFor } from './cli.ts'
import { appLogin, configApp } from './finish.ts'
import { postGateStatus } from './gate-status.ts'
import { gh, json, oneLine } from './github.ts'
import { latestGate, loadState, runDir, saveState, usesApp, type Phase, type State } from './run-state.ts'

const usage = usageFor('resolve-base')

// The files that may hold the one version, in the order they are tried: the
// first one the base branch has, with a top-level string `version`, is it.
export const VERSION_FILES = ['.claude-plugin/plugin.json', 'package.json']
export const CHANGELOG = 'CHANGELOG.md'

// The Finish phases a resolution may start from: the merge gate runs after
// the explainer, and a resumed run may be a step earlier.
const FROM: readonly Phase[] = ['ready', 'verdict-posted', 'explained']

type Git = { ok: boolean; out: string; err: string }

function git(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): Git {
  const r = spawnSync('git', ['-c', 'merge.conflictStyle=merge', ...args], {
    encoding: 'utf8',
    input: options.input ?? '',
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  })
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' }
}

function mustGit(args: string[], what: string, options: { input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const r = git(args, options)
  if (!r.ok) throw new Failure(`${what}: ${oneLine(r.err) || 'git failed'}`, 1)
  return r.out.trim()
}

// The text of `path` at `rev`, or undefined when it has no such file.
function show(rev: string, path: string): string | undefined {
  const r = git(['cat-file', 'blob', `${rev}:${path}`])
  return r.ok ? r.out : undefined
}

function topObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function topVersion(text: string | undefined): string | undefined {
  const version = topObject(text)?.version
  return typeof version === 'string' ? version : undefined
}

// The file's JSON with its top-level version left out, to compare the rest.
function withoutVersion(text: string): Record<string, unknown> | undefined {
  const value = topObject(text)
  if (value === undefined) return undefined
  const { version: _version, ...rest } = value
  return rest
}

export function nextPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  refuse(m !== null, `the base branch's version ${version} is not MAJOR.MINOR.PATCH: resolve the conflict by hand`)
  const [, major, minor, patch] = m as RegExpExecArray
  return `${major}.${minor}.${Number(patch) + 1}`
}

// A line that holds the `"version"` property and nothing else.
const VERSION_LINE = /^(\s*"version"\s*:\s*")([^"]*)("\s*,?\s*)$/
const lines = (text: string) => text.split(/(?<=\n)/)

// The merged version file with each conflict hunk resolved. Every hunk must
// hold only a `"version"` line on both sides: any other conflicting line in
// the file is the PR's own change, and a human decides it. Then the version
// is set to `version`. The file read with every hunk on the PR's side, and
// read with every hunk on the base's side, must equal the result in all but
// the top-level version: so no other property, top-level or nested, is lost.
export function resolveVersionFile(merged: string, version: string, path: string): string {
  const out: string[] = []
  const ownSide: string[] = []
  const baseSide: string[] = []
  let side: 'none' | 'ours' | 'base' | 'theirs' = 'none'
  let ours: string[] = []
  let theirs: string[] = []
  for (const line of lines(merged)) {
    if (side === 'none') {
      if (/^<{7}(?: |\n|$)/.test(line)) {
        side = 'ours'
        ours = []
        theirs = []
      } else {
        out.push(line)
        ownSide.push(line)
        baseSide.push(line)
      }
    } else if (/^\|{7}(?: |\n|$)/.test(line) && side === 'ours') side = 'base'
    else if (/^={7}\n?$/.test(line) && side !== 'theirs') side = 'theirs'
    else if (/^>{7}(?: |\n|$)/.test(line) && side === 'theirs') {
      const onlyVersion = (part: string[]) => part.length === 1 && VERSION_LINE.test((part[0] as string).replace(/\n$/, ''))
      refuse(
        onlyVersion(ours) && onlyVersion(theirs),
        `${path} conflicts with the base branch on more than its version line: resolve the conflict by hand`,
      )
      out.push(theirs[0] as string)
      ownSide.push(...ours)
      baseSide.push(...theirs)
      side = 'none'
    } else if (side === 'ours') ours.push(line)
    else if (side === 'theirs') theirs.push(line)
  }
  refuse(side === 'none', `${path} has an unterminated conflict hunk: resolve the conflict by hand`)
  const current = topVersion(out.join(''))
  refuse(current !== undefined, `${path} is not JSON with a top-level version after the merge: resolve the conflict by hand`)
  const hits = out.map((line, i) => [i, VERSION_LINE.exec(line.replace(/\n$/, ''))] as const).filter(([, m]) => m?.[2] === current)
  refuse(hits.length === 1, `${path} has ${hits.length} "version" lines with the value ${current}, not one: resolve the conflict by hand`)
  const [index, match] = hits[0] as readonly [number, RegExpExecArray]
  out[index] = `${match[1]}${version}${match[3]}${(out[index] as string).endsWith('\n') ? '\n' : ''}`
  const text = out.join('')
  refuse(topVersion(text) === version, `${path} does not read version ${version} after the resolution: resolve the conflict by hand`)
  const rest = withoutVersion(text)
  refuse(
    isDeepStrictEqual(withoutVersion(ownSide.join('')), rest) && isDeepStrictEqual(withoutVersion(baseSide.join('')), rest),
    `${path} conflicts with the base branch on more than its top-level version: resolve the conflict by hand`,
  )
  return text
}

// The base branch's CHANGELOG with the PR's own entry on top, under
// `version`. The PR's change must be exactly one new `## ` section at the top
// of the file: anything else (an edited older entry, two new entries) is for
// a human.
export function resolveChangelog(pr: string, mergeBase: string, base: string, version: string): string {
  const own = lines(pr)
  const start = own.findIndex((line) => line.startsWith('## '))
  refuse(start >= 0, `${CHANGELOG} on the PR has no "## " entry: resolve the conflict by hand`)
  let end = own.findIndex((line, i) => i > start && line.startsWith('## '))
  if (end < 0) end = own.length
  refuse(
    [...own.slice(0, start), ...own.slice(end)].join('') === mergeBase,
    `the PR's change to ${CHANGELOG} is not one new entry at the top: resolve the conflict by hand`,
  )
  const entry = [`## ${version}\n`, ...own.slice(start + 1, end)]
  const theirs = lines(base)
  let at = theirs.findIndex((line) => line.startsWith('## '))
  if (at < 0) at = theirs.length
  return [...theirs.slice(0, at), ...entry, ...theirs.slice(at)].join('')
}

export type Resolution = { tree: string; base: string; version: string; version_file: string; files: string[] }

// The resolved tree of merging `base` into `head`, computed from the two
// commits alone: no worktree, no index of the caller's.
function resolution(head: string, base: string): Resolution {
  const mergeBase = mustGit(['merge-base', head, base], `no merge base between ${head} and ${base}`)
  const versionFile = VERSION_FILES.find((path) => topVersion(show(base, path)) !== undefined)
  refuse(versionFile !== undefined, `the base branch has no version file (${VERSION_FILES.join(', ')}): resolve the conflict by hand`)
  const file = versionFile as string
  const baseVersion = topVersion(show(base, file)) as string
  const ownVersion = topVersion(show(head, file))
  const oldVersion = topVersion(show(mergeBase, file))
  refuse(
    ownVersion !== undefined && oldVersion !== undefined && ownVersion !== oldVersion,
    `the PR does not bump the version in ${file}: resolve the conflict by hand`,
  )
  const version = nextPatch(baseVersion)

  const merged = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', head, base])
  refuse(merged.ok || merged.out !== '', `git merge-tree failed: ${oneLine(merged.err)}`)
  const [tree = '', ...rest] = merged.out.split('\0')
  const files = [...new Set(rest.filter((path) => path !== ''))].sort()
  refuse(/^[0-9a-f]{40,64}$/.test(tree), `git merge-tree printed no tree: ${oneLine(merged.err)}`)
  refuse(files.length > 0, 'the PR merges with the base branch with no conflict: there is nothing to resolve')
  const other = files.filter((path) => path !== file && path !== CHANGELOG)
  refuse(
    other.length === 0,
    `the PR conflicts with the base branch in files other than ${file} and ${CHANGELOG}: ${other.join(', ')}. A human resolves it`,
  )

  const blobs: Record<string, string> = {}
  blobs[file] = resolveVersionFile(show(tree, file) ?? '', version, file)
  const ownLog = show(head, CHANGELOG)
  const oldLog = show(mergeBase, CHANGELOG)
  if (ownLog !== undefined && ownLog !== oldLog) {
    const baseLog = show(base, CHANGELOG)
    refuse(oldLog !== undefined && baseLog !== undefined, `${CHANGELOG} is new on one side: resolve the conflict by hand`)
    blobs[CHANGELOG] = resolveChangelog(ownLog, oldLog as string, baseLog as string, version)
  } else refuse(!files.includes(CHANGELOG), `${CHANGELOG} conflicts, but the PR does not change it: resolve the conflict by hand`)

  return { tree: writeTree(tree, blobs), base, version, version_file: file, files }
}

// `tree` with each path's text replaced, written through a temp index.
function writeTree(tree: string, blobs: Record<string, string>): string {
  const index = join(tmpdir(), `hero-forge-resolve-${randomBytes(6).toString('hex')}.index`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  try {
    mustGit(['read-tree', tree], 'cannot read the merged tree', { env })
    for (const [path, text] of Object.entries(blobs)) {
      const listed = mustGit(['ls-tree', tree, '--', path], `cannot list ${path}`)
      const mode = /^(\d{6}) blob /.exec(listed)?.[1] ?? '100644'
      const blob = mustGit(['hash-object', '-w', '--stdin'], `cannot store ${path}`, { input: text })
      mustGit(['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], `cannot stage ${path}`, { env })
    }
    return mustGit(['write-tree'], 'cannot write the resolved tree', { env })
  } finally {
    rmSync(index, { force: true })
  }
}

type Args = { repo: string; pr: number; commit?: string; config?: string }

async function stateFor(args: Args): Promise<State> {
  const state = await loadState(args.pr)
  refuse(state.repo === args.repo, `the run state for PR #${args.pr} is for ${state.repo}, not ${args.repo}`)
  refuse(state.mode === 'single', `the run for PR #${args.pr} is in ${state.mode} mode: the stack lands its layers, resolve-base does not`)
  return state
}

// The run must be in Finish, with a passing gate at its head.
function refuseOutsideFinish(state: State): void {
  refuse(FROM.includes(state.phase), `resolve-base runs in Finish (phase ${FROM.join(', ')}), but PR #${state.pr} is at ${state.phase}`)
  refuse(
    latestGate(state, state.head_sha)?.result === 'pass',
    `no passing gate is recorded at the run's head ${state.head_sha}: resolve-base merges only a head that passed`,
  )
}

// The base branch's tip on GitHub, fetched.
function fetchBase(state: State): string {
  mustGit(['fetch', '-q', 'origin', state.base_ref], `cannot fetch ${state.base_ref} from origin`)
  return mustGit(['rev-parse', '--verify', `refs/remotes/origin/${state.base_ref}^{commit}`], `no origin/${state.base_ref} after the fetch`)
}

async function prepare(args: Args): Promise<string> {
  const state = await stateFor(args)
  refuseOutsideFinish(state)
  const head = mustGit(['rev-parse', 'HEAD'], 'cannot read HEAD')
  refuse(head === state.head_sha, `HEAD is ${head}, not the run's head ${state.head_sha}: check out the PR head first`)
  const branch = git(['symbolic-ref', '-q', '--short', 'HEAD'])
  refuse(branch.ok, 'HEAD is detached: check out a branch at the PR head first')
  refuse(mustGit(['status', '--porcelain', '--untracked-files=no'], 'cannot read the worktree status') === '', 'the worktree has uncommitted changes: commit or drop them first')
  const base = fetchBase(state)
  const resolved = resolution(head, base)
  const message = `Merge ${state.base_ref} into ${state.head_ref}: version ${resolved.version}\n\nresolve-base resolved the conflict in ${resolved.files.join(', ')}.\n`
  const commit = mustGit(['commit-tree', resolved.tree, '-p', head, '-p', base, '-F', '-'], 'cannot write the merge commit', { input: message })
  mustGit(['merge', '-q', '--ff-only', commit], `cannot move ${branch.out.trim()} to the merge commit`)
  const { tree: _tree, ...shown } = resolved
  return `${JSON.stringify({ commit, branch: branch.out.trim(), ...shown })}\n`
}

async function record(args: Args): Promise<string> {
  const commit = args.commit
  if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) throw usage('--commit must be the full sha of the pushed merge commit')
  const app = await configApp(args.config)
  const state = await stateFor(args)
  if (state.head_sha === commit && state.phase === 'ready' && latestGate(state, commit)?.result === 'pass') {
    return `${JSON.stringify({ commit, phase: state.phase, already: true })}\n`
  }
  refuseOutsideFinish(state)
  refuse(
    app === usesApp(state),
    `the config ${app ? 'enables' : 'does not enable'} the reviewer App, but the run state for PR #${args.pr} has reviewer_login ${state.reviewer_login}`,
  )

  const viewed = await gh(['pr', 'view', String(args.pr), '--repo', args.repo, '--json', 'headRefOid'])
  refuse(viewed.code === 0, `cannot read PR #${args.pr}: ${oneLine(viewed.stderr)}`)
  const onGitHub = json<{ headRefOid: string }>(viewed.stdout, 'pr view').headRefOid
  refuse(onGitHub === commit, `PR #${args.pr} is at ${onGitHub} on GitHub, not ${commit}: push the merge commit first`)

  const tip = fetchBase(state)
  refuse(git(['cat-file', '-e', `${commit}^{commit}`]).ok, `no commit ${commit} in this repo: fetch the PR head first`)
  const parents = mustGit(['rev-list', '--parents', '-n', '1', commit], `cannot read the parents of ${commit}`).split(' ').slice(1)
  refuse(
    parents.length === 2 && parents[0] === state.head_sha,
    `${commit} is not a merge commit on the run's head ${state.head_sha}: its parents are ${parents.join(', ') || 'none'}`,
  )
  const base = parents[1] as string
  refuse(git(['merge-base', '--is-ancestor', base, tip]).ok, `the merged parent ${base} is not on ${state.base_ref}`)
  const resolved = resolution(state.head_sha, base)
  const tree = mustGit(['rev-parse', `${commit}^{tree}`], `cannot read the tree of ${commit}`)
  refuse(
    tree === resolved.tree,
    `${commit} is not the plain resolution of the merge with ${base}: it changes more than ${resolved.version_file} and ${CHANGELOG}`,
  )

  const old = state.head_sha
  const moved: State = { ...state, head_sha: commit }
  // The status goes first: a failed post leaves the run where it was.
  if (await appLogin(args.repo, app)) {
    await postGateStatus(moved, 'success', `Gate passed: the merge of ${state.base_ref} changes only the version and the changelog`)
  }
  const { tree: _tree, ...shown } = resolved
  await writeFile(
    join(runDir(args.pr), `resolve-base-${commit.slice(0, 7)}.json`),
    `${JSON.stringify({ from: old, commit, ...shown }, null, 2)}\n`,
  )
  moved.gates = [...state.gates, { round: state.round, commit, result: 'pass' }]
  moved.phase = 'ready'
  moved.updated_at = new Date().toISOString()
  await saveState(moved)
  return `${JSON.stringify({ commit, from: old, phase: 'ready', ...shown })}\n`
}

async function dispatch(argv: string[]): Promise<string> {
  const [command, ...rest] = argv
  const { values } = parse(
    rest,
    { repo: { type: 'string' }, pr: { type: 'string' }, commit: { type: 'string' }, config: { type: 'string' } },
    usage,
  )
  const args: Args = { repo: repoOption(values.repo, usage), pr: positive('pr', values.pr, usage), commit: values.commit, config: values.config }
  switch (command) {
    case 'prepare':
      if (args.commit !== undefined) throw usage('prepare takes no --commit')
      return prepare(args)
    case 'record':
      return record(args)
    default:
      throw usage(`unknown command "${command ?? ''}"`)
  }
}

export const main = runMain('resolve-base', dispatch)
