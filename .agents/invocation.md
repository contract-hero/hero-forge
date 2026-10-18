# Every skill is model-invoked

Every `SKILL.md` in this repo is a skill, and every skill is **model-invoked**: you can type its name, the agent can start it when the task fits, and another skill can start it through the Skill tool. The skills ship for Claude Code only ([ADR 0007](./adr/0007-hero-forge-is-a-hard-fork.md)), so there is no second harness to configure.

- No `SKILL.md` sets `disable-model-invocation`.
- The `description` is **model-facing**: one quoted line that says what the skill does, then when an agent should start it ("Use when the user wants…, mentions…, asks for…"). It is the only text the agent sees before it starts the skill.
- A skill that builds or lands work (`implement-pr`, `implement-spec-stack`) names the hand-over that starts it, and says that a passing mention does not.

`scripts/invocation.spec.ts` checks every skill against these rules. Bucket `README.md`s and the top-level `README.md` hold one list per bucket, with no split by invocation.

## Dependencies between skills

Dependencies are expressed as an explicit instruction to **call the Skill tool** with the named skill (`Call the Skill tool with "grilling"`), not deep `../other-skill/FILE.md` cross-references, and not a bare `/skill`-style mention left for the model to interpret. Naming the tool is what gets it fired: spelling that out gets a higher hit rate than dropping a `/name` into prose and hoping it's read as a command. Shared reference docs live inside the skill that owns them; other skills reach that material by calling the Skill tool with it, not by linking across folders.

One recorded exception: the review pipeline's skills reach the helper CLI and `code-review`'s prompts by path. See the Consequences of [ADR 0005](./adr/0005-review-moves-to-an-orchestrator.md).

This is about **operative** instructions: a skill's own steps telling the agent to go run another skill right now. Router prose that just names skills for a human to pick from (`ask-matt`, bucket `README.md`s) isn't invoking anything, so it keeps `/skill`-style names as plain labels.

The Skill tool takes one skill per call. A step that needs two skills is two calls, not one call with two names: say so (`Call the Skill tool twice, for "grilling" and "domain-modeling"`), not "call it with X and Y," which reads as a single call taking both.

## Passive vs active domain work

Merely _reading_ `GLOSSARY.md` for vocabulary is a one-line prose pointer, not the `domain-modeling` skill. Only the active build/sharpen discipline (challenge terms, edge-case scenarios, write ADRs, update `GLOSSARY.md` inline) is `domain-modeling`.
