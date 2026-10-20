// `review.ts delivery` (usage in the table in cli.ts): fetch the payload of one
// webhook delivery from the App's own deliveries on GitHub, so the T3 router
// prompt never copies a webhook body. The router gets only the delivery id
// from the request headers; the payload that `route` reads comes from
// GitHub's API, signed in as the App with its JWT.
//
// GitHub lists the deliveries newest first, 100 a page, with a cursor to the
// next page. Each try walks the pages until it finds the delivery, reaches a
// delivery older than MAX_DELIVERY_AGE_HOURS (an older one would be refused
// anyway), or runs out of pages. GitHub can take a moment to list a delivery
// it has just sent, so the walk runs up to DELIVERY_TRIES times,
// HERO_FORGE_DELIVERY_RETRY_MS apart. The detail read of the delivery found
// is tried the same way on a 5xx or a network error.
// Exit 1: GitHub sent the delivery more than MAX_DELIVERY_AGE_HOURS ago (its
// signature has no timestamp, so an old one is a replay), the detail read
// still fails with a 5xx or a network error after DELIVERY_TRIES tries, or
// --out already exists (a file or a symlink: it is created new, never
// followed).
// Exit 3: GitHub still does not list the delivery. Exit 4: the App's
// credentials are broken, or GitHub answers with another error (a 404 for an
// App with no webhook). Output: {event, action, repo}; never a token or key.
import { writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { APPS, ApiFailure, ApiUnreachable, appApi, type AppName } from './app-token.ts'
import { Failure, isRepo, MAX_DELIVERY_AGE_HOURS, parse, runMain, usageFor } from './cli.ts'

const usage = usageFor('delivery')

const DELIVERY_TRIES = 5
const DEFAULT_RETRY_MS = 3000

function retryMs(): number {
  const raw = process.env.HERO_FORGE_DELIVERY_RETRY_MS
  return raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : DEFAULT_RETRY_MS
}

// GitHub's list entry for one delivery: `id` is GitHub's own number (its
// exact digits as a string when it is above 2^53, see parseExact), `guid`
// the X-GitHub-Delivery value.
type Listed = { id?: unknown; guid?: unknown; event?: unknown; action?: unknown; delivered_at?: unknown }

type Detail = Listed & { request?: { payload?: unknown } }

async function delivery(argv: string[]): Promise<string> {
  const { values } = parse(argv, { app: { type: 'string' }, delivery: { type: 'string' }, out: { type: 'string' } }, usage)
  const app = values.app as AppName
  if (!APPS.includes(app)) throw usage(`--app must be ${APPS.join(' or ')}`)
  const guid = values.delivery
  if (guid === undefined || !/^[A-Za-z0-9-]+$/.test(guid)) throw usage('--delivery must be the X-GitHub-Delivery id')
  if (values.out === undefined || values.out === '') throw usage('delivery needs --out')

  const api = await appApi(app)
  const page = async (cursor: string | null) => {
    const path = `/app/hook/deliveries?per_page=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
    try {
      const { body, cursor: next } = await api.page<unknown>('list the App webhook deliveries', path)
      return { listed: Array.isArray(body) ? (body as Listed[]) : [], next }
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) {
        throw new Failure(`the ${app} App has no webhook deliveries (HTTP 404): set its webhook, or re-run /setup-forge`, 4)
      }
      throw error
    }
  }
  const oldest = () => Date.now() - MAX_DELIVERY_AGE_HOURS * 3600 * 1000
  const tooOld = (d: Listed) => typeof d.delivered_at === 'string' && Date.parse(d.delivered_at) < oldest()
  const walk = async (): Promise<Listed | undefined> => {
    let cursor: string | null = null
    for (;;) {
      const { listed, next } = await page(cursor)
      const hit = listed.find((d) => d.guid === guid && (typeof d.id === 'number' || (typeof d.id === 'string' && /^\d+$/.test(d.id))))
      if (hit !== undefined) return hit
      if (next === null || listed.length === 0 || listed.some(tooOld)) return undefined
      cursor = next
    }
  }

  let found: Listed | undefined
  for (let tries = 1; found === undefined; tries++) {
    found = await walk()
    if (found !== undefined) break
    if (tries === DELIVERY_TRIES) {
      throw new Failure(`GitHub does not list delivery ${guid} in the ${app} App's webhook deliveries (${DELIVERY_TRIES} tries)`, 3)
    }
    await sleep(retryMs())
  }

  const sent = typeof found.delivered_at === 'string' ? Date.parse(found.delivered_at) : Number.NaN
  if (Number.isNaN(sent)) throw new Failure(`GitHub sent no delivery time for delivery ${guid}`, 1)
  if (sent < oldest()) {
    throw new Failure(
      `delivery ${guid} was sent at ${found.delivered_at as string}, more than ${MAX_DELIVERY_AGE_HOURS} hours ago: a replay, or a request held too long`,
      1,
    )
  }

  // GitHub can answer the detail read with a 5xx for a few seconds after it
  // sends a delivery, so a 5xx or a network error is tried again as the list
  // walk is.
  const id = String(found.id)
  let detail: Detail | undefined
  for (let tries = 1; detail === undefined; tries++) {
    try {
      detail = await api<Detail>('read the webhook delivery', 'GET', `/app/hook/deliveries/${id}`)
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) {
        throw new Failure(`delivery ${guid} (id ${id}) is listed, but GitHub has no detail for it (HTTP 404)`, 1)
      }
      if (!((error instanceof ApiFailure && error.status >= 500) || error instanceof ApiUnreachable)) throw error
      if (tries === DELIVERY_TRIES) {
        throw new Failure(`GitHub failed to read delivery ${guid} (id ${id}): ${error.answer} on all ${DELIVERY_TRIES} tries. Try again later.`, 1)
      }
      await sleep(retryMs())
    }
  }
  const payload = detail.request?.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Failure(`GitHub sent no JSON payload for delivery ${guid}`, 1)
  }
  // `wx` creates the file new: a path that exists, a symlink included (even
  // a dangling one), fails, so the payload never lands where a link points.
  try {
    await writeFile(values.out, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new Failure(`${values.out} already exists: pass a fresh path in a private directory (mktemp -d)`, 1)
    }
    throw new Failure(`cannot write ${values.out}: ${(error as Error).message}`, 1)
  }

  const full = (payload as { repository?: { full_name?: unknown } }).repository?.full_name
  const event = typeof detail.event === 'string' ? detail.event : typeof found.event === 'string' ? found.event : null
  const action = typeof detail.action === 'string' ? detail.action : typeof found.action === 'string' ? found.action : null
  return `${JSON.stringify({ event, action, repo: isRepo(full) ? full : null })}\n`
}

export const main = runMain('delivery', delivery)
