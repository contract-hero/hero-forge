// `review.ts delivery`: the router's payload comes from the App's own webhook
// deliveries on GitHub, never from the router prompt.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { appKey, baseEnv, fakeGitHubApi, runCli, tempDir, type FakeApiRequest, type FakeApiRoute } from './test-helpers.ts'

const GUID = '6a0d8e2c-6f3b-11f1-9a3e-1c2b3a4d5e6f'
const LIST = 'GET /app/hook/deliveries?per_page=100'
const PAYLOAD = {
  action: 'labeled',
  issue: { number: 7 },
  label: { name: 'ready-for-agent' },
  repository: { full_name: 'contract-hero/hero-forge' },
  sender: { login: 'alilloig' },
}

// GitHub's list entry for a delivery: `id` is GitHub's number, `guid` the
// X-GitHub-Delivery header value.
const entry = (id: number, guid: string, event = 'issues', action: string | null = 'labeled') => ({
  id,
  guid,
  delivered_at: '2026-10-19T10:00:00Z',
  redelivery: false,
  status: 'OK',
  status_code: 202,
  event,
  action,
})

const detail = (id: number, guid: string, payload: unknown) => ({
  ...entry(id, guid),
  request: { headers: { 'X-GitHub-Event': 'issues', 'X-Hub-Signature-256': 'sha256=abc' }, payload },
  response: { headers: {}, payload: '' },
})

type Setup = {
  app?: 'reviewer' | 'implementer'
  routes?: Record<string, FakeApiRoute>
  env?: string | null
  onRequest?: (request: FakeApiRequest, routes: Record<string, FakeApiRoute>) => Promise<void>
}

async function setup(t: Parameters<typeof tempDir>[0], options: Setup = {}) {
  const dir = await tempDir(t)
  const app = options.app ?? 'implementer'
  const key = await appKey(dir)
  const routes: Record<string, FakeApiRoute> = options.routes ?? {
    [LIST]: { status: 200, body: [entry(901, 'other-guid'), entry(902, GUID)] },
    'GET /app/hook/deliveries/902': { status: 200, body: detail(902, GUID, PAYLOAD) },
  }
  const api = await fakeGitHubApi(t, key.publicKey, routes, options.onRequest && ((r) => options.onRequest!(r, routes)))
  const NAME = app.toUpperCase()
  const envFile = join(dir, `${app}-app.env`)
  if (options.env !== null) await writeFile(envFile, options.env ?? `HERO_FORGE_${NAME}_APP_ID=123456\nHERO_FORGE_${NAME}_APP_KEY=${key.pem}\n`)
  const env = {
    ...baseEnv(),
    [`HERO_FORGE_${NAME}_APP_ENV`]: envFile,
    HERO_FORGE_GITHUB_API_URL: api.url,
    HERO_FORGE_DELIVERY_RETRY_MS: '10',
  }
  const out = join(dir, 'payload.json')
  const fetchDelivery = (guid = GUID) => runCli(['delivery', '--app', app, '--delivery', guid, '--out', out], { env })
  return { dir, api, out, fetchDelivery, key }
}

// No JWT, PEM or signature text may reach the output.
function assertNoSecret(text: string): void {
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]+\./)
  assert.doesNotMatch(text, /PRIVATE KEY/)
  assert.doesNotMatch(text, /sha256=/)
}

test('a listed delivery: its payload is written to --out and {event, action, repo} is printed', async (t) => {
  const s = await setup(t)
  const { code, stdout, stderr } = await s.fetchDelivery()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { event: 'issues', action: 'labeled', repo: 'contract-hero/hero-forge' })
  assert.deepEqual(JSON.parse(await readFile(s.out, 'utf8')), PAYLOAD)
  assertNoSecret(stdout + stderr)
  assert.deepEqual(
    s.api.requests.map((r) => [r.method, r.path, r.jwt_ok, r.iss]),
    [
      ['GET', '/app/hook/deliveries?per_page=100', true, '123456'],
      ['GET', '/app/hook/deliveries/902', true, '123456'],
    ],
  )
})

test('a delivery GitHub does not list yet is found on a retry', async (t) => {
  let lists = 0
  const s = await setup(t, {
    routes: {
      [LIST]: { status: 200, body: [entry(901, 'other-guid')] },
      'GET /app/hook/deliveries/902': { status: 200, body: detail(902, GUID, PAYLOAD) },
    },
    // After the first list, GitHub lists the new delivery too.
    onRequest: async (request, routes) => {
      if (request.path === '/app/hook/deliveries?per_page=100' && ++lists === 1) {
        routes[LIST] = { status: 200, body: [entry(902, GUID), entry(901, 'other-guid')] }
      }
    },
  })
  const { code, stdout, stderr } = await s.fetchDelivery()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { event: 'issues', action: 'labeled', repo: 'contract-hero/hero-forge' })
  assert.deepEqual(JSON.parse(await readFile(s.out, 'utf8')), PAYLOAD)
  assert.deepEqual(
    s.api.requests.map((r) => r.path),
    ['/app/hook/deliveries?per_page=100', '/app/hook/deliveries?per_page=100', '/app/hook/deliveries/902'],
  )
})

test('a delivery GitHub never lists exits 3 after 5 tries and writes nothing', async (t) => {
  const s = await setup(t)
  const { code, stdout, stderr } = await s.fetchDelivery('0000aaaa-1111-2222-3333-444455556666')
  assert.equal(code, 3)
  assert.equal(stdout, '')
  assert.equal(
    stderr,
    "review.ts delivery: GitHub does not list delivery 0000aaaa-1111-2222-3333-444455556666 in the implementer App's webhook deliveries (5 tries)\n",
  )
  assert.equal(s.api.requests.filter((r) => r.path === '/app/hook/deliveries?per_page=100').length, 5)
  await assert.rejects(readFile(s.out, 'utf8'), { code: 'ENOENT' })
})

test('the reviewer App reads its own deliveries with its own key', async (t) => {
  const s = await setup(t, { app: 'reviewer' })
  const { code, stdout } = await s.fetchDelivery()
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout).repo, 'contract-hero/hero-forge')
  assert.ok(s.api.requests.every((r) => r.jwt_ok && r.iss === '123456'))
})

test('a payload with no repository prints repo null (a ping)', async (t) => {
  const ping = { zen: 'Keep it logically awesome.', hook_id: 1 }
  const s = await setup(t, {
    routes: {
      [LIST]: { status: 200, body: [entry(903, GUID, 'ping', null)] },
      'GET /app/hook/deliveries/903': { status: 200, body: { ...detail(903, GUID, ping), event: 'ping', action: null } },
    },
  })
  const { code, stdout } = await s.fetchDelivery()
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { event: 'ping', action: null, repo: null })
})

test('an App with no webhook (GitHub answers 404) exits 4', async (t) => {
  const s = await setup(t, { routes: {} })
  const { code, stdout, stderr } = await s.fetchDelivery()
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.equal(stderr, 'review.ts delivery: the implementer App has no webhook deliveries (HTTP 404): set its webhook, or re-run /setup-forge\n')
})

test('broken credentials exit 4, call no API and print no secret', async (t) => {
  const s = await setup(t, { env: null })
  const { code, stdout, stderr } = await s.fetchDelivery()
  assert.equal(code, 4)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts delivery: the implementer App is enabled but its env file .*implementer-app\.env does not exist/)
  assertNoSecret(stderr)
  assert.deepEqual(s.api.requests, [])
})

test('a wrong key: GitHub answers 401 and it exits 4', async (t) => {
  const s = await setup(t)
  const other = await appKey(s.dir, 'other.pem')
  await writeFile(join(s.dir, 'implementer-app.env'), `HERO_FORGE_IMPLEMENTER_APP_ID=123456\nHERO_FORGE_IMPLEMENTER_APP_KEY=${other.pem}\n`)
  const { code, stderr } = await s.fetchDelivery()
  assert.equal(code, 4)
  assert.match(stderr, /list the App webhook deliveries failed: HTTP 401/)
  assertNoSecret(stderr)
})

const USAGE: [string, string[], RegExp][] = [
  ['no --app', ['--delivery', GUID, '--out', '/tmp/x'], /--app must be reviewer or implementer/],
  ['a delivery id with a space', ['--app', 'reviewer', '--delivery', 'a b', '--out', '/tmp/x'], /--delivery must be the X-GitHub-Delivery id/],
  ['no --out', ['--app', 'reviewer', '--delivery', GUID], /delivery needs --out/],
]

for (const [name, args, message] of USAGE) {
  test(`a usage error exits 2 and calls no API: ${name}`, async (t) => {
    const s = await setup(t)
    const { code, stderr } = await runCli(['delivery', ...args], { env: { ...baseEnv(), HERO_FORGE_GITHUB_API_URL: s.api.url } })
    assert.equal(code, 2)
    assert.match(stderr, message)
    assert.deepEqual(s.api.requests, [])
  })
}
