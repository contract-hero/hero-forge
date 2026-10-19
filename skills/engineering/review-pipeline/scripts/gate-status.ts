// The `contract-reviewer/gate` commit status: the reviewer App posts it at the
// run's head, `success` when post-review records a passing gate, and `failure`
// when run-state stops the run. A ruleset that requires this check (with the
// App as its source) makes GitHub enforce the gate.
//
// Only the App posts it, with a token minted in-process for `statuses: write`
// alone, and never printed. Callers post only with `app: enabled`: without the
// App nothing posts, and nothing ever posts as the user.
//
// `success` posts once per head: it is skipped only when GitHub already shows
// it there as the App's newest gate status. GitHub is the record, not the run
// state: a pass that hero-forge 1.0.6 recorded posted no status.
//
// An App without the commit-status permission is broken (exit 4), whether
// GitHub refuses the token (422 at the mint), the read or the post (403).
import { mintAppToken } from './app-token.ts'
import { Failure, refuse } from './cli.ts'
import { gh, json, oneLine } from './github.ts'
import type { State } from './run-state.ts'

export const GATE_CONTEXT = 'contract-reviewer/gate'

const NO_PERMISSION = `the reviewer App cannot post the ${GATE_CONTEXT} commit status: it lacks the commit-status permission (statuses: write). Give the App "Commit statuses: Read and write" in its settings, accept the new permission on the installation, then run this step again`

const noPermission = (said: string) => /HTTP 403|Resource not accessible by integration/.test(said)

// Post the status at the run's head as the reviewer App, whose login must be
// the run's reviewer_login.
export async function postGateStatus(state: State, result: 'success' | 'failure', description: string): Promise<void> {
  let minted: { token: string; login: string }
  try {
    minted = await mintAppToken(state.repo, 'reviewer', { statuses: 'write' })
  } catch (error) {
    const refused = error instanceof Failure ? /mint the installation token failed: (HTTP (?:403|422)(?: \([^)]*\))?)/.exec(error.message) : null
    if (refused !== null) throw new Failure(`${NO_PERMISSION} (GitHub refused the token: ${refused[1]})`, 4)
    throw error
  }
  const { token, login } = minted
  refuse(
    login === state.reviewer_login,
    `the reviewer App posts as ${login}, but the run state for PR #${state.pr} expects ${state.reviewer_login}`,
  )
  const sha = state.head_sha
  if (result === 'success') {
    // Newest first, as GitHub lists a commit's statuses.
    const listed = await gh(['api', '--paginate', '--jq', '.[] | {state, context, login: .creator.login}', `repos/${state.repo}/commits/${sha}/statuses`], '', token)
    const said = oneLine(listed.stderr)
    if (listed.code !== 0 && noPermission(said)) throw new Failure(`${NO_PERMISSION} (${said})`, 4)
    refuse(listed.code === 0, `cannot list the statuses of ${sha}: ${said}`)
    const newest = listed.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => json<{ state?: string; context?: string; login?: string }>(line, `list the statuses of ${sha}`))
      .find((st) => st.context === GATE_CONTEXT && st.login === login)
    if (newest?.state === 'success') return
  }
  const body = { state: result, context: GATE_CONTEXT, description }
  const posted = await gh(['api', '-X', 'POST', `repos/${state.repo}/statuses/${sha}`, '--input', '-'], JSON.stringify(body), token)
  const said = oneLine(posted.stderr || posted.stdout)
  if (posted.code !== 0 && noPermission(said)) throw new Failure(`${NO_PERMISSION} (${said})`, 4)
  refuse(posted.code === 0, `GitHub rejected the ${GATE_CONTEXT} status: ${said}`)
}
