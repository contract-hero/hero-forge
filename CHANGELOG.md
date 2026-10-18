# hero-forge

## 1.0.4

- `review-pipeline`: `spec.md` also holds each spec issue's triage Agent Brief comment. A `layer` run with `--spec <n>` (passed by `implement-spec-stack`) also gets the parent spec and each other ticket's "What to build", and its Spec reviewers grade against the layer ticket only. The re-checker brief points to `spec.md`, so a refutation that cites the brief, the parent spec or a sibling ticket can be checked.

## 1.0.3

- `review-pipeline`: a new `run-state supersede --pr N` ends a run whose PR head moved after a review. It marks the run `superseded` and moves its run dir aside, so a new run starts clean at the new head. `create` and `merge-gate` name it when they stop on a moved head, and SKILL.md's **Resume** and **Finish** describe the case.
- `review-pipeline`: `reply`'s adjudication comment marker also names the run's review, so a second run on the same PR posts its own comment. `post-review` never takes a review submitted before the run was created as this run's review, and the re-checker brief names this run's review ids.

## 1.0.2

- `review-pipeline`: a layer whose head moved by a restack always gets a fresh App APPROVE at the new head. `post-review` never counts an old APPROVE that GitHub shows on the new head, and `stack restack --pr` writes no record to the run dir. `--pr` keeps its branch and `--onto` checks.

## 1.0.1

- `git-guardrails-claude-code`: the hook also blocks quoted or escaped forms (`git "reset" \--hard`), abbreviated long options (`git clean --fo`, `git branch --del --forc x`) and any inline `git -c alias.*` or `include.*`, in any case. `SKILL.md` now says the hook guards against accidents, not a hostile agent.

## 1.0.0

hero-forge is the hard fork of mattpocock/skills that replaces the `hero-pocock` plugin ([ADR 0007](./.agents/adr/0007-hero-forge-is-a-hard-fork.md)). It is a clean break: nothing reads the old names.

### Migration

1. Finish or restart every review-pipeline run in progress before you update. A run that started under the old names does not resume.
2. Move the reviewer App credentials, then rename the keys in `reviewer-app.env` and change the key path that points into the old dir:

   ```bash
   mv ~/.config/hero-pocock ~/.config/hero-forge
   perl -pi -e 's/^(\s*(?:export\s+)?)HERO_POCOCK_REVIEWER_APP_/${1}HERO_FORGE_REVIEWER_APP_/; s#/\.config/hero-pocock/#/.config/hero-forge/#' ~/.config/hero-forge/reviewer-app.env
   ```

   The file must then hold `HERO_FORGE_REVIEWER_APP_ID=...` and `HERO_FORGE_REVIEWER_APP_KEY=<path under ~/.config/hero-forge/>`.
3. Swap the plugin:

   ```bash
   claude plugin uninstall hero-pocock@contract-hero
   claude plugin marketplace update contract-hero
   claude plugin install hero-forge@contract-hero
   ```

### New names

- Plugin `hero-forge@contract-hero`, commands under the `hero-forge:` prefix.
- Run-state dir `<git common dir>/hero-forge`, config dir `~/.config/hero-forge/`.
- Env vars `HERO_FORGE_STATE_DIR`, `HERO_FORGE_REVIEWER_APP_ENV`, `HERO_FORGE_REVIEWER_APP_ID`, `HERO_FORGE_REVIEWER_APP_KEY` and `HERO_FORGE_GITHUB_API_URL`.
- PR marker `hero-forge:review-pipeline`.
- `ask-matt` is now `ask-forge`. `setup-matt-pocock-skills` and `setup-review-pipeline` are merged into `setup-forge`.

### Other changes

- `app-token --copy-from` is gone, and the `LFG_REVIEWER_APP_*` credentials are no longer read.
- `git-guardrails-claude-code` and `scaffold-exercises` moved to `engineering/`, and `loop-me` moved to `productivity/`.
- Removed skills: `chief-of-staff`, `claude-handoff`, `implement`, `implement-spec`, `migrate-to-shoehorn`, `setup-pre-commit`, `setup-ts-deep-modules`, `writing-beats`, `writing-fragments` and `writing-shape`. The `misc/`, `in-progress/` and `deprecated/` buckets are gone. Git history keeps them.
- Every skill is model-invoked: you or an agent can start any of them.
- Claude Code only. The Codex, Copilot and skills.sh installs are gone. Codex stays as a review engine (`runtime: codex`).
- `review-pipeline` holds its own reviewer prompts.
- The docs pages under `docs/engineering/` and `docs/productivity/` are gone: the README lists every skill.
