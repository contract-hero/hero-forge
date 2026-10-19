// `review.ts app-check` (usage in the table in cli.ts): read one App's
// settings through the GitHub API, as the App (its JWT), and check each
// against what AFK mode needs. setup-forge runs it after the user changes the
// settings, so a wrong setting shows up at setup and not in the first run.
//
// Items, in this order:
//   permission <name>      each permission the App needs, at exactly that
//                          level; the Implementer also needs no workflows
//   event <name>           each event the App needs; any other event is wrong,
//                          because each delivery costs one agent turn
//   webhook active         GitHub has a webhook config for the App
//   webhook url            the T3 task's webhookUrl (--webhook-url), or set
//   webhook secret         set (GitHub never shows its value)
//   webhook content type   json
//   installation           the App is installed on the repo, not suspended
//   installation accepted  the installation has accepted every permission and
//                          event the App asks for
//
// A wrong item says what to change and on which page. The report never
// prints the webhook URL (it carries T3's token) or any secret.
// Exit 0: every item ok. Exit 1: an item is wrong. Exit 4: the App's
// credentials are broken, or GitHub answers with an error.
import { APPS, ApiFailure, appApi, type AppApi, type AppName } from './app-token.ts'
import { parse, repoOption, runMain, usageFor } from './cli.ts'

const usage = usageFor('app-check')

type Level = 'read' | 'write'

// What each App needs. The reviewer posts reviews and the gate status; the
// Implementer pushes, opens PRs, comments and labels.
const NEEDS: Record<AppName, { permissions: Record<string, Level>; events: string[]; forbidden: string[] }> = {
  reviewer: {
    permissions: { contents: 'read', pull_requests: 'write', statuses: 'write', metadata: 'read' },
    events: ['pull_request', 'issue_comment'],
    forbidden: [],
  },
  implementer: {
    permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' },
    events: ['issues', 'issue_comment'],
    forbidden: ['workflows'],
  },
}

// The names GitHub's settings pages show.
const PERMISSION_LABEL: Record<string, string> = {
  contents: 'Contents',
  pull_requests: 'Pull requests',
  statuses: 'Commit statuses',
  metadata: 'Metadata',
  issues: 'Issues',
  workflows: 'Workflows',
}
const LEVEL_LABEL: Record<string, string> = { read: 'Read-only', write: 'Read and write', none: 'No access' }
const EVENT_LABEL: Record<string, string> = { pull_request: 'Pull request', issue_comment: 'Issue comment', issues: 'Issues' }

type Item = { item: string; status: 'ok' | 'wrong'; want: string; has: string; fix: string | null }

type Account = { login?: unknown; type?: unknown }

type App = { id?: unknown; slug?: unknown; owner?: Account; permissions?: unknown; events?: unknown }

type HookConfig = { url?: unknown; content_type?: unknown; secret?: unknown }

type Installation = { id?: unknown; account?: Account; permissions?: unknown; events?: unknown; suspended_at?: unknown }

const record = (v: unknown): Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, string>) : {}
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : [])

// The settings root of an account: an org's, or the signed-in user's.
function settingsRoot(account: Account | undefined): string {
  return account?.type === 'Organization' && typeof account.login === 'string'
    ? `https://github.com/organizations/${account.login}/settings`
    : 'https://github.com/settings'
}

// GET `path`, or null when GitHub answers 404.
async function readOrNull<T>(api: AppApi, step: string, path: string): Promise<T | null> {
  try {
    return await api<T>(step, 'GET', path)
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 404) return null
    throw error
  }
}

function item(name: string, ok: boolean, want: string, has: string, fix: string): Item {
  return { item: name, status: ok ? 'ok' : 'wrong', want, has, fix: ok ? null : fix }
}

async function appCheck(argv: string[]): Promise<number> {
  const { values } = parse(argv, { app: { type: 'string' }, repo: { type: 'string' }, 'webhook-url': { type: 'string' } }, usage)
  const app = values.app as AppName
  if (!APPS.includes(app)) throw usage(`--app must be ${APPS.join(' or ')}`)
  const repo = repoOption(values.repo, usage)
  const webhookUrl = values['webhook-url']
  if (webhookUrl === '') throw usage('--webhook-url must not be empty')

  const api = await appApi(app)
  const self = await api<App>('read the App', 'GET', '/app')
  const slug = typeof self.slug === 'string' ? self.slug : ''
  const appPage = `${settingsRoot(self.owner)}/apps/${slug}`
  const permissionsPage = `${appPage}/permissions`
  const hook = await readOrNull<HookConfig>(api, 'read the App webhook', '/app/hook/config')
  const installation = await readOrNull<Installation>(api, 'find the App installation', `/repos/${repo}/installation`)

  const items: Item[] = []
  const needs = NEEDS[app]
  const permissions = record(self.permissions)
  for (const [name, level] of Object.entries(needs.permissions)) {
    const has = permissions[name] ?? 'none'
    items.push(item(`permission ${name}`, has === level, level, has,
      `set Repository permissions > ${PERMISSION_LABEL[name]} to ${LEVEL_LABEL[level]} on ${permissionsPage}`))
  }
  for (const name of needs.forbidden) {
    const has = permissions[name] ?? 'none'
    items.push(item(`permission ${name}`, has === 'none', 'none', has,
      `set Repository permissions > ${PERMISSION_LABEL[name]} to ${LEVEL_LABEL.none} on ${permissionsPage}: the ${app} App must not change .github/workflows/`))
  }

  const events = list(self.events)
  for (const name of needs.events) {
    const on = events.includes(name)
    items.push(item(`event ${name}`, on, 'subscribed', on ? 'subscribed' : 'not subscribed',
      `tick ${EVENT_LABEL[name]} under Subscribe to events on ${permissionsPage}`))
  }
  for (const name of events.filter((e) => !needs.events.includes(e))) {
    items.push(item(`event ${name}`, false, 'not subscribed', 'subscribed',
      `untick ${EVENT_LABEL[name] ?? name} under Subscribe to events on ${permissionsPage}: each delivery costs one agent turn`))
  }

  const fixUrl = `paste the T3 task's webhookUrl in Webhook URL on ${appPage}`
  const fixSecret = `enter the webhook secret you gave T3 in Webhook secret on ${appPage}`
  const fixType = 'set the webhook content type to json (application/json)'
  if (hook === null) {
    items.push(item('webhook active', false, 'active', 'no webhook', `tick Active under Webhook on ${appPage}, then set its URL and secret`))
    items.push(item('webhook url', false, webhookUrl === undefined ? 'set' : 'the --webhook-url value', 'no webhook', fixUrl))
    items.push(item('webhook secret', false, 'set', 'no webhook', fixSecret))
    items.push(item('webhook content type', false, 'json', 'no webhook', fixType))
  } else {
    const url = typeof hook.url === 'string' ? hook.url : ''
    items.push(item('webhook active', true, 'active', 'active', ''))
    if (webhookUrl === undefined) {
      items.push(item('webhook url', url !== '', 'set', url === '' ? 'not set' : 'set', fixUrl))
    } else {
      const has = url === '' ? 'not set' : url === webhookUrl ? 'the same URL' : 'another URL'
      items.push(item('webhook url', url === webhookUrl, 'the --webhook-url value', has, fixUrl))
    }
    const secret = typeof hook.secret === 'string' && hook.secret !== ''
    items.push(item('webhook secret', secret, 'set', secret ? 'set' : 'not set', fixSecret))
    const type = typeof hook.content_type === 'string' ? hook.content_type : 'not set'
    items.push(item('webhook content type', type === 'json', 'json', type, fixType))
  }

  let installationPage: string | null = null
  if (installation === null) {
    items.push(item('installation', false, `installed on ${repo}`, 'not installed',
      `install the App on ${repo} at https://github.com/apps/${slug}/installations/new`))
  } else {
    installationPage = `${settingsRoot(installation.account)}/installations/${String(installation.id)}`
    const suspended = installation.suspended_at !== null && installation.suspended_at !== undefined
    items.push(item('installation', !suspended, `installed on ${repo}`, suspended ? 'suspended' : `installed on ${repo}`,
      `unsuspend the installation on ${installationPage}`))
    const accepted = record(installation.permissions)
    const acceptedEvents = list(installation.events)
    const missing = [
      ...Object.entries(permissions).filter(([name, level]) => accepted[name] !== level).map(([name]) => name),
      ...events.filter((e) => !acceptedEvents.includes(e)),
    ]
    items.push(item('installation accepted', missing.length === 0, 'every permission and event of the App',
      missing.length === 0 ? 'every permission and event of the App' : `not accepted: ${missing.join(', ')}`,
      `accept the App's new permissions on ${installationPage} (GitHub shows the request there)`))
  }

  const ok = items.every((i) => i.status === 'ok')
  const report = {
    app,
    app_id: typeof self.id === 'number' ? self.id : null,
    slug,
    repo,
    ok,
    pages: { settings: appPage, permissions: permissionsPage, installation: installationPage },
    items,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return ok ? 0 : 1
}

export const main = runMain('app-check', appCheck)
