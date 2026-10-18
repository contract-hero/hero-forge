// Tests that the repo ships as hero-forge 1.0.0, with the plugin version as
// the one version, read from the real files.
//   node --test scripts/release.spec.ts
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'node:test'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

function read(path: string) {
  return readFileSync(join(REPO, path), 'utf8')
}

// Every file git tracks or would track, as a path from the repo root.
function repoFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((path) => path !== '' && existsSync(join(REPO, path)) && statSync(join(REPO, path)).isFile())
}

test('the plugin manifest names hero-forge at 1.0.0', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json')) as { name: string; version: string }
  assert.equal(manifest.name, 'hero-forge')
  assert.equal(manifest.version, '1.0.0')
})

// The removed version sync script, built from parts so that this file does
// not name it.
const SYNC_SCRIPT = ['sync', 'plugin', 'version'].join('-')

test("Matt's release tooling is gone: no changesets, no version sync script, no release workflow", () => {
  assert.equal(existsSync(join(REPO, '.changeset')), false)
  assert.equal(existsSync(join(REPO, 'scripts', `${SYNC_SCRIPT}.mjs`)), false)
  assert.equal(existsSync(join(REPO, '.github/workflows/release.yml')), false)
})

test('package.json has no name, version, scripts or dependencies', () => {
  const pkg = JSON.parse(read('package.json')) as Record<string, unknown>
  for (const key of ['name', 'version', 'scripts', 'dependencies', 'devDependencies']) {
    assert.equal(key in pkg, false, `package.json still has ${key}`)
  }
})

test('no file outside the ADRs names the removed version sync script', () => {
  const hits = repoFiles()
    .filter((path) => !path.startsWith('.agents/adr/'))
    .filter((path) => read(path).includes(SYNC_SCRIPT))
  assert.deepEqual(hits, [])
})

test('the changelog starts at 1.0.0', () => {
  const headings = read('CHANGELOG.md').match(/^## .*$/gm) ?? []
  assert.equal(headings[0], '## 1.0.0')
})

test('the changelog gives the migration step for the config dir and its env file', () => {
  const changelog = read('CHANGELOG.md')
  const old = ['hero', 'pocock'].join('-')
  assert.ok(changelog.includes(`mv ~/.config/${old} ~/.config/hero-forge`), 'no command that moves the config dir')
  for (const key of ['HERO_FORGE_REVIEWER_APP_ID', 'HERO_FORGE_REVIEWER_APP_KEY']) {
    assert.ok(changelog.includes(key), `no rename of the env file key to ${key}`)
  }
})

test('the README is the hero-forge README: its title, the Claude Code install and setup-forge', () => {
  const readme = read('README.md')
  assert.match(readme, /^# hero-forge\n/)
  assert.ok(readme.includes('claude plugin install hero-forge@contract-hero'))
  assert.ok(readme.includes('/setup-forge'))
})

test('the README has no other-agent install, no invocation split and no copy of the upstream README', () => {
  const readme = read('README.md')
  assert.doesNotMatch(readme, /npx skills/)
  assert.doesNotMatch(readme, new RegExp(['Hero', 'Pocock'].join(' '), 'i'))
  assert.doesNotMatch(readme, /user-invoked|model-invoked/i)
  assert.doesNotMatch(readme, /Why These Skills Exist|What is different from upstream/i)
})

test('the README credits mattpocock/skills and links its README', () => {
  const readme = read('README.md')
  assert.ok(readme.includes('https://github.com/mattpocock/skills'))
  assert.match(readme, /https:\/\/github\.com\/mattpocock\/skills(\/blob\/main\/README\.md|#readme)/)
  assert.match(readme, /MIT/)
})

test('CLAUDE.md names ADR 0007 as the fork rule and does not tell agents to merge upstream', () => {
  const claude = read('CLAUDE.md')
  assert.ok(claude.includes('0007-hero-forge-is-a-hard-fork.md'))
  assert.doesNotMatch(claude, /git merge upstream/)
  assert.doesNotMatch(claude, /harness-neutral/)
})
