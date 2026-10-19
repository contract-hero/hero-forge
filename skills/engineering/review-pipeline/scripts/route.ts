// `review.ts route` (usage in the table in cli.ts): turn one GitHub webhook
// delivery into one decision for an App, `review` or `ignore`, so the T3
// router prompt only calls this and holds no filtering of its own.
//
// The config is the repo's docs/agents/review.md on its default branch, read
// through `gh api`, never from the local checkout. The rules, first match
// wins:
//   1. paused: true                                 ignore, paused
//   2. the delivery id was seen before              ignore, duplicate
//   3. not a pull_request trigger action           ignore, event:<name> or action:<name>
//      contract-implementer[bot]'s PR: opened, reopened
//      any other PR: ready_for_review, or opened or reopened when not a draft
//      (a by-hand /implement-pr opens a draft and reviews it in its own session)
//   4. no docs/agents/review.md on the default branch
//                                                   ignore, no-config
//   5. the PR author is not the maintainer (the local gh user) or
//      contract-implementer[bot]                    ignore, author
//   6. a run state that is not terminal, or a held lock
//                                                   ignore, locked
//   7. the App's daily run cap is reached           ignore, cap
//   8. review: take the lock, count the run, record the delivery id
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { countRun } from './cap.ts'
import { Failure, isRepo, parse, runMain, usageFor } from './cli.ts'
import { resolveConfigText, type ResolvedConfig } from './config.ts'
import { gh, oneLine, userIdentity } from './github.ts'
import { releasePrLock, takePrLock } from './lock.ts'
import { loadState, stateRoot, TERMINAL } from './run-state.ts'

const usage = usageFor('route')

// The Implementer App's bot login: its PRs start a review like the maintainer's.
const IMPLEMENTER_BOT = 'contract-implementer[bot]'

// GitHub logins are case-insensitive.
const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

// Whether `action` on a PR by `author` starts a review (rule 3). An author
// who is not the bot gets the maintainer's actions here: rule 5 then ignores
// anyone who is not the maintainer, so rule 3 needs no maintainer lookup.
function triggers(action: string, author: string | undefined, draft: boolean): boolean {
  if (author !== undefined && sameLogin(author, IMPLEMENTER_BOT)) return action === 'opened' || action === 'reopened'
  return action === 'ready_for_review' || ((action === 'opened' || action === 'reopened') && !draft)
}

type Decision = { action: 'review' | 'ignore'; repo: string | null; pr: number | null; reason: string | null }

// The fields of a webhook payload that route reads. GitHub sends them; route
// trusts that the payload came from GitHub (the router checks the signature).
type Payload = {
  action?: unknown
  repository?: { full_name?: unknown; default_branch?: unknown }
  pull_request?: { number?: unknown; draft?: unknown; user?: { login?: unknown } }
}

async function readPayload(file: string): Promise<Payload> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new Failure(`cannot read the payload ${file}: ${(error as Error).message}`, 1)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Failure(`the payload ${file} is not JSON`, 1)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Failure(`the payload ${file} is not a JSON object`, 1)
  }
  return value as Payload
}

// The review config on the repo's default branch, or null when the file is
// not there. A file that is there but invalid exits 4.
async function remoteConfig(repo: string, branch: string | undefined): Promise<ResolvedConfig | null> {
  const path = 'docs/agents/review.md'
  const ref = branch === undefined ? '' : `?ref=${encodeURIComponent(branch)}`
  const got = await gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${path}${ref}`])
  if (got.code !== 0) {
    if (/HTTP 404/.test(got.stderr)) return null
    throw new Failure(`cannot read ${path} of ${repo}: ${oneLine(got.stderr)}`, 1)
  }
  const loaded = resolveConfigText(got.stdout, `${repo}:${path}`)
  if (!loaded.ok) throw new Failure(loaded.message, loaded.code)
  return loaded.config
}

// The delivery ids that started a review: one empty file each, under
// `<state root>/deliveries/`. An ignored delivery is not recorded, so GitHub
// may send it again once the reason is gone.
function deliveryFile(delivery: string): string {
  return join(stateRoot(), 'deliveries', delivery)
}

async function seenDelivery(delivery: string): Promise<boolean> {
  return stat(deliveryFile(delivery)).then(
    () => true,
    () => false,
  )
}

async function recordDelivery(delivery: string): Promise<void> {
  const file = deliveryFile(delivery)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, '', { mode: 0o600 })
}

// Whether PR `pr` has a run state that is not terminal. A corrupt state file
// exits 4.
async function runInFlight(pr: number): Promise<boolean> {
  try {
    return !TERMINAL.includes((await loadState(pr)).phase)
  } catch (error) {
    if (error instanceof Failure && error.code === 3) return false
    throw error
  }
}

async function route(argv: string[]): Promise<string> {
  const { values } = parse(
    argv,
    { app: { type: 'string' }, event: { type: 'string' }, delivery: { type: 'string' }, payload: { type: 'string' } },
    usage,
  )
  if (values.app !== 'reviewer') throw usage('--app must be reviewer')
  const event = values.event
  if (event === undefined || !/^[a-z_]+$/.test(event)) throw usage('--event must be the X-GitHub-Event name, such as pull_request')
  const delivery = values.delivery
  if (delivery === undefined || !/^[A-Za-z0-9-]+$/.test(delivery)) throw usage('--delivery must be the X-GitHub-Delivery id')
  if (values.payload === undefined) throw usage('route needs --payload')

  const payload = await readPayload(values.payload)
  const full = payload.repository?.full_name
  const repo = isRepo(full) ? full : null
  const number = payload.pull_request?.number
  const pr = typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : null
  const decide = (action: Decision['action'], reason: string | null): string =>
    `${JSON.stringify({ action, repo, pr, reason } satisfies Decision)}\n`

  const branch = payload.repository?.default_branch
  const config = repo === null ? null : await remoteConfig(repo, typeof branch === 'string' ? branch : undefined)

  if (config?.paused === true) return decide('ignore', 'paused')
  if (await seenDelivery(delivery)) return decide('ignore', 'duplicate')
  if (event !== 'pull_request') return decide('ignore', `event:${event}`)
  const action = typeof payload.action === 'string' ? payload.action : ''
  const login = payload.pull_request?.user?.login
  const author = typeof login === 'string' ? login : undefined
  if (!triggers(action, author, payload.pull_request?.draft === true)) return decide('ignore', `action:${action}`)
  if (config === null) return decide('ignore', 'no-config')
  if (author === undefined) return decide('ignore', 'author')
  if (!sameLogin(author, IMPLEMENTER_BOT) && !sameLogin(author, (await userIdentity()).login)) return decide('ignore', 'author')
  // A pull_request event always carries its number: a payload without one is not GitHub's.
  if (pr === null) throw new Failure('the pull_request payload has no pull_request.number', 1)
  if (await runInFlight(pr)) return decide('ignore', 'locked')
  if (!(await takePrLock(pr, { app: values.app, delivery }))) return decide('ignore', 'locked')
  // The lock is taken first, so a held lock is reported before the cap. A
  // call that the cap stops, or that fails, gives the lock back.
  try {
    if (!(await countRun(values.app, config.app_daily_runs))) {
      await releasePrLock(pr)
      return decide('ignore', 'cap')
    }
    await recordDelivery(delivery)
  } catch (error) {
    await releasePrLock(pr)
    throw error
  }
  return decide('review', null)
}

export const main = runMain('route', route)
