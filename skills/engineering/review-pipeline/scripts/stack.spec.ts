// The stack subcommands of implement-spec-stack: order, restack, merge-layer, path.
import assert from 'node:assert/strict'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { appKey, baseEnv, fakeGh, fakeGitHubApi, run, runCli, seedState, tempDir, type FakeGhResponse } from './test-helpers.ts'

const REPO = 'contract-hero/hero-pocock'
const REPO_URL = `https://api.github.com/repos/${REPO}`

type Ticket = { title?: string; state?: string; blockedBy?: (number | { number: number; state?: string; repo?: string })[] }

// Canned gh answers for a spec #2 whose sub-issues are `tickets`.
function graph(tickets: Record<number, Ticket>): FakeGhResponse[] {
  const lines = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '')
  const responses: FakeGhResponse[] = [
    {
      match: 'issues/2/sub_issues',
      stdout: lines(
        Object.entries(tickets).map(([n, t]) => ({ number: Number(n), title: t.title ?? `Ticket ${n}`, state: t.state ?? 'open' })),
      ),
    },
  ]
  for (const [n, t] of Object.entries(tickets)) {
    const blockers = (t.blockedBy ?? []).map((b) => {
      const one = typeof b === 'number' ? { number: b } : b
      const state = one.state ?? tickets[one.number]?.state ?? 'open'
      return { number: one.number, state, repository_url: one.repo ?? REPO_URL }
    })
    responses.push({ match: `issues/${n}/dependencies/blocked_by`, stdout: lines(blockers) })
  }
  return responses
}

async function order(t: Parameters<typeof tempDir>[0], tickets: Record<number, Ticket>) {
  const dir = await tempDir(t)
  const gh = await fakeGh(dir, graph(tickets))
  const result = await runCli(['stack', 'order', '--repo', REPO, '--spec', '2'], { env: gh.env })
  return { ...result, gh }
}

// The plan without titles and branches, for short assertions.
function shape(stdout: string) {
  const plan = JSON.parse(stdout)
  return {
    layers: plan.layers.map((l: { ticket: number; parent: number | null; children: number[] }) => [l.ticket, l.parent, l.children]),
    rewired: plan.rewired,
    excluded: plan.excluded,
  }
}

test('order stacks a chain of tickets along blocked_by, each on its blocker', async (t) => {
  const { code, stdout, stderr } = await order(t, { 4: {}, 5: { blockedBy: [4] }, 6: { blockedBy: [5] } })
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(shape(stdout), {
    layers: [
      [4, null, [5]],
      [5, 4, [6]],
      [6, 5, []],
    ],
    rewired: [],
    excluded: [],
  })
})

test('order skips closed tickets, bases a ticket on its deepest blocker, and keeps siblings side by side', async (t) => {
  const { code, stdout, stderr } = await order(t, {
    3: { state: 'closed' },
    4: { blockedBy: [3] },
    5: { blockedBy: [4] },
    6: { blockedBy: [4, 5] },
    9: { blockedBy: [4] },
  })
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(shape(stdout), {
    layers: [
      [4, null, [5, 9]],
      [5, 4, [6]],
      [9, 4, []],
      [6, 5, []],
    ],
    rewired: [],
    excluded: [],
  })
})

test('order serializes two independent blockers: the branch of the deeper one stacks onto the other', async (t) => {
  const { code, stdout, stderr } = await order(t, {
    4: {},
    5: { blockedBy: [4] },
    8: {},
    9: { blockedBy: [8] },
    10: { blockedBy: [5, 9] },
  })
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(shape(stdout), {
    layers: [
      [4, null, [5]],
      [5, 4, [8]],
      [8, 5, [9]],
      [9, 8, [10]],
      [10, 9, []],
    ],
    rewired: [{ ticket: 8, from: null, to: 5, for: 10 }],
    excluded: [],
  })
})

test('order leaves out a ticket with an open blocker outside the spec, and every ticket that waits on it', async (t) => {
  const { code, stdout, stderr } = await order(t, {
    4: {},
    5: { blockedBy: [4, { number: 99, repo: 'https://api.github.com/repos/someone/else' }] },
    6: { blockedBy: [5] },
    7: { blockedBy: [4, { number: 30 }, { number: 31, state: 'closed' }] },
    8: { blockedBy: [4] },
  })
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(shape(stdout), {
    layers: [
      [4, null, [8]],
      [8, 4, []],
    ],
    rewired: [],
    excluded: [
      { ticket: 5, reason: 'blocked by someone/else#99, an open issue outside spec #2' },
      { ticket: 6, reason: 'blocked by #5, which is not in the stack' },
      { ticket: 7, reason: 'blocked by #30, an open issue outside spec #2' },
    ],
  })
})

test('order prints each layer with its title, branch, depth and open blockers', async (t) => {
  const { code, stdout } = await order(t, {
    10: { title: 'implement-pr: ticket to draft PR' },
    11: { title: 'implement-spec-stack: stacked PRs, final stack review, bottom-up landing', blockedBy: [10] },
  })
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), {
    repo: REPO,
    spec: 2,
    layers: [
      { ticket: 10, title: 'implement-pr: ticket to draft PR', branch: 'ticket/10-implement-pr-ticket-to-draft-pr', parent: null, depth: 1, blockers: [], children: [11] },
      {
        ticket: 11,
        title: 'implement-spec-stack: stacked PRs, final stack review, bottom-up landing',
        branch: 'ticket/11-implement-spec-stack-stacked-prs-final',
        parent: 10,
        depth: 2,
        blockers: [10],
        children: [],
      },
    ],
    rewired: [],
    excluded: [],
  })
})

test('order refuses a spec with no open sub-issues', async (t) => {
  const { code, stderr } = await order(t, { 4: { state: 'closed' } })
  assert.equal(code, 1)
  assert.equal(stderr, 'review.ts stack: spec #2 has no open sub-issues: nothing to stack\n')
})

test('order reports a gh failure and exits 1', async (t) => {
  const dir = await tempDir(t)
  const gh = await fakeGh(dir, [{ match: 'sub_issues', stderr: 'HTTP 404: Not Found\n', exit: 1 }])
  const { code, stderr } = await runCli(['stack', 'order', '--repo', REPO, '--spec', '2'], { env: gh.env })
  assert.equal(code, 1)
  assert.equal(stderr, 'review.ts stack: cannot list the sub-issues of #2: HTTP 404: Not Found\n')
})

test('order rejects a bad --spec as a usage error', async (t) => {
  const dir = await tempDir(t)
  const gh = await fakeGh(dir)
  const { code, stderr } = await runCli(['stack', 'order', '--repo', REPO, '--spec', 'two'], { env: gh.env })
  assert.equal(code, 2)
  assert.match(stderr, /^review\.ts stack: --spec must be a positive whole number\nusage:/)
})

// A real git repo for restack: main has a.txt (lines 1 to 10); the parent
// layer adds p.txt; the child layer, cut from the parent, edits line 5 and
// adds c.txt. `land` squash-merges the parent into main, as GitHub does.
async function layers(t: Parameters<typeof tempDir>[0]) {
  const dir = await tempDir(t)
  const env = {
    ...baseEnv(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  const git = async (...args: string[]) => {
    const r = await run('git', args, { cwd: dir, env })
    assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const write = (name: string, text: string) => writeFile(join(dir, name), text)
  const lines = (change: Record<number, string> = {}) =>
    Array.from({ length: 10 }, (_, i) => change[i + 1] ?? String(i + 1)).join('\n') + '\n'
  await git('init', '-q', '-b', 'main')
  await write('a.txt', lines())
  await git('add', '.')
  await git('commit', '-qm', 'base')
  await git('checkout', '-qb', 'parent')
  await write('p.txt', 'parent\n')
  await git('add', '.')
  await git('commit', '-qm', 'parent layer')
  await git('checkout', '-qb', 'child')
  await write('a.txt', lines({ 5: 'five' }))
  await git('commit', '-qam', 'child edits line 5')
  await write('c.txt', 'child\n')
  await git('add', '.')
  await git('commit', '-qm', 'child adds c.txt')
  const parentTip = await git('rev-parse', 'parent')
  const childTip = await git('rev-parse', 'child')
  const land = async (mainChange: Record<number, string> = {}) => {
    await git('checkout', '-q', 'main')
    await git('merge', '-q', '--squash', 'parent')
    await git('commit', '-qm', 'parent layer (#1)')
    if (Object.keys(mainChange).length > 0) {
      await write('a.txt', lines(mainChange))
      await git('commit', '-qam', 'another change on main')
    }
    await git('checkout', '-q', 'child')
  }
  // A stack-final fix: one more commit on the parent after the child branched.
  const fixParent = async () => {
    await git('checkout', '-q', 'parent')
    await write('p.txt', 'parent, fixed\n')
    await git('commit', '-qam', 'apply review round 1')
    await git('checkout', '-q', 'child')
    return git('rev-parse', 'parent')
  }
  const restack = (from = parentTip, over: Record<string, string> = {}) =>
    runCli(['stack', 'restack', '--from', from, '--onto', 'main'], { cwd: dir, env: { ...env, ...over } })
  // A git first on PATH that fails `git range-diff` and runs every other git
  // command as usual.
  const brokenRangeDiff = async () => {
    const real = (await run('sh', ['-c', 'command -v git'])).stdout.trim()
    const bin = join(dir, '..', `${dir.split('/').pop()}-bin`)
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = range-diff ]; then echo "range-diff broke" >&2; exit 1; fi\nexec "${real}" "$@"\n`)
    await chmod(join(bin, 'git'), 0o755)
    return { PATH: `${bin}:${process.env.PATH ?? ''}` }
  }
  return { dir, gitEnv: env, git, write, lines, parentTip, childTip, land, fixParent, restack, brokenRangeDiff }
}

test('restack keeps only the child commits when the parent got a fix after the child branched', async (t) => {
  const s = await layers(t)
  const fixedTip = await s.fixParent()
  await s.land()
  const { code, stdout, stderr } = await s.restack(fixedTip)
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout).same, true)
  assert.equal(JSON.parse(stdout).commits, 2)
  assert.equal(await s.git('log', '--format=%s', 'main..HEAD'), 'child adds c.txt\nchild edits line 5')
  assert.equal(await s.git('show', 'HEAD:p.txt'), 'parent, fixed')
})

test('restack moves a layer onto main from the landed parent tip when the range-diff shows no content change', async (t) => {
  const s = await layers(t)
  await s.land()
  const { code, stdout, stderr } = await s.restack()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const head = await s.git('rev-parse', 'HEAD')
  assert.deepEqual(JSON.parse(stdout), {
    branch: 'child',
    from: s.parentTip,
    onto: 'main',
    old_tip: s.childTip,
    new_tip: head,
    commits: 2,
    same: true,
  })
  // Only the child's own commits sit on main, and nothing of the parent is duplicated.
  assert.equal(await s.git('log', '--format=%s', 'main..HEAD'), 'child adds c.txt\nchild edits line 5')
  assert.equal(await s.git('diff', '--name-only', 'main', 'HEAD'), 'a.txt\nc.txt')
})

test('restack restores the layer and stops when the rebase conflicts', async (t) => {
  const s = await layers(t)
  await s.land({ 5: 'FIVE' })
  const { code, stdout, stderr } = await s.restack()
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /^review\.ts stack: the rebase of child onto main conflicts: aborted, child is back at [0-9a-f]{40}\n$/)
  assert.equal(await s.git('rev-parse', 'HEAD'), s.childTip)
  assert.equal(await s.git('status', '--porcelain'), '')
})

test('restack restores the layer and stops when the range-diff shows a content change', async (t) => {
  const s = await layers(t)
  await s.land({ 3: 'three' })
  const { code, stdout, stderr } = await s.restack()
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.match(
    stderr,
    /^review\.ts stack: the range-diff of child shows a content change \(1 of 2 commits differ\): child is back at [0-9a-f]{40}, the rebased result was [0-9a-f]{40}\n/,
  )
  assert.equal(await s.git('rev-parse', 'HEAD'), s.childTip)
})

test('restack puts the layer back when git range-diff fails after the rebase', async (t) => {
  const s = await layers(t)
  await s.land()
  const { code, stdout, stderr } = await s.restack(s.parentTip, await s.brokenRangeDiff())
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, `review.ts stack: git range-diff failed: range-diff broke. child is back at ${s.childTip}\n`)
  assert.equal(await s.git('rev-parse', 'HEAD'), s.childTip)
  assert.equal(await s.git('status', '--porcelain'), '')
})

test('restack refuses a layer with no commits of its own after --from, and moves nothing', async (t) => {
  const s = await layers(t)
  await s.land()
  const { code, stdout, stderr } = await s.restack(s.childTip)
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, `review.ts stack: child has no commits of its own after --from ${s.childTip}: there is nothing to restack. Check --from\n`)
  assert.equal(await s.git('rev-parse', 'HEAD'), s.childTip)
})

test('restack refuses a worktree with uncommitted changes', async (t) => {
  const s = await layers(t)
  await s.land()
  await s.write('c.txt', 'edited\n')
  const { code, stderr } = await s.restack()
  assert.equal(code, 1)
  assert.equal(stderr, 'review.ts stack: the worktree has uncommitted changes: commit or remove them before restack\n')
  assert.equal(await s.git('rev-parse', 'HEAD'), s.childTip)
})

test('restack refuses a --from that cuts no deeper into the layer than --onto', async (t) => {
  const s = await layers(t)
  await s.land()
  const mainTip = await s.git('rev-parse', 'main')
  const { code, stderr } = await s.restack(mainTip)
  assert.equal(code, 1)
  assert.equal(
    stderr,
    `review.ts stack: --from ${mainTip} cuts no deeper into child than --onto main: pass the parent layer's pre-landing tip\n`,
  )
})

const SHA = 'c'.repeat(40)
const MERGE_COMMIT = 'e'.repeat(40)
const BASE_VIEW = ['pr', 'view', '13', '--repo', REPO, '--json', 'baseRefName']
const GATE_VIEW = ['pr', 'view', '13', '--repo', REPO, '--json', 'state,isDraft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup']
const SQUASH = ['pr', 'merge', '13', '--repo', REPO, '--squash', '--match-head-commit', SHA]
const VERIFY = ['pr', 'view', '13', '--repo', REPO, '--json', 'state,mergeCommit']

function prView(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: 'OPEN',
    isDraft: false,
    headRefOid: SHA,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    ...over,
  })
}

type LayerRun = {
  mode?: string
  phase?: string
  base?: string
  view?: string
  // The stack-final run of the whole stack (PR #20): its phase and mode.
  stack?: { phase?: string; mode?: string } | null
}

// A run state for layer PR #13 at `phase` with a passing re-check at its
// head, the stack-final run (PR #20, complete by default), a config, and a
// fake gh that answers a PR based on `base` with a green gate.
async function layerRun(t: Parameters<typeof tempDir>[0], options: LayerRun = {}) {
  const dir = await tempDir(t)
  const gh = await fakeGh(dir)
  const root = join(dir, 'state')
  const env = { ...gh.env, HERO_POCOCK_STATE_DIR: root }
  const config = join(dir, 'review.md')
  await writeFile(config, '```yaml\nruntime: claude\n```\n')
  await seedState(root, {
    base_ref: 'ticket/4-parent',
    head_ref: 'ticket/5-child',
    head_sha: SHA,
    mode: options.mode ?? 'layer',
    phase: options.phase ?? 'complete',
    gates: [{ round: 1, commit: SHA, result: 'pass' }],
  })
  if (options.stack !== null) {
    await seedState(root, {
      pr: 20,
      head_ref: 'stack/spec-2',
      mode: options.stack?.mode ?? 'stack-final',
      phase: options.stack?.phase ?? 'complete',
    })
  }
  await gh.respond([
    { match: 'baseRefName', stdout: JSON.stringify({ baseRefName: options.base ?? 'main' }) },
    { match: 'mergeStateStatus', stdout: options.view ?? prView() },
    { match: 'state,mergeCommit', stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: MERGE_COMMIT } }) },
  ])
  const mergeLayer = (...extra: string[]) =>
    runCli(['stack', 'merge-layer', '--repo', REPO, '--pr', '13', '--base', 'main', '--stack-pr', '20', '--config', config, ...extra], { env })
  return { gh, env, mergeLayer }
}

test('merge-layer squash-merges a reviewed layer at its re-checked head once its base is the default branch', async (t) => {
  const s = await layerRun(t)
  const { code, stdout, stderr } = await s.mergeLayer()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { merged: true, already: false, merge_commit: MERGE_COMMIT })
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [BASE_VIEW, GATE_VIEW, SQUASH, VERIFY])
})

test('merge-layer refuses a layer whose PR still targets its parent layer branch', async (t) => {
  const s = await layerRun(t, { base: 'ticket/4-parent' })
  const { code, stderr } = await s.mergeLayer()
  assert.equal(code, 1)
  assert.equal(
    stderr,
    'review.ts stack: PR #13 targets ticket/4-parent, not main: restack it onto main and run gh pr edit 13 --base main first\n',
  )
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [BASE_VIEW])
})

test('merge-layer refuses a run that is not a stack layer', async (t) => {
  const s = await layerRun(t, { mode: 'single' })
  const { code, stderr } = await s.mergeLayer()
  assert.equal(code, 1)
  assert.equal(stderr, 'review.ts stack: the run for PR #13 is in single mode, not layer: use review.ts merge\n')
  assert.deepEqual(await s.gh.calls(), [])
})

test('merge-layer refuses a layer whose review has not passed', async (t) => {
  const s = await layerRun(t, { phase: 'review-posted' })
  const { code, stderr } = await s.mergeLayer()
  assert.equal(code, 1)
  assert.equal(stderr, 'review.ts stack: merge-layer needs phase complete (the layer review passed), but PR #13 is at review-posted\n')
  assert.deepEqual(await s.gh.calls(), [])
})

for (const phase of ['review-posted', 'rechecked', 'explained']) {
  test(`merge-layer waits for the stack-final review: a stack run at ${phase} lands nothing`, async (t) => {
    const s = await layerRun(t, { stack: { phase } })
    const { code, stderr } = await s.mergeLayer()
    assert.equal(code, 1)
    assert.equal(
      stderr,
      `review.ts stack: merge-layer waits for the review of the whole stack: the stack-final run of PR #20 is at ${phase}, not complete\n`,
    )
    assert.deepEqual(await s.gh.calls(), [])
  })
}

test('merge-layer refuses a --stack-pr whose run is not the stack-final review', async (t) => {
  const s = await layerRun(t, { stack: { mode: 'single' } })
  const { code, stderr } = await s.mergeLayer()
  assert.equal(code, 1)
  assert.equal(stderr, 'review.ts stack: PR #20 is not the review of a whole stack: its run is in single mode, not stack-final\n')
  assert.deepEqual(await s.gh.calls(), [])
})

test('merge-layer with no run state for the stack PR exits 3', async (t) => {
  const s = await layerRun(t, { stack: null })
  const { code, stderr } = await s.mergeLayer()
  assert.equal(code, 3)
  assert.match(stderr, /no run state for PR #20/)
  assert.deepEqual(await s.gh.calls(), [])
})

test('merge-layer needs --stack-pr (usage error)', async (t) => {
  const s = await layerRun(t)
  const { code, stderr } = await runCli(['stack', 'merge-layer', '--repo', REPO, '--pr', '13', '--base', 'main'], { env: s.env })
  assert.equal(code, 2)
  assert.match(stderr, /^review\.ts stack: --stack-pr must be a positive whole number/)
})

test('merge-layer does not merge a layer with no passing re-check at its head', async (t) => {
  const s = await layerRun(t)
  await seedState(s.env.HERO_POCOCK_STATE_DIR!, {
    base_ref: 'ticket/4-parent', head_ref: 'ticket/5-child', head_sha: SHA, mode: 'layer', phase: 'complete', gates: [],
  })
  const { code, stderr } = await s.mergeLayer()
  assert.equal(code, 1)
  assert.match(stderr, /gate stop.*no re-check is recorded at the head/)
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [BASE_VIEW, GATE_VIEW])
})

// Landing without the App: a restack moved the head, so the gate is run again
// at the new head with `post-review --kind recheck`, which records it there.
test('merge-layer lands a restacked layer without the App once the re-check is posted again at the new head', async (t) => {
  const s = await layerRun(t)
  const root = s.env.HERO_POCOCK_STATE_DIR!
  const old = 'd'.repeat(40)
  await seedState(root, {
    base_ref: 'ticket/4-parent', head_ref: 'ticket/5-child', head_sha: SHA, mode: 'layer', phase: 'complete',
    gates: [{ round: 1, commit: old, result: 'pass' }],
  })
  const stopped = await s.mergeLayer()
  assert.equal(stopped.code, 1)
  assert.match(stopped.stderr, /gate stop.*no re-check is recorded at the head/)

  const dir = join(root, '..')
  const config = join(dir, 'review.md')
  const files = { ledger: join(dir, 'findings.json'), recheck: join(dir, 'recheck-r1.json'), payload: join(dir, 'landing.json') }
  await writeFile(files.ledger, '[]')
  await writeFile(files.recheck, JSON.stringify({ items: [] }))
  await writeFile(files.payload, JSON.stringify({ event: 'COMMENT', body: '## Re-check: landing', comments: [] }))
  await s.gh.respond([
    { match: 'api user', stdout: 'alilloig\n' },
    { match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 880 }) },
    { match: 'baseRefName', stdout: JSON.stringify({ baseRefName: 'main' }) },
    { match: 'mergeStateStatus', stdout: prView() },
    { match: 'state,mergeCommit', stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: MERGE_COMMIT } }) },
  ])
  const rechecked = await runCli(
    ['post-review', '--repo', REPO, '--pr', '13', '--commit', SHA, '--round', '1', '--kind', 'recheck', '--payload', files.payload,
      '--config', config, '--ledger', files.ledger, '--recheck', files.recheck],
    { env: s.env },
  )
  assert.equal(rechecked.code, 0, rechecked.stderr)
  assert.equal(JSON.parse(rechecked.stdout).gate, 'pass')
  const landed = await s.mergeLayer()
  assert.equal(landed.stderr, '')
  assert.equal(landed.code, 0)
  assert.deepEqual(JSON.parse(landed.stdout), { merged: true, already: false, merge_commit: MERGE_COMMIT })
})

test('merge-layer does not merge when the gate stops (the head moved after the re-check)', async (t) => {
  const s = await layerRun(t, { view: prView({ headRefOid: 'd'.repeat(40) }) })
  const { code, stderr } = await s.mergeLayer()
  assert.equal(code, 1)
  assert.match(stderr, /^review\.ts stack: not merging PR #13 \(gate stop\): the head moved since the re-check/)
  assert.deepEqual((await s.gh.calls()).map((c) => c.argv), [BASE_VIEW, GATE_VIEW])
})

test('path prints the stack dir of a spec beside the per-PR run dirs', async (t) => {
  const dir = await tempDir(t)
  const { code, stdout } = await runCli(['stack', 'path', '--spec', '2'], { env: { ...baseEnv(), HERO_POCOCK_STATE_DIR: join(dir, 'state') } })
  assert.equal(code, 0)
  assert.equal(stdout, `${join(dir, 'state', 'stack-2')}\n`)
})

test('order stops on a blocked_by cycle and names the tickets in it', async (t) => {
  const { code, stdout, stderr } = await order(t, {
    4: {},
    5: { blockedBy: [4, 7] },
    6: { blockedBy: [5] },
    7: { blockedBy: [6] },
  })
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.equal(
    stderr,
    'review.ts stack: the blocked_by graph has a cycle: #5 -> #7 -> #6 -> #5 (each is blocked by the next). Break the cycle on the issue tracker, then run order again\n',
  )
})

// Landing a restacked layer with the reviewer App (#24). The layer's run
// approved its old tip (review 600). After the parent lands, `restack --pr`
// moves the layer, and GitHub shows review 600 on the new tip.
const BOT = 'hero-reviewer[bot]'
const VERDICT_MARKER = '<!-- hero-pocock:review-pipeline pr=13 round=1 kind=verdict -->'

async function appLanding(t: Parameters<typeof tempDir>[0], mainChange: Record<number, string> = {}, over: Record<string, unknown> = {}) {
  const s = await layers(t)
  await s.land(mainChange)
  // origin/HEAD names main, the default branch, as after a clone.
  await s.git('update-ref', 'refs/remotes/origin/main', 'main')
  await s.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const dir = await tempDir(t)
  const gh = await fakeGh(dir)
  const key = await appKey(dir)
  const api = await fakeGitHubApi(t, key.publicKey, {
    'GET /repos/contract-hero/hero-pocock/installation': { status: 200, body: { id: 4242 } },
    'POST /app/installations/4242/access_tokens': { status: 201, body: { token: 'ghs_faketoken0123456789' } },
    'GET /app': { status: 200, body: { slug: 'hero-reviewer' } },
  })
  const envFile = join(dir, 'reviewer-app.env')
  await writeFile(envFile, `HERO_POCOCK_REVIEWER_APP_ID=123456\nHERO_POCOCK_REVIEWER_APP_KEY=${key.pem}\n`)
  const root = join(dir, 'state')
  const env = {
    ...gh.env,
    HERO_POCOCK_STATE_DIR: root,
    HERO_POCOCK_REVIEWER_APP_ENV: envFile,
    HERO_POCOCK_GITHUB_API_URL: api.url,
  }
  await seedState(root, {
    base_ref: 'parent', head_ref: 'child', head_sha: s.childTip, mode: 'layer', phase: 'complete',
    reviewer_login: BOT,
    reviews: [
      { round: 1, kind: 'review', id: 555, commit: s.childTip, as: BOT, event: 'COMMENT' },
      { round: 1, kind: 'verdict', id: 600, commit: s.childTip, as: BOT, event: 'APPROVE' },
    ],
    gates: [{ round: 1, commit: s.childTip, result: 'pass' }],
    ...over,
  })
  const config = join(dir, 'review.md')
  await writeFile(config, '```yaml\nruntime: claude\napp: enabled\n```\n')
  const files = { ledger: join(dir, 'findings.json'), recheck: join(dir, 'recheck-r1.json'), payload: join(dir, 'verdict-landing.json') }
  await writeFile(files.ledger, '[]')
  await writeFile(files.recheck, JSON.stringify({ items: [] }))
  await writeFile(files.payload, JSON.stringify({ event: 'APPROVE', body: '## Verdict: landing', comments: [] }))
  // GitHub carried review 600 to `head`.
  const carriedTo = (head: string) =>
    gh.respond([
      { match: '--paginate --jq .[] | {id, state, body', stdout: `${JSON.stringify({ id: 600, state: 'APPROVED', body: `## Verdict: round 1\n\n${VERDICT_MARKER}`, commit_id: head, login: BOT })}\n` },
      { match: '--paginate --jq .[] | {id, state, commit_id', stdout: `${JSON.stringify({ id: 600, state: 'APPROVED', commit_id: head, login: BOT })}\n` },
      { match: 'pulls/13/reviews --input', stdout: JSON.stringify({ id: 880 }) },
      { match: 'mergeStateStatus', stdout: prView({ headRefOid: head }) },
    ])
  const verdict = (head: string) =>
    runCli(
      ['post-review', '--repo', REPO, '--pr', '13', '--commit', head, '--round', '1', '--kind', 'verdict', '--payload', files.payload,
        '--config', config, '--ledger', files.ledger, '--recheck', files.recheck],
      { env },
    )
  const cli = (...args: string[]) => runCli(args, { env })
  const restack = (onto = 'origin/main') =>
    runCli(['stack', 'restack', '--from', s.parentTip, '--onto', onto, '--pr', '13'], { cwd: s.dir, env: { ...s.gitEnv, HERO_POCOCK_STATE_DIR: root } })
  return { ...s, gh, env, root, config, restack, carriedTo, verdict, cli }
}

test('restack --pr records a restack with no content change, so post-review records the approval GitHub carried, and the gate says go', async (t) => {
  const s = await appLanding(t)
  const restacked = await s.restack()
  assert.equal(restacked.stderr, '')
  assert.equal(restacked.code, 0)
  const head = JSON.parse(restacked.stdout).new_tip
  assert.equal(JSON.parse(restacked.stdout).recorded, true)
  assert.equal((await s.cli('run-state', 'set', '--pr', '13', 'head_sha', head)).code, 0)

  await s.carriedTo(head)
  const posted = await s.verdict(head)
  assert.equal(posted.stderr, '')
  assert.equal(posted.code, 0)
  assert.deepEqual(JSON.parse(posted.stdout), { posted: false, duplicate: true, id: 600, carried_from: s.childTip, gate: 'pass', problems: [] })
  assert.ok((await s.gh.calls()).every((c) => !c.argv.includes('POST')))

  // No hand edit of the run state: the merge gate finds the approval at the new head.
  const gate = await s.cli('merge-gate', '--repo', REPO, '--pr', '13', '--config', s.config)
  assert.equal(gate.stderr, '')
  assert.equal(JSON.parse(gate.stdout).gate, 'go')
})

test('a restack with a content change records no restack, so a carried approval is not recorded and a fresh APPROVE posts', async (t) => {
  const s = await appLanding(t, { 3: 'three' })
  const before = await readdir(join(s.root, 'pr-13'))
  const restacked = await s.restack()
  assert.equal(restacked.code, 1)
  assert.match(restacked.stderr, /shows a content change/)
  assert.deepEqual(await readdir(join(s.root, 'pr-13')), before)

  // Even if the head moves anyway and GitHub shows the old approval on it,
  // the new head gets a fresh APPROVE.
  const head = 'f'.repeat(40)
  assert.equal((await s.cli('run-state', 'set', '--pr', '13', 'head_sha', head)).code, 0)
  await s.carriedTo(head)
  const posted = await s.verdict(head)
  assert.equal(posted.stderr, '')
  assert.equal(posted.code, 0)
  assert.deepEqual(JSON.parse(posted.stdout), {
    posted: true, id: 880, as: BOT, event: 'APPROVE', round: 1, kind: 'verdict', gate: 'pass', problems: [],
  })
})

test('restack --pr refuses a PR with no run state before it moves anything (exit 3)', async (t) => {
  const s = await layers(t)
  await s.land()
  const root = await tempDir(t)
  const { code, stderr } = await runCli(['stack', 'restack', '--from', s.parentTip, '--onto', 'main', '--pr', '13'], {
    cwd: s.dir,
    env: { ...s.gitEnv, HERO_POCOCK_STATE_DIR: root },
  })
  assert.equal(code, 3)
  assert.match(stderr, /no run state for PR #13/)
  assert.equal(await s.git('rev-parse', 'HEAD'), s.childTip)
})

// The restack record says the new tip holds only reviewed content, so
// restack --pr checks what it moves, and onto what, before it moves anything.
const REFUSED_RESTACK = [
  ['a branch that is not the head of the PR', {}, 'origin/main', { head_ref: 'ticket/9-other' },
    /^review\.ts stack: the checked-out branch child is not the head of PR #13 \(ticket\/9-other\): check --pr\n$/],
  ['an --onto that is not the default branch', { 7: 'unreviewed' }, 'side', {},
    /^review\.ts stack: --onto side is not the default branch \(origin\/HEAD is at [0-9a-f]{40}\): a layer moves onto the default branch only\n$/],
] as const

for (const [name, sideChange, onto, over, message] of REFUSED_RESTACK) {
  test(`restack --pr refuses ${name}, moves nothing, and records nothing`, async (t) => {
    const s = await appLanding(t, {}, over)
    // `side`: main plus a commit that no review saw.
    await s.git('checkout', '-qb', 'side', 'main')
    if (Object.keys(sideChange).length > 0) {
      await s.write('a.txt', s.lines(sideChange))
      await s.git('commit', '-qam', 'unreviewed change')
    }
    await s.git('checkout', '-q', 'child')
    const before = await readdir(join(s.root, 'pr-13'))
    const { code, stdout, stderr } = await s.restack(onto)
    assert.equal(code, 1)
    assert.equal(stdout, '')
    assert.match(stderr, message)
    assert.equal(await s.git('rev-parse', 'HEAD'), s.childTip)
    assert.deepEqual(await readdir(join(s.root, 'pr-13')), before)
  })
}

test('restack --pr of a layer that moved since the run pinned its head passes, but records nothing', async (t) => {
  const pinned = 'b'.repeat(40)
  const s = await appLanding(t, {}, { head_sha: pinned })
  const before = await readdir(join(s.root, 'pr-13'))
  const { code, stdout, stderr } = await s.restack()
  assert.equal(stderr, '')
  assert.equal(code, 0)
  const out = JSON.parse(stdout)
  assert.equal(out.same, true)
  assert.equal(out.recorded, false)
  assert.equal(out.not_recorded, `the old tip ${s.childTip} is not the head PR #13 pinned (${pinned}), so no review carries to the new tip`)
  assert.deepEqual(await readdir(join(s.root, 'pr-13')), before)
})

test('restack --pr that cannot write its record puts the branch back at its old tip and exits 1', async (t) => {
  const s = await appLanding(t)
  const runDir = join(s.root, 'pr-13')
  const state = await readFile(join(runDir, 'state.json'), 'utf8')
  // A run dir the CLI can read but not write; made writable again at once,
  // so the temp dirs can be removed.
  await chmod(runDir, 0o500)
  const { code, stdout, stderr } = await s.restack().finally(() => chmod(runDir, 0o700))
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.match(stderr, new RegExp(`^review\\.ts stack: cannot write the restack record of PR #13: .*\\. child is back at ${s.childTip}\\n$`))
  assert.equal(await s.git('rev-parse', 'HEAD'), s.childTip)
  assert.equal(await s.git('status', '--porcelain'), '')
  assert.deepEqual(await readdir(runDir), ['state.json'])
  assert.equal(await readFile(join(runDir, 'state.json'), 'utf8'), state)
})
