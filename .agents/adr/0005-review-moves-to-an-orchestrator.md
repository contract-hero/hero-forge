# Review moves to an orchestrator, and fork skills replace `implement`

Upstream `code-review` runs in the coding agent's own session and reports to chat. Upstream `implement` commits to the current branch. The fork wants every change to reach `main` through a pull request that a separate agent reviews, posts on GitHub, and gates before merge (the guarantees of the personal `/lfg` skill). We moved review ownership to an **Orchestrator** inside a new `review-pipeline` skill. We also replaced `implement` and `implement-spec` with fork skills (`implement-pr`, `implement-spec-stack`) that open pull requests and hand them to the pipeline.

## Decision

- `review-pipeline` owns one pull request from draft to merge: N **Reviewer pairs** (Standards with a bug axis, plus Spec), consolidation, one posted review, **Adjudication** by the coding agent, a fresh re-check, a flip to ready, and a CI-gated squash merge. It reuses `code-review`'s prompts and does not edit them.
- The orchestrator never wrote the code. It and its reviewers run in one runtime per repo: Codex (`codex exec`) when setup finds Codex, otherwise Claude sub-agents.
- A new `setup-review-pipeline` skill writes the config to `docs/agents/review.md` (prose plus one YAML block). Upstream `setup-matt-pocock-skills` stays unchanged.
- Upstream `implement` and `implement-spec` move to `misc/`. They still receive upstream merges, but the plugin does not ship them and `ask-matt` does not route to them.
- The pipeline absorbs `/lfg` Phases 3 to 6, so the plugin does not depend on a personal skill. Its helpers are TypeScript, run by Node with no build step.

## Considered options

- **Edit upstream `code-review` and `implement`.** One entry point, but every upstream merge of those files conflicts (ADR 0004).
- **A hook that appends the PR step.** No upstream edit, but Codex users never get the flow, and the behaviour hides outside `SKILL.md` (ADR 0003 is for harness-specific behaviour, and opening a PR is not specific to one harness).
- **Call `/lfg` from `implement`.** Less code, but it couples the plugin to a skill outside the repo, and `/lfg`'s reviewers are different from the Pocock pairs.

## Consequences

- When upstream changes `implement` or `implement-spec`, compare the change against the fork skills by hand. The merge does not carry it over.
- Without the reviewer GitHub App, the review posts from the user's account as a COMMENT review, and the re-checker's verdict is the merge gate.
- The review pipeline's skills reach across skill folders by path, an exception to the Skill-tool rule in `.agents/invocation.md`: they run the helper CLI at `review-pipeline/scripts/review.ts` from a sibling folder, and `review-pipeline` reads `code-review`'s Standards and Spec prompts from `../code-review/SKILL.md` by heading, because a Codex `codex exec` Orchestrator has no Skill tool and copying the prompts would drift from upstream.
- On the Codex runtime, the Orchestrator does not dispatch the reviewers itself, which the spec asked for: no Codex agent gets write access, network or the gh token, because each one reads untrusted PR text. The helper CLI runs each reviewer as its own read-only `codex exec`, the read-only Orchestrator only verifies and consolidates their outputs into a schema-checked payload, and the CLI posts it.
