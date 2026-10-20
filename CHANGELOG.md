# hero-forge

## 1.0.19

- `setup-forge`: the launch table of the router and reconcile prompt templates has a `worker model` column. `review` and `recheck` workers run on `<<light_worker_model>>`, which step 6 fills with the newest Claude Sonnet model in the `orchestrator_capabilities` catalog: Codex runs the reviewers and the re-checker, and the worker only keeps the run state, posts and hands off. Every other action keeps `<<worker_model>>`, because it writes code or judges findings. The launch step passes the model of the row in `modelSelection`. A re-run of step 6 updates the prompts of the live tasks in place.

## 1.0.18

- `setup-forge`: the router and reconcile prompt templates launch each worker thread with `modelSelection` `{instanceId: "claudeAgent", model: "<<worker_model>>"}`. A worker runs Claude Code plugin commands, so it must not take the model of the router or reconcile thread. Step 6 fills `<<worker_model>>` with the Claude model of the setup thread, or else the newest Claude Opus model in the `orchestrator_capabilities` catalog, and says that a small model is enough for the tasks. A re-run of step 6 updates the prompts of the live tasks in place.

## 1.0.17

- `review-pipeline`: `review.ts delivery` tries the detail read of a delivery again on a 5xx or a network error, with the same tries and delay as the list read. GitHub can answer the detail read with a 5xx for a few seconds after it sends a delivery, and the router stopped at once with a message that blamed the App credentials. A 5xx or a network error on every try now exits 1 with a message that names the HTTP status or the network error. Another 4xx still exits 4.

## 1.0.16

- `setup-forge`: the router and reconcile prompt templates settle their own T3 thread on a clean exit, in place of archiving it. Archiving the calling thread takes effect at once and cuts the turn, so the run failed before it wrote its line; settling takes effect when the turn ends. A `stop: ...` line or a failed launch still marks the thread unread.

## 1.0.15

- `setup-forge`: the router and reconcile prompt templates end each run by organizing their own T3 thread. A run that ends with `ignore: ...` or `started: ...` (reconcile: `failed 0`) archives it; a `stop: ...` line or a failed launch marks it unread, so the maintainer sees it. Steps 6.2 and 6.4 update an existing task's prompt in place (`update_scheduled_task`, prompt only) when it differs from the current template, so a plugin update that changes a template reaches the live tasks when the AFK part runs again.
- `implement-pr`, `implement-spec-stack`, `review-pipeline`: an AFK run settles its own thread as its very last action when it ends with nothing for the maintainer (the draft PR, the hand-off, the merge), and marks it unread when it paused or stopped. A run by hand never settles, archives or marks its thread.

## 1.0.14

- `review-pipeline`: `review.ts delivery` reads GitHub's webhook delivery ids by their exact digits. They are 64-bit numbers above 2^53, so a JS number rounded them, and every router run stopped with a 404 that blamed the App credentials. A 404 on the detail read now names the delivery.

## 1.0.13

- `setup-forge`: an AFK part. It writes the AFK config (`paused`, `app_daily_runs`, the `implementer:` block), creates one T3 webhook task per App (signature on `x-hub-signature-256`, the secret through T3's private secret request) and an hourly reconcile task, guides each GitHub App setting and verifies it, checks T3 Connect, and, after asking, sets a ruleset on the default branch that requires a pull request and the `contract-reviewer/gate` check. It never creates an App.
- `review-pipeline`: new `review.ts delivery` (reads one webhook delivery's payload from the App's own deliveries API, refusing a replay older than 25 hours) and `review.ts app-check` (reports each App setting as ok or wrong). New router and reconcile prompt templates in the `setup-forge` folder.

## 1.0.12

- `implement-pr`, `review-pipeline`, `implement-spec-stack`: an AFK mode for router-launched threads. `implement-pr --afk` logs each two-way decision in the PR body's "Decisions" section, pauses on a one-way door (a comment, `needs-info`, a pause record and a push notification) and ends at the draft PR. `review-pipeline <pr> --afk review|adjudicate|recheck` runs one part of a run, then saves its state, releases its lock and posts a hand-off marker as its last action. `implement-spec-stack --afk` pushes each restacked layer as the Implementer App. By hand, nothing changes.
- `review-pipeline`: new `review.ts handoff`, `lock release`, `pause`, `implementer label`, and `implementer push --to <ref> --force-with-lease <sha>`. Spec reviewers check each entry of the PR body's "Decisions" section against the spec.

## 1.0.11

- `review-pipeline`: a new `review.ts reconcile --repo O/R` finds work a missed webhook should have started (labelled tickets and specs with no run, open PRs with no run at their head, hand-offs due, answered pauses) and routes each item through the same decision code as `route`, so caps, `paused`, locks and the sender and author rules give the same answers. It prints one JSON line per item, the `route` decision plus `app`. Synthetic delivery ids are deterministic, so a second sweep starts nothing new. A ticket that an open PR by the maintainer or the Implementer App closes is `ignore` with reason `has-pr`.

## 1.0.10

- `review-pipeline`: `review.ts route --app implementer` decides the Implementer App's events: `build-ticket` and `build-spec` (a maintainer adds `ready-for-agent` to a maintainer-written ticket with no parent, or to a spec whose sub-issues the maintainer wrote), `adjudicate` (the reviewer's hand-off marker on an Implementer PR at `review-posted`) and `resume` (a maintainer reply on a paused issue or PR). `route --app reviewer` gains `recheck` (the Implementer's `adjudicated` hand-off marker, or a maintainer `/recheck` on a maintainer PR). Every decision prints `lock_token`. Attempts per ticket and a daily cap per App are counted.
- `review.ts config` gains the `implementer:` block (`app`, default `disabled`; `attempts`, default `3`; `daily_runs`, default `20`). `implementer.app: enabled` is now the Implementer App's switch for `app-token --app implementer`, `review.ts implementer` and `reply`.
- New `handoff.ts` (the hand-off marker; every posting path refuses it in agent text) and `pause.ts` (pause records).

## 1.0.9

- `review-pipeline`: a new `review.ts implementer push|pr|comment` lets the **Implementer** push a branch, open a draft PR and comment as `contract-implementer[bot]`, minting the Implementer App token in its own process (it never reaches argv, a file or the output). `reply` posts as the PR author: as the Implementer App on a PR that App opened, as the user otherwise.
- `implement-pr`: with `--afk` (passed by the T3 router), steps 4 and 5 push and open the draft PR as the Implementer App. Without it, nothing changes.

## 1.0.8

- `review-pipeline`: a new `review.ts route --app reviewer --event <name> --delivery <id> --payload <file>` turns one GitHub webhook delivery into one decision, `review` or `ignore` with a reason, for the T3 router. A PR by `contract-implementer[bot]` gets `review` on `opened` or `reopened`; a PR by the maintainer (the local `gh` login) on `ready_for_review`, or on a non-draft `opened`/`reopened`. A push never starts anything, and other authors are ignored. It takes a per-PR lock (3-hour TTL), dedupes delivery ids, and counts runs against a rolling 24-hour cap per App. `review.ts config` gains `paused` (default `false`) and `app_daily_runs` (default `20`).

## 1.0.7

- `review-pipeline`: with `app: enabled`, the reviewer App posts the `contract-reviewer/gate` commit status at the PR head: `success` when a passing gate is recorded (once per head), and `failure` when the run stops (`max_rounds` reached, or the re-checker failed twice). The App needs the "Commit statuses: Read and write" permission: without it, the step exits 4 and names the permission, and nothing posts as the user.

## 1.0.6

- `review-pipeline`: `app-token` takes `--app reviewer|implementer` (default `reviewer`). Each App has its own env file under `~/.config/hero-forge/` (`reviewer-app.env`, `implementer-app.env`), its own env-var names and its own test override. Every reviewer path works as before with no new flag, and no subcommand prints a token for either App.

## 1.0.5

- `review-pipeline`: with no spec, each Standards reviewer gets `scope-prompt.md` and the PR body. The PR body is the stated scope, and a changed file it does not account for is a low-severity finding. Both runtimes fill the same text.

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
