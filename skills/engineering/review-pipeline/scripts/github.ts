// The `gh` calls the subcommands share. `gh` is found through PATH, so the
// tests' fake `gh` stands in for it.
import { spawn } from 'node:child_process'
import { mintAppToken } from './app-token.ts'
import { Failure, refuse } from './cli.ts'

export type GhResult = { code: number | null; stdout: string; stderr: string }

// Run `gh` with `input` on stdin (closed either way, so the call returns). A
// gh that exits before it reads stdin makes the write fail with EPIPE; the
// exit code and output still tell the caller what happened, so that error is
// ignored rather than left to crash the process.
// With `token`, gh runs as that token (the reviewer App) through GH_TOKEN;
// without it, gh runs as the user, with the environment unchanged.
export function gh(args: string[], input = '', token?: string): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const env = token === undefined ? process.env : { ...process.env, GH_TOKEN: token }
    const child = spawn('gh', args, { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export function oneLine(text: string): string {
  return text.trim().split('\n').filter((l) => l.trim() !== '').join(' ') || 'no output'
}

export function json<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Failure(`unexpected output from gh (${what}): ${oneLine(text)}`, 1)
  }
}

// One JSON object per line, as `gh api --paginate --jq '.[] | {...}'` prints.
export async function listLines<T>(args: string[], what: string, token?: string): Promise<T[]> {
  const listed = await gh(args, '', token)
  refuse(listed.code === 0, `cannot list ${what}: ${oneLine(listed.stderr)}`)
  return listed.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => json<T>(line, `list ${what}`))
}

// Who posts: the login GitHub will show, the `as` value recorded in run state
// (`user`, or the App's `<slug>[bot]`), and the token gh posts with (none for
// the user).
export type Identity = { login: string; as: string; token?: string }

export async function userIdentity(): Promise<Identity> {
  const user = await gh(['api', 'user', '--jq', '.login'])
  const login = user.stdout.trim()
  refuse(user.code === 0 && login !== '', `cannot read the gh user: ${oneLine(user.stderr)}`)
  return { login, as: 'user' }
}

// The reviewer App, with a token minted for `repo`. A broken App throws
// Failure 4: the caller stops and never falls back to the user.
export async function appIdentity(repo: string): Promise<Identity> {
  const { token, login } = await mintAppToken(repo)
  return { login, as: login, token }
}

export type InlineComment = {
  id: number
  in_reply_to_id: number | null
  pull_request_review_id: number | null
  login: string | null
  body: string | null
}

// Every review comment on the PR: the inline findings and the thread replies.
export function listInlineComments(repo: string, pr: number): Promise<InlineComment[]> {
  return listLines<InlineComment>(
    ['api', '--paginate', '--jq', '.[] | {id, in_reply_to_id, pull_request_review_id, login: .user.login, body}',
      `repos/${repo}/pulls/${pr}/comments`],
    `the review comments of PR #${pr}`,
  )
}

// The posted findings: top-level comments of the given reviews, each with the
// `**F<n>**` id its body starts with (null when it has none).
export function postedFindings(
  comments: InlineComment[],
  reviewIds: number[],
): { comment: number; finding: string | null }[] {
  return comments
    .filter((c) => c.in_reply_to_id === null && c.pull_request_review_id !== null && reviewIds.includes(c.pull_request_review_id))
    .map((c) => ({ comment: c.id, finding: /^\*\*(F[0-9]+)\*\*/.exec(c.body ?? '')?.[1] ?? null }))
}
