// `review.ts implementer` (usage in the table in cli.ts).
// Act as the Implementer App with no token in the agent's hands: each verb
// mints the App's installation token in this process, uses it, and prints
// only what it did. `push` pushes a local branch (with --force-with-lease, a
// restacked one), `pr` opens a draft pull request (so the App is its author),
// `comment` posts one comment on an issue or a pull request, and `label` adds
// or removes one label there.
//
// Exit 3: the config has no `implementer.app: enabled` (the Implementer App's
// own switch, apart from the reviewer App's `app: enabled`), so the caller
// pushes and posts as the user.
// Exit 4: the config is invalid, or the App is enabled but broken. Nothing is
// pushed or posted, as the App or as the user.
//
// Every text it posts goes through the marker refusal and the secret scan
// first. Errors never carry the token.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Failure, parse, positive, refuse, repoOption, runMain, usageFor } from './cli.ts'
import { loadConfig } from './config.ts'
import { appIdentity, gh, json, oneLine, type Identity } from './github.ts'
import { refuseMarkerIn } from './marker.ts'
import { refuseSecretsIn } from './secrets.ts'

const usage = usageFor('implementer')

const OPTIONS = {
  repo: { type: 'string' },
  config: { type: 'string' },
  branch: { type: 'string' },
  head: { type: 'string' },
  base: { type: 'string' },
  title: { type: 'string' },
  'body-file': { type: 'string' },
  issue: { type: 'string' },
  'force-with-lease': { type: 'string' },
  add: { type: 'string' },
  remove: { type: 'string' },
} as const

type Values = { [K in keyof typeof OPTIONS]?: string }

// The Implementer App, after the config check. Any config problem is broken
// (4), as in app-token: the pipeline never gets here without a valid config.
async function implementerApp(repo: string, config: string | undefined): Promise<() => Promise<Identity>> {
  const loaded = await loadConfig(config)
  if (!loaded.ok) throw new Failure(loaded.message, 4)
  if (!loaded.config.implementer.app) {
    throw new Failure('no implementer App configured for this repo (no "implementer.app: enabled" in the config): push and post as the user', 3)
  }
  return () => appIdentity(repo, 'implementer')
}

async function bodyFile(path: string | undefined): Promise<string> {
  if (path === undefined) throw usage('--body-file is required')
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new Failure(`cannot read ${path}: ${(error as Error).message}`, 1)
  }
}

type GitResult = { code: number | null; stdout: string; stderr: string }

// Run git with stdin closed. git is found through PATH, so the tests' fake
// git stands in for it.
function git(args: string[], env: NodeJS.ProcessEnv = process.env, cwd?: string): Promise<GitResult> {
  return new Promise((done, reject) => {
    const child = spawn('git', args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}

// The credential helper of the push. git runs it with the request on stdin,
// and it answers only for https://github.com, from an env var that only this
// git process has: the token is never in argv, in a file, or in git config.
// The push reads no config of the user's (see push), and the empty
// `credential.helper=` before it drops any helper all the same (gh's
// included), so the push never carries the user's credentials.
const TOKEN_VAR = 'HERO_FORGE_GIT_TOKEN'
const HELPER =
  '!f() { test "$1" = get || exit 0; while IFS= read -r line; do case "$line" in protocol=*) p="${line#protocol=}";; host=*) h="${line#host=}";; esac; done; ' +
  `test "$p" = https && test "$h" = github.com || exit 0; echo username=x-access-token; echo "password=$${TOKEN_VAR}"; }; f`

// The variables the push's git keeps from the caller's environment. Every
// other one is dropped: no GIT_* variable, proxy or TLS setting of the
// caller reaches it.
const KEEP = /^(PATH|TMPDIR|LANG|LC_[A-Z]+)$/

// The environment of git in the scratch repo: the kept variables, and that
// repo as GIT_DIR and HOME, with no system or user config, no prompt, and
// https only.
function scratchEnv(scratch: string, token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => KEEP.test(name)))
  return {
    ...env,
    GIT_DIR: scratch,
    HOME: scratch,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'https',
    ...(token === undefined ? {} : { [TOKEN_VAR]: token }),
  }
}

// Push the branch tip to the same branch on GitHub, over https (an App token
// does not work over SSH, and `origin` may be an SSH remote). The push runs
// in a scratch bare repo that borrows the worktree's objects through
// `objects/info/alternates`, so it reads no config but its own: no setting of
// the system, the user, the repo or the caller's env (a header, a URL
// rewrite, a proxy, a TLS setting) can carry another identity or reach the
// token, also when it is written after the mint. No upstream is set: the
// remote is a URL, not `origin`. Hooks are off, and no prompt or askpass can
// stand in for the App.
//
// With --force-with-lease <old tip>, the push replaces the branch on GitHub
// only while GitHub still has that tip there: a restack rewrites the layer
// branch from the tip it started at. The scratch repo has no remote-tracking
// ref, so the lease always names the tip.
async function push(repo: string, values: Values): Promise<string> {
  const branch = values.branch
  if (branch === undefined || branch === '') throw usage('--branch is required')
  const lease = values['force-with-lease']
  if (lease !== undefined && !/^[0-9a-f]{40}$/.test(lease)) throw usage('--force-with-lease must be the full sha of the old tip on GitHub')
  const app = await implementerApp(repo, values.config)
  const local = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  refuse(local.code === 0, `no local branch ${branch} in this repo: run push in the worktree that holds it`)
  const commit = local.stdout.trim()
  const common = await git(['rev-parse', '--git-common-dir'])
  refuse(common.code === 0, `cannot find the git dir of this repo: ${oneLine(common.stderr)}`)
  const objects = join(resolve(common.stdout.trim()), 'objects')

  const me = await app()
  const token = me.token as string
  // mkdtemp makes the directory mode 700: no other user can read it. The
  // real path, so git and the scratch env name the same directory.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'hero-forge-push-')))
  try {
    const made = await git(['init', '-q', '--bare', '--template=', scratch], scratchEnv(scratch), scratch)
    refuse(made.code === 0, `cannot make the scratch repo for the push: ${oneLine(made.stderr)}`)
    await mkdir(join(scratch, 'objects', 'info'), { recursive: true })
    await writeFile(join(scratch, 'objects', 'info', 'alternates'), `${objects}\n`)
    const pushed = await git(
      ['-c', 'credential.helper=', '-c', `credential.helper=${HELPER}`, '-c', 'http.extraHeader=', '-c', 'http.sslVerify=true',
        '-c', 'http.proxy=', '-c', 'core.askPass=', '-c', 'core.hooksPath=/dev/null',
        'push', ...(lease === undefined ? [] : [`--force-with-lease=refs/heads/${branch}:${lease}`]),
        `https://github.com/${repo}.git`, `${commit}:refs/heads/${branch}`],
      scratchEnv(scratch, token),
      scratch,
    )
    // git prints no credential, but its output is scrubbed of the token anyway.
    const said = oneLine(pushed.stderr || pushed.stdout).replaceAll(token, '***')
    refuse(pushed.code === 0, `GitHub refused the push of ${branch}: ${said}`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return `${JSON.stringify({ branch, commit, as: me.login })}\n`
}

async function comment(repo: string, values: Values): Promise<string> {
  const issue = positive('issue', values.issue, usage)
  const app = await implementerApp(repo, values.config)
  const text = await bodyFile(values['body-file'])
  refuse(text.trim() !== '', `${values['body-file']} is empty: there is nothing to post`)
  const post = { body: text }
  refuseMarkerIn([text], values['body-file'] as string)
  refuseSecretsIn(post, values['body-file'] as string)

  const me = await app()
  const result = await gh(['api', '-X', 'POST', `repos/${repo}/issues/${issue}/comments`, '--input', '-'], JSON.stringify(post), me.token)
  refuse(result.code === 0, `GitHub rejected the comment on #${issue}: ${oneLine(result.stderr || result.stdout)}`)
  return `${JSON.stringify({ id: json<{ id: number }>(result.stdout, 'post comment').id, as: me.login })}\n`
}

// A draft, opened with the App's token: GitHub makes the App its author, so
// the reviewer App can approve it later.
async function pr(repo: string, values: Values): Promise<string> {
  const { head, base, title } = values
  if (head === undefined || head === '') throw usage('--head is required')
  if (base === undefined || base === '') throw usage('--base is required')
  if (title === undefined || title.trim() === '') throw usage('--title is required')
  const app = await implementerApp(repo, values.config)
  const body = await bodyFile(values['body-file'])
  const post = { title, head, base, body, draft: true }
  refuseMarkerIn([title], '--title')
  refuseMarkerIn([body], values['body-file'] as string)
  refuseSecretsIn({ title }, '--title')
  refuseSecretsIn(post, values['body-file'] as string)

  const me = await app()
  const result = await gh(['api', '-X', 'POST', `repos/${repo}/pulls`, '--input', '-'], JSON.stringify(post), me.token)
  refuse(result.code === 0, `GitHub rejected the pull request: ${oneLine(result.stderr || result.stdout)}`)
  const opened = json<{ number: number; html_url: string }>(result.stdout, 'create pull request')
  return `${JSON.stringify({ number: opened.number, url: opened.html_url, as: me.login })}\n`
}

// Add or remove one label on an issue or a PR. Removing a label that is not
// there (GitHub's 404) is not an error: a resumed run may repeat it.
async function label(repo: string, values: Values): Promise<string> {
  const issue = positive('issue', values.issue, usage)
  if ((values.add === undefined) === (values.remove === undefined)) throw usage('label needs one of --add and --remove')
  const name = (values.add ?? values.remove ?? '').trim()
  if (name === '') throw usage('the label name is empty')
  const app = await implementerApp(repo, values.config)
  const me = await app()
  if (values.add !== undefined) {
    const result = await gh(['api', '-X', 'POST', `repos/${repo}/issues/${issue}/labels`, '--input', '-'], JSON.stringify({ labels: [name] }), me.token)
    refuse(result.code === 0, `GitHub rejected the label ${name} on #${issue}: ${oneLine(result.stderr || result.stdout)}`)
    return `${JSON.stringify({ issue, label: name, added: true, as: me.login })}\n`
  }
  const result = await gh(['api', '-X', 'DELETE', `repos/${repo}/issues/${issue}/labels/${encodeURIComponent(name)}`], '', me.token)
  const absent = result.code !== 0 && /HTTP 404/.test(result.stderr)
  refuse(result.code === 0 || absent, `GitHub rejected the removal of the label ${name} on #${issue}: ${oneLine(result.stderr || result.stdout)}`)
  return `${JSON.stringify({ issue, label: name, removed: !absent, as: me.login })}\n`
}

async function dispatch(argv: string[]): Promise<string> {
  const [command, ...rest] = argv
  const { values } = parse(rest, OPTIONS, usage)
  const repo = repoOption(values.repo, usage)
  switch (command) {
    case 'push':
      return push(repo, values)
    case 'pr':
      return pr(repo, values)
    case 'comment':
      return comment(repo, values)
    case 'label':
      return label(repo, values)
    default:
      throw usage(`unknown command "${command ?? ''}"`)
  }
}

export const main = runMain('implementer', dispatch)
