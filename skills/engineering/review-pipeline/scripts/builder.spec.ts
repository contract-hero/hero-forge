// `review.ts builder`: a ticket's builder:<alias> label in, the builder the
// config on the default branch names for it out, or a refusal.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeGh, runCli, tempDir, type FakeGhResponse } from './test-helpers.ts'

const REPO = 'contract-hero/hero-forge'

const ASTRA = ['builders:', '  astra:', '    provider: codex', '    model: gpt-6.2-astra', '    effort: xhigh']

// A review.md on the default branch, with the given lines in its YAML block.
function reviewMd(...yaml: string[]): string {
  return `# Review pipeline\n\n\`\`\`yaml\n${['runtime: codex', ...yaml].join('\n')}\n\`\`\`\n`
}

// The default branch's review.md (null: not there), and the labels of issue #84.
function responses(review: string | null, labels: string[]): FakeGhResponse[] {
  return [
    review === null
      ? { match: 'contents/docs/agents/review.md', stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)\n', exit: 1 }
      : { match: 'contents/docs/agents/review.md', stdout: review },
    { match: `repos/${REPO}/issues/84`, stdout: `${JSON.stringify(labels)}\n` },
  ]
}

async function builder(t: Parameters<typeof tempDir>[0], review: string | null, labels: string[], extra: FakeGhResponse[] = []) {
  const dir = await tempDir(t)
  const gh = await fakeGh(dir, [...extra, ...responses(review, labels)])
  const result = await runCli(['builder', '--repo', REPO, '--issue', '84'], { env: gh.env })
  return { ...result, calls: await gh.calls() }
}

test('a ticket with a builder label gets the builder the default branch config names', async (t) => {
  const { code, stdout, stderr, calls } = await builder(t, reviewMd(...ASTRA), ['enhancement', 'builder:astra', 'ready-for-agent'])
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), {
    issue: 84,
    builder: { alias: 'astra', provider: 'codex', model: 'gpt-6.2-astra', effort: 'xhigh' },
  })
  // The config comes from the default branch: the contents API with no ref.
  assert.ok(calls.some((c) => c.argv.includes(`repos/${REPO}/contents/docs/agents/review.md`)))
})

test('a ticket with no builder label has no builder, and the config is not read', async (t) => {
  const { code, stdout, stderr, calls } = await builder(t, null, ['enhancement', 'ready-for-agent'])
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { issue: 84, builder: null })
  assert.ok(!calls.some((c) => c.argv.join(' ').includes('contents/docs/agents/review.md')))
})

test('a builder label is found whatever the case of its prefix', async (t) => {
  const { code, stdout } = await builder(t, reviewMd(...ASTRA), ['Builder:astra'])
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout).builder.alias, 'astra')
})

const refused: [string, string | null, string[], string][] = [
  [
    'an alias the config does not name',
    reviewMd(...ASTRA),
    ['builder:sol'],
    `#84 has the label builder:sol, but the config on the default branch of ${REPO} names no builder sol (it names: astra). Nothing is built on another model`,
  ],
  [
    'a builder label with no builders in the config',
    reviewMd(),
    ['builder:astra'],
    `#84 has the label builder:astra, but the config on the default branch of ${REPO} names no builder astra (it names: none). Nothing is built on another model`,
  ],
  [
    'a builder label with an empty alias',
    reviewMd(...ASTRA),
    ['builder:'],
    `#84 has the label builder:, but the config on the default branch of ${REPO} names no builder  (it names: astra). Nothing is built on another model`,
  ],
  [
    'two builder labels',
    reviewMd(...ASTRA),
    ['builder:astra', 'enhancement', 'builder:sol'],
    '#84 has 2 builder labels (builder:astra, builder:sol): keep one. Nothing is built on another model',
  ],
  [
    'a builder label and no config on the default branch',
    null,
    ['builder:astra'],
    `#84 has the label builder:astra, but ${REPO} has no docs/agents/review.md on its default branch. Nothing is built on another model`,
  ],
  [
    'a builder label and a config with a broken builder',
    reviewMd('builders:', '  astra:', '    provider: codex'),
    ['builder:astra'],
    `${REPO}:docs/agents/review.md:6: builders.astra.model is missing (a builder needs provider, model and effort). Edit the file or re-run /setup-forge.`,
  ],
]

for (const [name, review, labels, message] of refused) {
  test(`${name} exits 4 and names the cause`, async (t) => {
    const { code, stdout, stderr } = await builder(t, review, labels)
    assert.equal(stdout, '')
    assert.equal(stderr, `review.ts builder: ${message}\n`)
    assert.equal(code, 4)
  })
}

test('an issue gh cannot read exits 1 with its message', async (t) => {
  const { code, stdout, stderr } = await builder(t, reviewMd(...ASTRA), [], [
    { match: `repos/${REPO}/issues/84`, stderr: 'gh: Not Found (HTTP 404)\n', exit: 1 },
  ])
  assert.equal(stdout, '')
  assert.equal(stderr, `review.ts builder: cannot read the labels of #84 in ${REPO}: gh: Not Found (HTTP 404)\n`)
  assert.equal(code, 1)
})

test('a missing --issue is a usage error', async () => {
  const { code, stderr } = await runCli(['builder', '--repo', REPO])
  assert.equal(code, 2)
  assert.match(stderr, /usage: review\.ts builder --repo O\/R --issue N/)
})
