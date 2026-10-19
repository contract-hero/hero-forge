# hero-forge

hero-forge is a set of agent skills for real engineering work in Claude Code: it sharpens an idea by interview, turns it into a spec and tickets, builds each ticket test-first, and takes the pull request through an independent review to merge. Every question a skill asks arrives as an `AskUserQuestion` dialog.

The name: "hero" from [aihero.dev](https://www.aihero.dev) and [contracthero.dev](https://contracthero.dev), "forge" after code-forge, the earlier attempt at this toolkit. Until 1.0.0 it was `hero-pocock`: [CHANGELOG.md](./CHANGELOG.md) has the migration steps.

## Install

hero-forge is a Claude Code plugin in the [Contract Hero marketplace](https://github.com/contract-hero/plugin-marketplace).

```bash
claude plugin marketplace add contract-hero/plugin-marketplace
claude plugin install hero-forge@contract-hero
```

Updates itself when the marketplace has auto-update on. If `mattpocock-skills` is also installed, uninstall it (`claude plugin uninstall mattpocock-skills`): both plugins ship skills with the same names.

Then run `/setup-forge` once per repo. It asks which issue tracker you use, which labels you apply when you triage, where docs go, and how pull requests get reviewed (`/review-pipeline`): the runtime, the number of reviewer pairs, the models, the round limit, whether a reviewer GitHub App posts the reviews, and whether AFK mode is on (GitHub events start the runs through two GitHub Apps and T3 Code).

## Skills

Not sure where to start? Ask `/ask-forge`. The skills below are grouped by flow, as `ask-forge` maps them.

### Start here

- **[ask-forge](./skills/engineering/ask-forge/SKILL.md)**: Ask which skill or flow fits your situation. A router over every skill in this repo.
- **[setup-forge](./skills/engineering/setup-forge/SKILL.md)**: Configure a repo for the engineering skills in one run: issue tracker, triage labels, domain doc layout, and the review pipeline. Re-run one part alone when it changes.

### The main flow: idea to ship

- **[grill-with-docs](./skills/engineering/grill-with-docs/SKILL.md)**: Grilling session that also builds your project's domain model, sharpening terminology and updating `GLOSSARY.md` and ADRs inline.
- **[handoff](./skills/productivity/handoff/SKILL.md)**: Compact the current conversation into a handoff document so another agent can continue the work.
- **[to-spec](./skills/engineering/to-spec/SKILL.md)**: Turn the current conversation into a spec and publish it to the issue tracker.
- **[to-tickets](./skills/engineering/to-tickets/SKILL.md)**: Break a plan, spec, or conversation into tracer-bullet tickets, each declaring its blocking edges.
- **[implement-pr](./skills/engineering/implement-pr/SKILL.md)**: Build one ticket with `/tdd`, open a draft pull request that closes it, and hand the PR to `/review-pipeline` for review and merge.
- **[implement-spec-stack](./skills/engineering/implement-spec-stack/SKILL.md)**: Implement a whole spec as a stack of draft pull requests, one per ticket, reviewed layer by layer and then as a whole, and landed bottom-up.
- **[tdd](./skills/engineering/tdd/SKILL.md)**: Test-driven development with a red-green loop. Builds features or fixes bugs one vertical slice at a time.
- **[pr](./skills/engineering/pr/SKILL.md)**: The shape a pull request body should take: the smallest visual that makes the change clear, before/after evidence, and a merge-danger call.
- **[code-review](./skills/engineering/code-review/SKILL.md)**: Two-axis review of the diff since a fixed point, **Standards** and **Spec**, run as parallel sub-agents and reported in your session.
- **[review-pipeline](./skills/engineering/review-pipeline/SKILL.md)**: Take one pull request through an independent review on GitHub: an Orchestrator runs Reviewer pairs, consolidates their findings, gates the fixes, and merges.
- **[retro](./skills/engineering/retro/SKILL.md)**: After a session, suggest improvements to the coding agent's environment (navigation, automated checks, coding standards, steering files, tooling), most severe first.

### On-ramps

- **[triage](./skills/engineering/triage/SKILL.md)**: Move incoming issues through a state machine of triage roles until they are ready for an agent.
- **[diagnosing-bugs](./skills/engineering/diagnosing-bugs/SKILL.md)**: Disciplined diagnosis loop for hard bugs and performance regressions: a feedback loop that goes red on this bug, then minimise, hypothesise, instrument, fix and regression-test.
- **[wayfinder](./skills/engineering/wayfinder/SKILL.md)**: Plan work too big for one session as a shared map of decision tickets on the issue tracker, resolved one at a time until the way is clear.

### Codebase health

- **[improve-codebase-architecture](./skills/engineering/improve-codebase-architecture/SKILL.md)**: Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick.

### Vocabulary underneath

- **[domain-modeling](./skills/engineering/domain-modeling/SKILL.md)**: Build and sharpen a project's domain model: challenge terms, stress-test with scenarios, and update `GLOSSARY.md` and ADRs inline.
- **[codebase-design](./skills/engineering/codebase-design/SKILL.md)**: Shared discipline and vocabulary for designing deep modules: small interfaces, clean seams, testable through the interface.

### Standalone

- **[grill-me](./skills/productivity/grill-me/SKILL.md)**: Get relentlessly interviewed about a plan or design, with no repo under it, until every branch of the design tree is resolved.
- **[grilling](./skills/productivity/grilling/SKILL.md)**: The interview primitive behind `grill-me`, `grill-with-docs`, `triage`, `wayfinder` and `improve-codebase-architecture`.
- **[prototype](./skills/engineering/prototype/SKILL.md)**: Build a throwaway prototype to answer a design question: a single HTML file for state and logic, or several toggleable UI variations.
- **[research](./skills/engineering/research/SKILL.md)**: Investigate a question against primary sources in a background agent, and capture the findings as a cited Markdown file in the repo.
- **[to-questionnaire](./skills/productivity/to-questionnaire/SKILL.md)**: Turn a decision you can't answer alone into a Markdown questionnaire for the one person who can.
- **[wizard](./skills/engineering/wizard/SKILL.md)**: Generate an interactive bash wizard for the steps only a human can take: infrastructure, credentials and CI secrets, a third-party dashboard, a one-off migration.
- **[wait-what](./skills/productivity/wait-what/SKILL.md)**: Fire this the moment a message doesn't land. The agent re-pitches it with the context you're missing, in plain English.
- **[teach](./skills/productivity/teach/SKILL.md)**: Learn a new skill or concept over multiple sessions, using the current directory as a stateful teaching workspace.
- **[loop-me](./skills/productivity/loop-me/SKILL.md)**: Grill yourself into implementable workflow specs over multiple sessions, using the current directory as a stateful workspace.
- **[git-guardrails-claude-code](./skills/engineering/git-guardrails-claude-code/SKILL.md)**: Set up Claude Code hooks that block dangerous git commands (push, reset --hard, clean, branch -D, and more) before they run.
- **[scaffold-exercises](./skills/engineering/scaffold-exercises/SKILL.md)**: Create exercise directory structures with sections, problems, solutions, and explainers that pass linting.
- **[writing-for-agents](./skills/productivity/writing-for-agents/SKILL.md)**: Writing documents for agents: skills, AGENTS.md/CLAUDE.md, and any doc an agent reaches by a pointer.

## Credits

hero-forge starts from [Matt Pocock's skills](https://github.com/mattpocock/skills) ([README](https://github.com/mattpocock/skills#readme)) and changes or removes them freely ([ADR 0007](./.agents/adr/0007-hero-forge-is-a-hard-fork.md)). Matt's skills are MIT licensed, and the [LICENSE](./LICENSE) keeps his MIT notice.
