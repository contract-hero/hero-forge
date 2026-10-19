// `review.ts delivery` (usage in the table in cli.ts): fetch the payload of one
// webhook delivery from the App's own deliveries on GitHub, so the T3 router
// prompt never copies a webhook body. The router gets only the delivery id
// from the request headers; the payload that `route` reads comes from
// GitHub's API, signed in as the App with its JWT.
//
// GitHub can take a moment to list a delivery it has just sent, so the list
// is read up to DELIVERY_TRIES times, HERO_FORGE_DELIVERY_RETRY_MS apart.
// Exit 3: GitHub still does not list the delivery. Exit 4: the App's
// credentials are broken, or GitHub answers with an error (a 404 for an App
// with no webhook). Output: {event, action, repo}; never a token or key.
import { writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { APPS, ApiFailure, appApi, type AppName } from './app-token.ts'
import { Failure, isRepo, parse, runMain, usageFor } from './cli.ts'

const usage = usageFor('delivery')

const DELIVERY_TRIES = 5
const DEFAULT_RETRY_MS = 3000

function retryMs(): number {
  const raw = process.env.HERO_FORGE_DELIVERY_RETRY_MS
  return raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : DEFAULT_RETRY_MS
}

// GitHub's list entry for one delivery: `id` is GitHub's own number, `guid`
// the X-GitHub-Delivery value.
type Listed = { id?: unknown; guid?: unknown; event?: unknown; action?: unknown }

type Detail = Listed & { request?: { payload?: unknown } }

async function delivery(argv: string[]): Promise<string> {
  const { values } = parse(argv, { app: { type: 'string' }, delivery: { type: 'string' }, out: { type: 'string' } }, usage)
  const app = values.app as AppName
  if (!APPS.includes(app)) throw usage(`--app must be ${APPS.join(' or ')}`)
  const guid = values.delivery
  if (guid === undefined || !/^[A-Za-z0-9-]+$/.test(guid)) throw usage('--delivery must be the X-GitHub-Delivery id')
  if (values.out === undefined || values.out === '') throw usage('delivery needs --out')

  const api = await appApi(app)
  const list = async (): Promise<Listed[]> => {
    try {
      const listed = await api<unknown>('list the App webhook deliveries', 'GET', '/app/hook/deliveries?per_page=100')
      return Array.isArray(listed) ? (listed as Listed[]) : []
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) {
        throw new Failure(`the ${app} App has no webhook deliveries (HTTP 404): set its webhook, or re-run /setup-forge`, 4)
      }
      throw error
    }
  }

  let found: Listed | undefined
  for (let tries = 1; found === undefined; tries++) {
    found = (await list()).find((d) => d.guid === guid && typeof d.id === 'number')
    if (found !== undefined) break
    if (tries === DELIVERY_TRIES) {
      throw new Failure(`GitHub does not list delivery ${guid} in the ${app} App's webhook deliveries (${DELIVERY_TRIES} tries)`, 3)
    }
    await sleep(retryMs())
  }

  const detail = await api<Detail>('read the webhook delivery', 'GET', `/app/hook/deliveries/${found.id as number}`)
  const payload = detail.request?.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Failure(`GitHub sent no JSON payload for delivery ${guid}`, 1)
  }
  try {
    await writeFile(values.out, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
  } catch (error) {
    throw new Failure(`cannot write ${values.out}: ${(error as Error).message}`, 1)
  }

  const full = (payload as { repository?: { full_name?: unknown } }).repository?.full_name
  const event = typeof detail.event === 'string' ? detail.event : typeof found.event === 'string' ? found.event : null
  const action = typeof detail.action === 'string' ? detail.action : typeof found.action === 'string' ? found.action : null
  return `${JSON.stringify({ event, action, repo: isRepo(full) ? full : null })}\n`
}

export const main = runMain('delivery', delivery)
