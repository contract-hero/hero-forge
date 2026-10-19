// `review.ts delivery`: the router's payload comes from the App's own webhook
// deliveries on GitHub, never from the router prompt.
import assert from 'node:assert/strict'
import { readFile, symlink, writeFile } from 'node:fs/promises'
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
const entry = (id: number, guid: string, event = 'issues', action: string | null = 'labeled', deliveredAt = new Date().toISOString()) => ({
  id,
  guid,
  delivered_at: deliveredAt,
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

const HOURS = 3600 * 1000

// GitHub's signature has no timestamp, so a captured request could be sent to
// the T3 URL again later. T3 holds a request for at most 24 hours.
test('a delivery GitHub sent more than 25 hours ago is refused with exit 1 (a replay)', async (t) => {
  const old = new Date(Date.now() - 26 * HOURS).toISOString()
  const s = await setup(t, {
    routes: {
      [LIST]: { status: 200, body: [entry(902, GUID, 'issues', 'labeled', old)] },
      'GET /app/hook/deliveries/902': { status: 200, body: { ...detail(902, GUID, PAYLOAD), delivered_at: old } },
    },
  })
  const { code, stdout, stderr } = await s.fetchDelivery()
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, `review.ts delivery: delivery ${GUID} was sent at ${old}, more than 25 hours ago: a replay, or a request held too long\n`)
  await assert.rejects(readFile(s.out, 'utf8'), { code: 'ENOENT' })
})

test('a delivery GitHub sent 23 hours ago is still fetched', async (t) => {
  const recent = new Date(Date.now() - 23 * HOURS).toISOString()
  const s = await setup(t, {
    routes: {
      [LIST]: { status: 200, body: [entry(902, GUID, 'issues', 'labeled', recent)] },
      'GET /app/hook/deliveries/902': { status: 200, body: { ...detail(902, GUID, PAYLOAD), delivered_at: recent } },
    },
  })
  const { code, stderr } = await s.fetchDelivery()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(await readFile(s.out, 'utf8')), PAYLOAD)
})

test('an --out path that exists is refused with exit 1 and left as it was', async (t) => {
  const s = await setup(t)
  await writeFile(s.out, 'keep me\n')
  const { code, stdout, stderr } = await s.fetchDelivery()
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, `review.ts delivery: ${s.out} already exists: pass a fresh path in a private directory (mktemp -d)\n`)
  assert.equal(await readFile(s.out, 'utf8'), 'keep me\n')
})

test('an --out path that is a symlink is refused with exit 1, and its target is not written', async (t) => {
  const s = await setup(t)
  const target = join(s.dir, 'target.txt')
  await writeFile(target, 'keep me\n')
  await symlink(target, s.out)
  const { code, stderr } = await s.fetchDelivery()
  assert.equal(code, 1)
  assert.match(stderr, /already exists: pass a fresh path/)
  assert.equal(await readFile(target, 'utf8'), 'keep me\n')
})

test('a dangling symlink at --out is refused too', async (t) => {
  const s = await setup(t)
  const target = join(s.dir, 'nowhere.txt')
  await symlink(target, s.out)
  const { code, stderr } = await s.fetchDelivery()
  assert.equal(code, 1)
  assert.match(stderr, /already exists: pass a fresh path/)
  await assert.rejects(readFile(target, 'utf8'), { code: 'ENOENT' })
})

// GitHub pages the deliveries, newest first, with a cursor in the Link header.
const PAGE2 = 'GET /app/hook/deliveries?per_page=100&cursor=v1_200'
const next = (cursor: string) => ({ link: `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=${cursor}>; rel="next"` })

test('a delivery on the second page of the deliveries is found through the Link cursor', async (t) => {
  const s = await setup(t, {
    routes: {
      [LIST]: { status: 200, body: [entry(901, 'other-guid')], headers: next('v1_200') },
      [PAGE2]: { status: 200, body: [entry(902, GUID)] },
      'GET /app/hook/deliveries/902': { status: 200, body: detail(902, GUID, PAYLOAD) },
    },
  })
  const { code, stdout, stderr } = await s.fetchDelivery()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { event: 'issues', action: 'labeled', repo: 'contract-hero/hero-forge' })
  assert.deepEqual(s.api.requests.map((r) => r.path), [
    '/app/hook/deliveries?per_page=100',
    '/app/hook/deliveries?per_page=100&cursor=v1_200',
    '/app/hook/deliveries/902',
  ])
})

test('a missing delivery: each try walks every page, then it exits 3', async (t) => {
  const s = await setup(t, {
    routes: {
      [LIST]: { status: 200, body: [entry(901, 'other-guid')], headers: next('v1_200') },
      [PAGE2]: { status: 200, body: [entry(900, 'older-guid')] },
    },
  })
  const { code, stderr } = await s.fetchDelivery()
  assert.equal(code, 3)
  assert.match(stderr, /GitHub does not list delivery .* \(5 tries\)/)
  assert.deepEqual(s.api.requests.map((r) => r.path), Array.from({ length: 5 }, () => [
    '/app/hook/deliveries?per_page=100',
    '/app/hook/deliveries?per_page=100&cursor=v1_200',
  ]).flat())
})

test('the walk stops at a delivery older than 25 hours: no later page is read', async (t) => {
  const old = new Date(Date.now() - 26 * HOURS).toISOString()
  const s = await setup(t, {
    routes: {
      [LIST]: { status: 200, body: [entry(901, 'other-guid'), entry(900, 'old-guid', 'issues', 'labeled', old)], headers: next('v1_200') },
      [PAGE2]: { status: 200, body: [entry(902, GUID)] },
    },
  })
  const { code } = await s.fetchDelivery()
  assert.equal(code, 3)
  assert.ok(s.api.requests.every((r) => r.path === '/app/hook/deliveries?per_page=100'))
})

test('a Link to another host is never followed: only its cursor is used, on the configured API', async (t) => {
  const s = await setup(t, {
    routes: {
      [LIST]: { status: 200, body: [entry(901, 'other-guid')], headers: { link: '<https://evil.example/app/hook/deliveries?per_page=100&cursor=v1_200>; rel="next"' } },
      [PAGE2]: { status: 200, body: [entry(902, GUID)] },
      'GET /app/hook/deliveries/902': { status: 200, body: detail(902, GUID, PAYLOAD) },
    },
  })
  const { code } = await s.fetchDelivery()
  assert.equal(code, 0)
  assert.equal(s.api.requests[1]?.path, '/app/hook/deliveries?per_page=100&cursor=v1_200')
})

// GitHub's delivery ids are 64-bit numbers above 2^53, which a JS number
// rounds: the detail read must use the id's exact digits from the list text.
const BIG = '3849173578576568291'
test('a delivery id above 2^53 is read by its exact digits, not a rounded number', async (t) => {
  const listed = JSON.stringify([entry(901, 'other-guid'), entry(1, GUID)]).replace('"id":1,', `"id":${BIG},`)
  const s = await setup(t, {
    routes: {
      [LIST]: { status: 200, body: null, raw: listed },
      [`GET /app/hook/deliveries/${BIG}`]: { status: 200, body: detail(1, GUID, PAYLOAD) },
    },
  })
  const { code, stdout, stderr } = await s.fetchDelivery()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { event: 'issues', action: 'labeled', repo: 'contract-hero/hero-forge' })
  assert.deepEqual(JSON.parse(await readFile(s.out, 'utf8')), PAYLOAD)
  assert.deepEqual(s.api.requests.map((r) => r.path), ['/app/hook/deliveries?per_page=100', `/app/hook/deliveries/${BIG}`])
})

test('a 404 on the detail read names the delivery, not the credentials', async (t) => {
  const s = await setup(t, { routes: { [LIST]: { status: 200, body: [entry(902, GUID)] } } })
  const { code, stderr } = await s.fetchDelivery()
  assert.equal(code, 1)
  assert.match(stderr, new RegExp(`delivery ${GUID} \\(id 902\\) is listed, but GitHub has no detail for it \\(HTTP 404\\)`))
  assert.doesNotMatch(stderr, /Fix the App credentials/)
})
