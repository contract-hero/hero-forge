# hero-forge

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
