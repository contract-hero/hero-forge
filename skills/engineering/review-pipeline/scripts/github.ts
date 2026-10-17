// The `gh` calls the subcommands share. `gh` is found through PATH, so the
// tests' fake `gh` stands in for it.
import { spawn } from 'node:child_process'
import { Failure } from './run-state.ts'

export type GhResult = { code: number | null; stdout: string; stderr: string }

// Run `gh` with `input` on stdin (closed either way, so the call returns).
export function gh(args: string[], input = ''): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

export function refuse(ok: boolean, message: string): void {
  if (!ok) throw new Failure(message, 1)
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
export async function listLines<T>(args: string[], what: string): Promise<T[]> {
  const listed = await gh(args)
  refuse(listed.code === 0, `cannot list ${what}: ${oneLine(listed.stderr)}`)
  return listed.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => json<T>(line, `list ${what}`))
}

// Who posts: the login GitHub will show, and the `as` value recorded in run
// state. The App identity (a `<slug>[bot]` login) plugs in here.
export type Identity = { login: string; as: string }

export async function userIdentity(): Promise<Identity> {
  const user = await gh(['api', 'user', '--jq', '.login'])
  const login = user.stdout.trim()
  refuse(user.code === 0 && login !== '', `cannot read the gh user: ${oneLine(user.stderr)}`)
  return { login, as: 'user' }
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
