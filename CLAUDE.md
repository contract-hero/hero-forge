Skills are organized into bucket folders under `skills/`:

- `engineering/`: daily code work
- `productivity/`: daily non-code workflow tools

The repo holds only skills that ship: there is no other bucket. Every skill must have a reference in the top-level `README.md` and an entry in `.claude-plugin/plugin.json`'s `skills` array (the Claude Code plugin ships every skill in the two buckets). `scripts/skills.spec.ts` checks both.

Install commands are copied verbatim from [.agents/install-block.md](./.agents/install-block.md). The plugin installs in Claude Code only, from the Contract Hero marketplace (`contract-hero/plugin-marketplace`), as `hero-forge@contract-hero`. Run `claude plugin validate .` after touching `.claude-plugin/plugin.json`, and read the warnings. The warning that a CLAUDE.md at the plugin root is not loaded as project context is expected, and `--strict` fails on it, so run validate without `--strict`. [ADR 0002](./.agents/adr/0002-ship-as-a-claude-code-plugin.md) records why the repo ships a plugin.

Each skill entry in the top-level `README.md` must link the skill name to its `SKILL.md`.

Each bucket folder has a `README.md` that lists every skill in the bucket with a one-line description, with the skill name linked to its `SKILL.md`. Each bucket `README.md` holds one list. The top-level `README.md` groups the skills by flow, as `ask-forge` maps them. Neither splits the skills by invocation.

Every `SKILL.md` is model-invoked: no skill sets `disable-model-invocation`, and its quoted `description` tells an agent when to start it. `scripts/invocation.spec.ts` checks every skill. See [.agents/invocation.md](./.agents/invocation.md).

[`ask-forge`](./skills/engineering/ask-forge/SKILL.md) is the router that maps every user-reachable skill and how they relate. Whenever you add, rename, remove, or change how a user-reachable skill fits the flows, re-read `ask-forge`'s `SKILL.md` and update it so the map stays accurate: a new skill it never mentions, or a stale one it still routes to, is a router that lies.

To (re)link every skill into `~/.claude/skills`, run `scripts/link-skills.sh`. Each entry is a symlink into this repo, so a `git pull` keeps installed skills current; re-run the script after adding, removing, or renaming a skill.

No em-dashes anywhere in this repo's prose (`SKILL.md` files, docs, `README.md`, `CHANGELOG.md`, ADRs, code comments). Where a sentence reaches for one, rewrite it instead with a comma, colon, period, parentheses, or a conjunction, whichever the sentence actually wants; never do a blind character substitution.

## The hard fork

This repo is `hero-forge`: Álvaro Lillo's hard fork of `mattpocock/skills`, for Claude Code only. It started as `hero-pocock`. [ADR 0007](./.agents/adr/0007-hero-forge-is-a-hard-fork.md) holds the rules. In short:

- `origin` is `contract-hero/hero-forge`. The `upstream` remote (`mattpocock/skills`) is read-only: never merge it, never rebase onto it. When one of Matt's changes is worth having, port it by hand on a branch of its own.
- Any skill, Matt's included, may be changed or removed. Write the skills for Claude Code only.
- `hooks/register.ts` adds the shared ask preamble to every hero-forge skill ([ADR 0003](./.agents/adr/0003-harness-specific-behaviour-ships-as-a-hook.md), for the reason ADR 0007 gives). It matches a skill by plugin name only, so adding, renaming or removing a skill needs no hook edit. Run `claude plugin validate .` and `claude plugin test .` after a change to `hooks/`.
- The `version` in `.claude-plugin/plugin.json` is the one version. Bump it by hand for each change users should get: Claude Code reinstalls the plugin only when it changes. Record the change in `CHANGELOG.md`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `contract-hero/hero-forge`, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical names, unchanged. See `docs/agents/triage-labels.md`. Issues are judged against [`SCOPE.md`](./SCOPE.md).

### Domain docs

Single-context: `GLOSSARY.md` at the root, ADRs in `.agents/adr/`. See `docs/agents/domain.md`.

### Review

2 reviewer pairs on Codex, max 2 rounds. Reviews post as the `contract-reviewer` App, which approves or requests changes. See `docs/agents/review.md`.
