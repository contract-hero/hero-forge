import { describe, expect, test } from 'claude-code/testing'
import { ASK, GRILL } from './register'

// The `name` in `.claude-plugin/plugin.json`.
const PLUGIN = 'hero-forge'

const BODY = 'Interview the user relentlessly.'

// Each case: the test name, the skill as the engine hands it over, and what
// the hook appends to its text.
const cases = [
  ['grilling from the plugin gets both addenda', { skill: `${PLUGIN}:grilling`, source: 'plugin', pluginName: PLUGIN }, ASK + GRILL],
  ['another plugin skill gets the general addendum only', { skill: 'to-tickets', source: 'plugin', pluginName: PLUGIN }, ASK],
  ['bare grilling from the plugin gets both addenda', { skill: 'grilling', source: 'plugin', pluginName: PLUGIN }, ASK + GRILL],
  ['a skill moved into engineering/ gets the general addendum only', { skill: `${PLUGIN}:git-guardrails-claude-code`, source: 'plugin', pluginName: PLUGIN }, ASK],
  ['a skill moved into productivity/ gets the general addendum only', { skill: `${PLUGIN}:loop-me`, source: 'plugin', pluginName: PLUGIN }, ASK],
  ['an agent starting implement-pr through the Skill tool gets the general addendum only', { skill: `${PLUGIN}:implement-pr`, source: 'plugin', pluginName: PLUGIN }, ASK],
  ['an agent starting implement-spec-stack through the Skill tool gets the general addendum only', { skill: `${PLUGIN}:implement-spec-stack`, source: 'plugin', pluginName: PLUGIN }, ASK],
  ['an agent starting setup-review-pipeline through the Skill tool gets the general addendum only', { skill: `${PLUGIN}:setup-review-pipeline`, source: 'plugin', pluginName: PLUGIN }, ASK],
  ["another plugin's skill of the same name is left alone", { skill: 'grilling', source: 'plugin', pluginName: 'someone-else' }, ''],
  ["another plugin's namespaced grilling is left alone", { skill: 'mattpocock-skills:grilling', source: 'plugin', pluginName: 'mattpocock-skills' }, ''],
  ['a loose grilling in the user skills folder is left alone', { skill: 'grilling', source: 'userSettings' }, ''],
  ['a loose grilling in the project skills folder is left alone', { skill: 'grilling', source: 'projectSettings' }, ''],
  ['a loose grill-me is left alone', { skill: 'grill-me', source: 'userSettings' }, ''],
  ['a loose review-pipeline is left alone', { skill: 'review-pipeline', source: 'userSettings' }, ''],
  ['a loose loop-me is left alone', { skill: 'loop-me', source: 'userSettings' }, ''],
  ['an unrelated loose skill is left alone', { skill: 'commit', source: 'userSettings' }, ''],
  ["Claude Code's built-in code-review is left alone", { skill: 'code-review', source: 'built-in' }, ''],
  ["an MCP server's grilling is left alone", { skill: 'srv:grilling', source: 'mcp' }, ''],
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
