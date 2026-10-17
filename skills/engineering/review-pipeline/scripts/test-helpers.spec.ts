// The fake `gh` is shared by later subcommand tests, so it gets its own check.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeGh, run, tempDir } from './test-helpers.ts'

test('the fake gh logs each call and answers from the first matching response', async (t) => {
  const dir = await tempDir(t)
  const gh = await fakeGh(dir, [
    { match: 'pulls/7/reviews', stdout: '[{"id":1}]' },
    { match: 'pulls/7', stderr: 'HTTP 422', exit: 1 },
  ])

  const listed = await run('gh', ['api', 'repos/o/r/pulls/7/reviews'], { env: gh.env })
  assert.deepEqual(listed, { code: 0, stdout: '[{"id":1}]', stderr: '' })

  const rejected = await run('gh', ['api', '-X', 'POST', 'repos/o/r/pulls/7', '--input', '-'], {
    env: { ...gh.env, GH_TOKEN: 'ghs_fake' },
    stdin: '{"event":"COMMENT"}',
  })
  assert.deepEqual(rejected, { code: 1, stdout: '', stderr: 'HTTP 422' })

  const other = await run('gh', ['pr', 'view', '8'], { env: gh.env })
  assert.deepEqual(other, { code: 0, stdout: '', stderr: '' })

  assert.deepEqual(await gh.calls(), [
    { argv: ['api', 'repos/o/r/pulls/7/reviews'], gh_token: null, stdin: '' },
    { argv: ['api', '-X', 'POST', 'repos/o/r/pulls/7', '--input', '-'], gh_token: 'ghs_fake', stdin: '{"event":"COMMENT"}' },
    { argv: ['pr', 'view', '8'], gh_token: null, stdin: '' },
  ])
})
