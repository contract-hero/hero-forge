---
status: accepted
supersedes: ADR 0004
---

# hero-forge is a hard fork of mattpocock/skills, for Claude Code only

ADR 0004 kept `hero-pocock` close to upstream: no edits to Matt's `SKILL.md` files, tailoring only through hooks, new skills and ADRs, and `git merge upstream/main` for his changes. That rule cost more than it gave. It kept retired skills alive in `misc/`, it made `review-pipeline` read `code-review`'s prompts by file path, it needed an exception for cross-folder references, and it made the fork skills copy upstream's user-only invocation, which stopped agents from starting `implement-pr` and `implement-spec-stack` (dogfood bug 7). Only one batch of upstream changes ever merged. We decided to make the repo a hard fork named **hero-forge**, which uses Matt's skills as a base and changes or deletes any of them freely. The name honours code-forge, the earlier attempt at this toolkit, which is retired.

## Decision

- **A new repo.** `contract-hero/hero-forge` is a new GitHub repo, not a GitHub fork, so no tool can default to Matt's repo. It starts with the full git history of `hero-pocock`. The README and the LICENSE credit mattpocock/skills (MIT). `hero-pocock` gets a banner, transfers its open issues, and is archived.
- **Upstream is a read-only source.** The `upstream` remote stays for reading. Matt's changes are ported by hand when they are worth it. There are no more upstream merges.
- **Claude Code only.** Codex as a harness for the skills is dropped, because it cannot match the Claude Code experience 1:1: it has no hook on skill load, its question tool works only in Plan mode with a narrower shape, and per-call sub-agent models sit behind a flag. Codex stays as a review engine (`runtime: codex`), which Claude Code calls.
- **Every skill is model-invoked.** You or an agent can start any skill, so the ADR 0006 routers can start builds.
- **Only shipped skills live in the repo.** The `engineering/` and `productivity/` buckets remain. `misc/`, `in-progress/` and `deprecated/` go, and git history keeps what they held. There are no docs pages: the README is the page for humans.
- **Clean break at 1.0.0.** The plugin, the command prefix, the config dir, the env vars, the run-state dirs and the PR marker all change from `hero-pocock` to `hero-forge`. Nothing reads the old names.

## Consequences

- ADR 0003 keeps its hook, but for a new reason: the hook is the one shared ask preamble for every hero-forge skill, not a way to stay harness-neutral. It matches skills by plugin name, so it needs no copy of the skill list.
- ADR 0002 still holds on shipping a Claude Code plugin. ADR 0004 is superseded in full.
- The change takes effect with the hero-forge 1.0.0 release. Until then, the last `hero-pocock` 0.2.x fixes keep the ADR 0004 rules.
- The limits that ADR 0005 accepted because of ADR 0004 are lifted: `review-pipeline` may own or edit the prompts it uses, and `implement-pr` and `implement-spec-stack` set their own invocation.
- Matt's new skills and fixes no longer arrive by themselves. Someone must read upstream and decide what to port.
