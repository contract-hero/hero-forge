import type { Register } from 'claude-code'

// The promoted set, as `.claude-plugin/plugin.json` lists it. A skill from
// this plugin matches on `pluginName`, whatever the manifest names the plugin.
// A skill loaded from a user or project skills folder (skills.sh,
// `scripts/link-skills.sh`) matches on its bare name against this list. That
// also catches an unrelated loose skill of the same name, and it skips the
// `in-progress/` skills that `scripts/link-skills.sh` also links.
const SKILLS = new Set([
  'ask-matt',
  'diagnosing-bugs',
  'grill-with-docs',
  'triage',
  'improve-codebase-architecture',
  'setup-matt-pocock-skills',
  'setup-review-pipeline',
  'tdd',
  'to-spec',
  'to-tickets',
  'wayfinder',
  'implement',
  'implement-spec',
  'prototype',
  'research',
  'domain-modeling',
  'codebase-design',
  'code-review',
  'review-pipeline',
  'pr',
  'retro',
  'wizard',
  'grill-me',
  'grilling',
  'handoff',
  'teach',
  'to-questionnaire',
  'wait-what',
  'writing-for-agents',
])

export const ASK = `

## Asking the user (Claude Code)

This session has the AskUserQuestion tool. Whenever this skill tells you to ask the user something, put a decision to them, or wait for their answer, ask through AskUserQuestion. Do not write the question as text in your reply.

- One question per entry, at most 4 entries per call. When more than 4 questions are due at once, make successive calls of 4 or fewer until every one is asked, then act on the answers.
- \`header\`: a chip of 12 characters or fewer that names the topic.
- \`options\`: 2 to 4 concrete choices. Put your recommended answer first and end its label with " (Recommended)". Put the reasoning and the trade-offs in each option's \`description\`. Never add an "Other" option: the tool adds one for a free-text answer.
- \`multiSelect\`: true only when the choices are not mutually exclusive.
- A question with no natural choices (a name, a value, a description): offer your best guesses as options. The user can still type their own answer under "Other".
- Context the user needs before they answer (findings, a diagram, a code excerpt) goes in your reply text before the call, or in an option's \`preview\`.
- Facts stay your job: never ask for something you can look up.
- Questions you write into a document for someone else (a questionnaire, a ticket, an issue comment) stay in that document.

If AskUserQuestion is not available (a headless run, or you are a sub-agent), ask in plain text as the rest of this skill describes.
`

export const GRILL = `
This replaces the round format above. Ask each round as AskUserQuestion calls: the question title becomes the \`header\`, the question body becomes the \`question\`, and your recommended answer becomes the first option. Ask the whole frontier in one round, split into successive calls of up to 4 questions. Each option carries its own recommendation, so you do not need to word questions so that "yes" accepts it. The rest of the method holds: recompute the frontier after each round, send sub-agents for facts, and do not act until the user confirms a shared understanding.
`

// `grilling` at the Skill tool, `<plugin>:grilling` where the plugin
// namespaces it.
const bareName = (skill: string) => skill.slice(skill.lastIndexOf(':') + 1)

export const register: Register = on => {
  on('skill.prompt', ($, e, next) => {
    const name = bareName(e.skill)
    const loose = e.source === 'userSettings' || e.source === 'projectSettings'
    const ours = e.pluginName === undefined ? loose && SKILLS.has(name) : e.pluginName === $.plugin.name
    if (!ours) return next(e)

    return next({ ...e, text: e.text + ASK + (name === 'grilling' ? GRILL : '') })
  })
}
