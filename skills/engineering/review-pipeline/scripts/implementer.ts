// `review.ts implementer` (usage in the table in cli.ts).
// Act as the Implementer App with no token in the agent's hands: each verb
// mints the App's installation token in this process, uses it, and prints
// only what it did. `push` pushes a local branch, `pr` opens a draft pull
// request (so the App is its author), and `comment` posts one comment on an
// issue or a pull request.
//
// Exit 3: the config has no `app: enabled`, so the caller pushes and posts as
// the user (the Implementer App answers to that key until the `implementer:`
// config block gives it its own switch).
// Exit 4: the config is invalid, or the App is enabled but broken. Nothing is
// pushed or posted, as the App or as the user.
//
// Every text it posts goes through the marker refusal and the secret scan
// first. Errors never carry the token.
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
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
} as const

type Values = { [K in keyof typeof OPTIONS]?: string }

// The Implementer App, after the config check. Any config problem is broken
// (4), as in app-token: the pipeline never gets here without a valid config.
async function implementerApp(repo: string, config: string | undefined): Promise<() => Promise<Identity>> {
  const loaded = await loadConfig(config)
  if (!loaded.ok) throw new Failure(loaded.message, 4)
  if (!loaded.config.app) {
    throw new Failure('no implementer App configured for this repo (no "app: enabled" in the config): push and post as the user', 3)
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
function git(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

// The credential helper of the push. git runs it with the request on stdin,
// and it answers only for https://github.com, from an env var that only this
// git process has: the token is never in argv, in a file, or in git config.
// The empty `credential.helper=` before it drops every helper the user's and
// the repo's config set (gh's included), so the push never carries the
// user's credentials.
const TOKEN_VAR = 'HERO_FORGE_GIT_TOKEN'
const HELPER =
  '!f() { test "$1" = get || exit 0; while IFS= read -r line; do case "$line" in protocol=*) p="${line#protocol=}";; host=*) h="${line#host=}";; esac; done; ' +
  `test "$p" = https && test "$h" = github.com || exit 0; echo username=x-access-token; echo "password=$${TOKEN_VAR}"; }; f`

// git config that could carry another identity than the App past the
// credential helper: an HTTP header (an Authorization header is sent as is),
// or a URL rewrite to another host or to SSH. Matched against git's canonical
// key names, which are lower case outside the URL.
const TRANSPORT = '^(http\\..*extraheader|url\\..*\\.(insteadof|pushinsteadof))$'

// Config a caller can inject through the environment. The check below sees
// it; the push's git never gets it.
const INJECTED = /^GIT_CONFIG_(COUNT|PARAMETERS|KEY_[0-9]+|VALUE_[0-9]+)$/

// Fail closed on any such key in the config the push would read (system,
// global, the repo, and the env). The message names the key, never its value,
// which may be a credential.
async function refuseTransportAuth(): Promise<void> {
  const found = await git(['config', '--name-only', '--get-regexp', TRANSPORT])
  refuse(found.code === 0 || found.code === 1, `cannot read the git config: ${oneLine(found.stderr)}`)
  const key = found.stdout.split('\n').find((line) => line.trim() !== '')
  refuse(key === undefined, `the git config sets ${key}, which could push as another identity than the App. Nothing was pushed. Remove it and run again.`)
}

// Push the local branch to the same branch on GitHub, over https (an App token
// does not work over SSH, and `origin` may be an SSH remote). No upstream is
// set: the remote is a URL, not `origin`. Config that could carry another
// identity is refused before the token is minted, and the push also clears
// `http.extraHeader` and drops the env-injected config. Hooks are off, so no
// hook script runs with the token in its env; no prompt, askpass or other
// protocol can stand in for the App.
async function push(repo: string, values: Values): Promise<string> {
  const branch = values.branch
  if (branch === undefined || branch === '') throw usage('--branch is required')
  const app = await implementerApp(repo, values.config)
  const local = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  refuse(local.code === 0, `no local branch ${branch} in this repo: run push in the worktree that holds it`)
  const commit = local.stdout.trim()
  await refuseTransportAuth()

  const me = await app()
  const token = me.token as string
  const env: NodeJS.ProcessEnv = { ...process.env, [TOKEN_VAR]: token, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https' }
  for (const name of Object.keys(env)) {
    if (name === 'GIT_ASKPASS' || name === 'SSH_ASKPASS' || name.startsWith('GIT_TRACE') || INJECTED.test(name)) delete env[name]
  }
  const ref = `refs/heads/${branch}`
  const pushed = await git(
    ['-c', 'credential.helper=', '-c', `credential.helper=${HELPER}`, '-c', 'http.extraHeader=', '-c', 'core.askPass=',
      '-c', 'core.hooksPath=/dev/null',
      'push', `https://github.com/${repo}.git`, `${ref}:${ref}`],
    env,
  )
  // git prints no credential, but its output is scrubbed of the token anyway.
  const said = oneLine(pushed.stderr || pushed.stdout).replaceAll(token, '***')
  refuse(pushed.code === 0, `GitHub refused the push of ${branch}: ${said}`)
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
    default:
      throw usage(`unknown command "${command ?? ''}"`)
  }
}

export const main = runMain('implementer', dispatch)
