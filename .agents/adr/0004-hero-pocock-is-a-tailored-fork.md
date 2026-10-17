# `hero-pocock` is a tailored fork that follows upstream

`hero-pocock` is Álvaro Lillo's version of [mattpocock/skills](https://github.com/mattpocock/skills), shaped to the Contract Hero work-stream. It is not a pull request in waiting: its changes are not meant to go back upstream. It still wants Matt's new skills and fixes as they land.

## Decision

- The repository is `contract-hero/hero-pocock`, a GitHub fork of `mattpocock/skills` (transferred from `alilloig/mp-skills`, so the fork link and history stay). The local clone keeps two remotes: `origin` for the fork, `upstream` for Matt's repository.
- The plugin is `hero-pocock`, published in the [Contract Hero marketplace](https://github.com/contract-hero/plugin-marketplace), not in `claude-plugins-official`. The repository's own `.claude-plugin/marketplace.json` (named `hero-pocock`) stays as the route for Codex, Copilot and a direct install.
- Upstream arrives by merge: `git fetch upstream && git merge upstream/main` on a branch, then a PR into `main`. Merge, do not rebase, so `main` never needs a force push.
- Keep the Claude Code plugin layer upstreamable: `hooks/register.ts` must not name the fork (it reads the plugin's own name from `$.plugin.name`), and `hooks/register.test.ts` names it once, in `PLUGIN`. A later PR to `mattpocock/skills` can then carry `hooks/`, `tsconfig.json`, the `.claude-plugin/types/` line in `.gitignore` and ADR 0003 onto a fresh branch from `upstream/main`, with `PLUGIN` set to `mattpocock-skills` and no other change to Matt's repo. Fork-only changes (name, version, README, install lines) stay outside `hooks/`.
- Tailoring goes where upstream does not write: hooks under `hooks/`, new ADRs, and new skills. Edit an upstream `SKILL.md` only when no hook can do the job, because each such edit can conflict on every merge.
- Matt's GitHub Actions (Release, triage labels, needs-info) are turned off with the repository's Actions switch (`gh api -X PUT repos/contract-hero/hero-pocock/actions/permissions -F enabled=false`), not deleted, so upstream edits to those files still merge without a modify/delete conflict. The switch was set before the first push to `main`: otherwise the Release workflow opens a version PR that copies Matt's version into `plugin.json`. If the fork needs its own workflow later, turn Actions back on and run `gh workflow disable` on Matt's three first.

## Invariants this creates

- The plugin `version` in `.claude-plugin/plugin.json` is the fork's own (it started at `0.1.0`), not a copy of `package.json`. Bump it by hand for each change you want installed users to get, because Claude Code reinstalls only when the version changes. Do not run `npm run version` or `scripts/sync-plugin-version.mjs`: they copy Matt's `package.json` version over it. `npm run check-plugin-version` always fails on the fork, because the two versions differ on purpose: ignore it, and do not follow its advice to run the sync script.
- On an upstream merge, `plugin.json` and `README.md` conflict often. Keep the fork's name, version, description and install lines; take upstream's `skills` list and skill reference.
- After a merge that adds or renames a promoted skill, update the `SKILLS` list in `hooks/register.ts` (see [ADR 0003](./0003-harness-specific-behaviour-ships-as-a-hook.md)).
- For the fork, this ADR replaces two points of ADR 0002: Claude Code installs from the Contract Hero marketplace, not `claude-plugins-official`, and the plugin `version` does not follow `package.json`.

## Known limits

- The `docs/engineering/` and `docs/productivity/` pages of the upstream skills, and their aihero URLs, are Matt's. The fork edits them only where its own skills change a route (for example, pages that pointed to `implement` now point to `implement-pr`). The fork's own skills have their own pages, which link to the page file on GitHub, because aihero has no page for them.
- `claude plugin validate . --strict` fails on Claude Code 2.1.300 with the warning "CLAUDE.md at the plugin root is not loaded as project context". Upstream `main` fails the same way. Run it without `--strict` and read the warnings.
