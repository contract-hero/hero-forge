// `review.ts app-check`: each App setting AFK mode needs, read through the
// GitHub API as the App, each item ok or wrong with what to change.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { appKey, baseEnv, fakeGitHubApi, runCli, tempDir, type FakeApiRoute } from './test-helpers.ts'

const REPO = 'contract-hero/hero-forge'
const URL = 'https://relay.t3.example/v1/hooks/ep/task/tok123'
const ORG_APPS = 'https://github.com/organizations/contract-hero/settings/apps'
const ORG_INSTALLS = 'https://github.com/organizations/contract-hero/settings/installations'

const REVIEWER_PERMISSIONS = { contents: 'read', pull_requests: 'write', statuses: 'write', metadata: 'read' }
const IMPLEMENTER_PERMISSIONS = { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' }

type AppName = 'reviewer' | 'implementer'

// GitHub's answers for an App set up as AFK mode needs, owned by the org and
// installed on the repo.
function working(app: AppName): Record<string, FakeApiRoute> {
  const permissions = app === 'reviewer' ? REVIEWER_PERMISSIONS : IMPLEMENTER_PERMISSIONS
  const events = app === 'reviewer' ? ['pull_request', 'issue_comment'] : ['issues', 'issue_comment']
  const slug = app === 'reviewer' ? 'contract-reviewer' : 'contract-implementer'
  return {
    'GET /app': {
      status: 200,
      body: { id: 5343766, slug, owner: { login: 'contract-hero', type: 'Organization' }, permissions, events },
    },
    'GET /app/hook/config': { status: 200, body: { url: URL, content_type: 'json', secret: '********', insecure_ssl: '0' } },
    [`GET /repos/${REPO}/installation`]: {
      status: 200,
      body: {
        id: 4242,
        account: { login: 'contract-hero', type: 'Organization' },
        permissions,
        events,
        suspended_at: null,
      },
    },
  }
}

type Setup = { app?: AppName; routes?: Record<string, FakeApiRoute>; env?: string | null; webhookUrl?: string | null }

async function setup(t: Parameters<typeof tempDir>[0], options: Setup = {}) {
  const dir = await tempDir(t)
  const app = options.app ?? 'reviewer'
  const key = await appKey(dir)
  const api = await fakeGitHubApi(t, key.publicKey, options.routes ?? working(app))
  const NAME = app.toUpperCase()
  const envFile = join(dir, `${app}-app.env`)
  if (options.env !== null) await writeFile(envFile, options.env ?? `HERO_FORGE_${NAME}_APP_ID=123456\nHERO_FORGE_${NAME}_APP_KEY=${key.pem}\n`)
  const env = { ...baseEnv(), [`HERO_FORGE_${NAME}_APP_ENV`]: envFile, HERO_FORGE_GITHUB_API_URL: api.url }
  const url = options.webhookUrl === undefined ? URL : options.webhookUrl
  const check = () => runCli(['app-check', '--app', app, '--repo', REPO, ...(url === null ? [] : ['--webhook-url', url])], { env })
  return { dir, api, check }
}

type Item = { item: string; status: 'ok' | 'wrong'; want: string; has: string; fix: string | null }

const wrongItems = (report: { items: Item[] }) => report.items.filter((i) => i.status === 'wrong')

test('a reviewer App set up as AFK mode needs: every item ok, exit 0', async (t) => {
  const s = await setup(t)
  const { code, stdout, stderr } = await s.check()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const report = JSON.parse(stdout)
  assert.deepEqual(
    { app: report.app, app_id: report.app_id, slug: report.slug, repo: report.repo, ok: report.ok },
    { app: 'reviewer', app_id: 5343766, slug: 'contract-reviewer', repo: REPO, ok: true },
  )
  assert.deepEqual(report.pages, {
    settings: `${ORG_APPS}/contract-reviewer`,
    permissions: `${ORG_APPS}/contract-reviewer/permissions`,
    installation: `${ORG_INSTALLS}/4242`,
  })
  assert.deepEqual(
    report.items.map((i: Item) => [i.item, i.status]),
    [
      ['permission contents', 'ok'],
      ['permission pull_requests', 'ok'],
      ['permission statuses', 'ok'],
      ['permission metadata', 'ok'],
      ['event pull_request', 'ok'],
      ['event issue_comment', 'ok'],
      ['webhook active', 'ok'],
      ['webhook url', 'ok'],
      ['webhook secret', 'ok'],
      ['webhook content type', 'ok'],
      ['installation', 'ok'],
      ['installation accepted', 'ok'],
    ],
  )
  assert.ok(report.items.every((i: Item) => i.fix === null))
  // The webhook URL carries T3's token: the report never prints it.
  assert.ok(!stdout.includes('tok123'))
  assert.ok(s.api.requests.every((r) => r.jwt_ok && r.iss === '123456'))
})

// Change one GitHub answer of a working App.
function patch(app: AppName, route: string, change: (body: Record<string, unknown>) => Record<string, unknown> | null) {
  const routes = working(app)
  const body = routes[route]?.body as Record<string, unknown>
  const changed = change(structuredClone(body))
  routes[route] = changed === null ? { status: 404, body: { message: 'Not Found' } } : { status: 200, body: changed }
  return routes
}

const PERMS = `${ORG_APPS}/contract-reviewer/permissions`

// Each wrong setting, and the one wrong item it gives: [item, want, has, fix].
const WRONG: [string, AppName, Record<string, FakeApiRoute>, [string, string, string, string][]][] = [
  [
    'the reviewer has no Commit statuses permission',
    'reviewer',
    patch('reviewer', 'GET /app', (b) => ({ ...b, permissions: { contents: 'read', pull_requests: 'write', metadata: 'read' } })),
    [['permission statuses', 'write', 'none', `set Repository permissions > Commit statuses to Read and write on ${PERMS}`]],
  ],
  [
    'the reviewer can write contents',
    'reviewer',
    patch('reviewer', 'GET /app', (b) => ({ ...b, permissions: { ...REVIEWER_PERMISSIONS, contents: 'write' } })),
    [
      ['permission contents', 'read', 'write', `set Repository permissions > Contents to Read-only on ${PERMS}`],
      // The installation accepted the old set, so that is also wrong.
      ['installation accepted', 'every permission and event of the App', 'not accepted: contents',
        `accept the App's new permissions on ${ORG_INSTALLS}/4242 (GitHub shows the request there)`],
    ],
  ],
  [
    'the reviewer is not subscribed to issue comments',
    'reviewer',
    patch('reviewer', 'GET /app', (b) => ({ ...b, events: ['pull_request'] })),
    [['event issue_comment', 'subscribed', 'not subscribed', `tick Issue comment under Subscribe to events on ${PERMS}`]],
  ],
  [
    'the reviewer is subscribed to an event it does not need',
    'reviewer',
    patch('reviewer', 'GET /app', (b) => ({ ...b, events: ['pull_request', 'issue_comment', 'pull_request_review'] })),
    [
      ['event pull_request_review', 'not subscribed', 'subscribed',
        `untick pull_request_review under Subscribe to events on ${PERMS}: each delivery costs one agent turn`],
      ['installation accepted', 'every permission and event of the App', 'not accepted: pull_request_review',
        `accept the App's new permissions on ${ORG_INSTALLS}/4242 (GitHub shows the request there)`],
    ],
  ],
  [
    'the webhook URL is not the T3 task URL',
    'reviewer',
    patch('reviewer', 'GET /app/hook/config', (b) => ({ ...b, url: 'https://old.example/hook' })),
    [['webhook url', 'the --webhook-url value', 'another URL',
      `paste the T3 task's webhookUrl in Webhook URL on ${ORG_APPS}/contract-reviewer`]],
  ],
  [
    'the webhook has no secret',
    'reviewer',
    patch('reviewer', 'GET /app/hook/config', (b) => ({ ...b, secret: null })),
    [['webhook secret', 'set', 'not set', `enter the webhook secret you gave T3 in Webhook secret on ${ORG_APPS}/contract-reviewer`]],
  ],
  [
    'the webhook sends form data',
    'reviewer',
    patch('reviewer', 'GET /app/hook/config', (b) => ({ ...b, content_type: 'form' })),
    [['webhook content type', 'json', 'form', 'set the webhook content type to json (application/json)']],
  ],
  [
    'the webhook is not active (GitHub answers 404)',
    'reviewer',
    patch('reviewer', 'GET /app/hook/config', () => null),
    [
      ['webhook active', 'active', 'no webhook', `tick Active under Webhook on ${ORG_APPS}/contract-reviewer, then set its URL and secret`],
      ['webhook url', 'the --webhook-url value', 'no webhook', `paste the T3 task's webhookUrl in Webhook URL on ${ORG_APPS}/contract-reviewer`],
      ['webhook secret', 'set', 'no webhook', `enter the webhook secret you gave T3 in Webhook secret on ${ORG_APPS}/contract-reviewer`],
      ['webhook content type', 'json', 'no webhook', 'set the webhook content type to json (application/json)'],
    ],
  ],
  [
    'the App is not installed on the repo',
    'reviewer',
    patch('reviewer', `GET /repos/${REPO}/installation`, () => null),
    [['installation', `installed on ${REPO}`, 'not installed',
      `install the App on ${REPO} at https://github.com/apps/contract-reviewer/installations/new`]],
  ],
  [
    'the installation is suspended',
    'reviewer',
    patch('reviewer', `GET /repos/${REPO}/installation`, (b) => ({ ...b, suspended_at: '2026-10-18T00:00:00Z' })),
    [['installation', `installed on ${REPO}`, 'suspended', `unsuspend the installation on ${ORG_INSTALLS}/4242`]],
  ],
  [
    'the installation has not accepted the Commit statuses permission',
    'reviewer',
    patch('reviewer', `GET /repos/${REPO}/installation`, (b) => ({ ...b, permissions: { contents: 'read', pull_requests: 'write', metadata: 'read' } })),
    [['installation accepted', 'every permission and event of the App', 'not accepted: statuses',
      `accept the App's new permissions on ${ORG_INSTALLS}/4242 (GitHub shows the request there)`]],
  ],
  [
    'the Implementer can change workflows',
    'implementer',
    patch('implementer', 'GET /app', (b) => ({ ...b, permissions: { ...IMPLEMENTER_PERMISSIONS, workflows: 'write' } })),
    [
      ['permission workflows', 'none', 'write',
        `set Repository permissions > Workflows to No access on ${ORG_APPS}/contract-implementer/permissions: the implementer App must not change .github/workflows/`],
      ['installation accepted', 'every permission and event of the App', 'not accepted: workflows',
        `accept the App's new permissions on ${ORG_INSTALLS}/4242 (GitHub shows the request there)`],
    ],
  ],
  [
    'the Implementer cannot write issues',
    'implementer',
    patch('implementer', 'GET /app', (b) => ({ ...b, permissions: { ...IMPLEMENTER_PERMISSIONS, issues: 'read' } })),
    [
      ['permission issues', 'write', 'read', `set Repository permissions > Issues to Read and write on ${ORG_APPS}/contract-implementer/permissions`],
      ['installation accepted', 'every permission and event of the App', 'not accepted: issues',
        `accept the App's new permissions on ${ORG_INSTALLS}/4242 (GitHub shows the request there)`],
    ],
  ],
]

for (const [name, app, routes, wrong] of WRONG) {
  test(`a wrong setting is named with what to change, exit 1: ${name}`, async (t) => {
    const s = await setup(t, { app, routes })
    const { code, stdout, stderr } = await s.check()
    assert.equal(stderr, '')
    assert.equal(code, 1)
    const report = JSON.parse(stdout)
    assert.equal(report.ok, false)
    assert.deepEqual(wrongItems(report).map((i) => [i.item, i.want, i.has, i.fix]), wrong)
    assert.ok(!stdout.includes('tok123'))
    assert.ok(!stdout.includes('old.example'))
  })
}

test('an Implementer App set up as AFK mode needs: every item ok, with no workflows item wrong', async (t) => {
  const s = await setup(t, { app: 'implementer' })
  const { code, stdout } = await s.check()
  assert.equal(code, 0)
  const report = JSON.parse(stdout)
  assert.equal(report.slug, 'contract-implementer')
  assert.deepEqual(
    report.items.filter((i: Item) => i.item.startsWith('permission') || i.item.startsWith('event')).map((i: Item) => [i.item, i.want, i.has]),
    [
      ['permission contents', 'write', 'write'],
      ['permission pull_requests', 'write', 'write'],
      ['permission issues', 'write', 'write'],
      ['permission metadata', 'read', 'read'],
      ['permission workflows', 'none', 'none'],
      ['event issues', 'subscribed', 'subscribed'],
      ['event issue_comment', 'subscribed', 'subscribed'],
    ],
  )
})

test('without --webhook-url the URL item checks only that a URL is set', async (t) => {
  const s = await setup(t, { webhookUrl: null })
  const { code, stdout } = await s.check()
  assert.equal(code, 0)
  const url = JSON.parse(stdout).items.find((i: Item) => i.item === 'webhook url')
  assert.deepEqual(url, { item: 'webhook url', status: 'ok', want: 'set', has: 'set', fix: null })
})

test('an App the user owns gets the user settings pages', async (t) => {
  const routes = working('reviewer')
  ;(routes['GET /app']!.body as Record<string, unknown>).owner = { login: 'alilloig', type: 'User' }
  ;(routes[`GET /repos/${REPO}/installation`]!.body as Record<string, unknown>).account = { login: 'alilloig', type: 'User' }
  const s = await setup(t, { routes })
  const { code, stdout } = await s.check()
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout).pages, {
    settings: 'https://github.com/settings/apps/contract-reviewer',
    permissions: 'https://github.com/settings/apps/contract-reviewer/permissions',
    installation: 'https://github.com/settings/installations/4242',
  })
})

test('broken credentials exit 4, print no report and no secret, and call no API', async (t) => {
  const s = await setup(t, { env: 'HERO_FORGE_REVIEWER_APP_ID=1\n' })
  const { code, stdout, stderr } = await s.check()
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts app-check: .*sets no HERO_FORGE_REVIEWER_APP_KEY/)
  assert.doesNotMatch(stderr, /PRIVATE KEY|eyJ/)
  assert.deepEqual(s.api.requests, [])
})

test('a key GitHub refuses (401) exits 4', async (t) => {
  const s = await setup(t)
  const other = await appKey(s.dir, 'other.pem')
  await writeFile(join(s.dir, 'reviewer-app.env'), `HERO_FORGE_REVIEWER_APP_ID=123456\nHERO_FORGE_REVIEWER_APP_KEY=${other.pem}\n`)
  const { code, stdout, stderr } = await s.check()
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts app-check: read the App failed: HTTP 401/)
})

test('a bad --repo or --app is a usage error that calls no API', async (t) => {
  const s = await setup(t)
  const env = { ...baseEnv(), HERO_FORGE_GITHUB_API_URL: 'http://127.0.0.1:9' }
  const bad = await runCli(['app-check', '--app', 'reviewer', '--repo', 'nope'], { env })
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /--repo must be OWNER\/REPO/)
  const noApp = await runCli(['app-check', '--repo', REPO], { env })
  assert.equal(noApp.code, 2)
  assert.match(noApp.stderr, /--app must be reviewer or implementer/)
  assert.deepEqual(s.api.requests, [])
})
