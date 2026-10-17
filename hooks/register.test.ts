import { describe, expect, test } from 'claude-code/testing'
import { ASK, GRILL } from './register'

// The `name` in `.claude-plugin/plugin.json`: the one line that differs upstream.
const PLUGIN = 'hero-pocock'

const BODY = 'Interview the user relentlessly.'

// Each case: the test name, the skill as the engine hands it over, and what
// the hook appends to its text.
const cases = [
  ['grilling from the plugin gets both addenda', { skill: `${PLUGIN}:grilling`, source: 'plugin', pluginName: PLUGIN }, ASK + GRILL],
  ['another plugin skill gets the general addendum only', { skill: 'to-tickets', source: 'plugin', pluginName: PLUGIN }, ASK],
  ['a loose copy of grilling still matches by name', { skill: 'grilling', source: 'userSettings' }, ASK + GRILL],
  ["another plugin's skill of the same name is left alone", { skill: 'grilling', source: 'plugin', pluginName: 'someone-else' }, ''],
  ['an unrelated loose skill is left alone', { skill: 'commit', source: 'userSettings' }, ''],
  ["Claude Code's built-in code-review is left alone", { skill: 'code-review', source: 'built-in' }, ''],
  ["an MCP server's grilling is left alone", { skill: 'srv:grilling', source: 'mcp' }, ''],
  ['a loose copy in the project still matches by name', { skill: 'grilling', source: 'projectSettings' }, ASK + GRILL],
  ['bare grilling from the plugin gets both addenda', { skill: 'grilling', source: 'plugin', pluginName: PLUGIN }, ASK + GRILL],
  ["another plugin's namespaced grilling is left alone", { skill: 'mattpocock-skills:grilling', source: 'plugin', pluginName: 'mattpocock-skills' }, ''],
  ['grill-me gets the general addendum only', { skill: 'grill-me', source: 'userSettings' }, ASK],
  ['a loose copy of setup-review-pipeline gets the general addendum only', { skill: 'setup-review-pipeline', source: 'userSettings' }, ASK],
  ['a loose copy of review-pipeline gets the general addendum only', { skill: 'review-pipeline', source: 'userSettings' }, ASK],
  ['a loose copy of implement-pr gets the general addendum only', { skill: 'implement-pr', source: 'userSettings' }, ASK],
] as const

describe('skill.prompt', () => {
  for (const [name, input, suffix] of cases) {
    test(name, async ($, on) => {
      on('skill.prompt', ($, e) => ({ text: e.text }))

      const { text } = await $.skill.prompt({ ...input, text: BODY })

      expect(text).toBe(BODY + suffix)
    })
  }
})
