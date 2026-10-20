---
name: setup-forge
description: "Configure this repo for the engineering skills in one run: its issue tracker, triage label vocabulary, domain doc layout, and how it reviews pull requests (runtime, reviewer pairs, model and effort per role, round limit, reviewer App, and AFK mode: GitHub Apps and T3 Code tasks that start the runs from GitHub events). Re-runs one part alone when asked. Run once before first use of the other engineering skills. Use when the user wants a repo set up for the engineering skills, or asks to change its issue tracker, triage labels, domain doc layout, or how it reviews pull requests. Do not start it only because a config file is missing."
---

# Setup Forge

Scaffold the per-repo configuration that the engineering skills assume, in four parts:

- **Issue tracker**: where issues live (GitHub by default; local markdown is also supported out of the box)
- **Triage labels**: the strings used for the five canonical triage roles
- **Domain docs**: where `GLOSSARY.md` and ADRs live, and the consumer rules for reading them
- **Review pipeline**: the config that `review-pipeline` reads, `docs/agents/review.md` (prose plus one YAML block): the runtime, the number of reviewer pairs, the model and effort of each role, the round limit, whether a reviewer GitHub App posts the reviews, and whether AFK mode is on. With AFK mode on, GitHub events start the runs: the part also checks both Apps' settings, creates the T3 Code tasks that route the events, and sets the default-branch ruleset (step 6)

Each part writes its file under `docs/agents/` and one entry in the `## Agent skills` block of `CLAUDE.md` or `AGENTS.md`.

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write.

## All parts or one

By default, run all four parts. When the user asks for one part only (for example "only the review pipeline", or "switch the issue tracker"), run that part alone: its exploration, its section in step 2, its drafts, its writes, and its check. Leave the other parts' files and `## Agent skills` entries as they are.

The helper CLI for the review pipeline part lives in the `review-pipeline` skill folder, a sibling of the folder this SKILL.md is in. Below, `review.ts` means `node "<the folder this SKILL.md is in>/../review-pipeline/scripts/review.ts"`.

## Process

### 1. Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume.

For every part:

- `AGENTS.md` and `CLAUDE.md` at the repo root: does either exist? Is there already an `## Agent skills` section in either, and which of its entries (`### Issue tracker`, `### Triage labels`, `### Domain docs`, `### Review`) are there?
- `docs/agents/`: does this skill's prior output already exist?

For the issue tracker, the triage labels and the domain docs:

- `git remote -v` and `.git/config`: is this a GitHub repo? Which one?
- `GLOSSARY.md` and `GLOSSARY-MAP.md` at the repo root
- `docs/adr/` and any `src/*/docs/adr/` directories
- `.scratch/`: a sign that a local-markdown issue tracker convention is already in use
- Is the `triage` skill installed? (a `triage` skill folder alongside this one, or `triage` in your available skills.) This decides whether Section B runs at all.
- Monorepo signals: a `pnpm-workspace.yaml`, a `workspaces` field in `package.json`, or a populated `packages/*` with its own `src/`. These are present only in a genuinely large multi-package repo; their absence means single-context, which is almost every repo.

For the review pipeline:

- `node --version`: the helper CLI needs Node 22.18 or newer. If it is older, tell the user to upgrade Node and stop the review pipeline part: write none of it. The other parts do not need Node.
- `codex --version`: exit 0 means Codex is installed. This picks the recommended runtime.
- `docs/agents/review.md`: a previous run's output. If it exists, run `review.ts config` (from the repo root). Exit 0 gives the current answers as JSON: use them as the recommended answers in Section D in place of the defaults. Exit 4 means the file is broken: show the message, and recommend the defaults.
- `gh repo view --json nameWithOwner`: the repo as `O/R`, for the App check. If it fails (no GitHub remote: a local-only or GitLab repo), tell the user that `review-pipeline` reviews GitHub pull requests only, and skip the review pipeline part: write none of it, and add no `### Review` entry. The other parts still run.
- Reviewer App credentials. Check only that these files exist (`test -f <path>`). Never print, `cat` or read them: they hold the App ID and the path to a private key.
  - `~/.config/hero-forge/reviewer-app.env`: this plugin's credentials.
  - `~/.config/hero-forge/implementer-app.env`: the Implementer App's credentials, for AFK mode.
- AFK mode now: in the JSON of `review.ts config`, `implementer.app` is `true` when AFK mode is on.

### 2. Present findings and ask

Summarise what's present and what's missing. Then take the sections in order. One section, one answer, then the next. In Section D, ask one question at a time.

Lead each section with the recommended answer so the user can accept it in a word. Give a one-line explainer only when the choice genuinely branches; skip the section entirely when exploration already settled it (Section B when `triage` isn't installed, Section C when there's no monorepo).

**Section A: Issue tracker.**

> Explainer: The "issue tracker" is where issues live for this repo. Skills like `to-tickets`, `triage`, and `to-spec` read from and write to it. They need to know whether to call `gh issue create`, write a markdown file under `.scratch/`, or follow some other workflow you describe. Pick the place you actually track work for this repo.

Default posture: these skills were designed for GitHub. If a `git remote` points at GitHub, propose that. If a `git remote` points at GitLab (`gitlab.com` or a self-hosted host), propose GitLab. Otherwise (or if the user prefers), offer:

- **GitHub**: issues live in the repo's GitHub Issues (uses the `gh` CLI)
- **GitLab**: issues live in the repo's GitLab Issues (uses the [`glab`](https://gitlab.com/gitlab-org/cli) CLI)
- **Local markdown**: issues live as files under `.scratch/<feature>/` in this repo (good for solo projects or repos without a remote)
- **Other** (Jira, Linear, etc.): ask the user to describe the workflow in one paragraph; the skill will record it as freeform prose

Record the choice in `docs/agents/issue-tracker.md`. The GitHub and GitLab templates carry a "PRs as a request surface" flag, defaulted **off**. Leave it off and don't raise it: a user who wants external PRs in the triage queue can flip the flag in the file later.

**Section B: Triage label vocabulary.** Skip this section entirely if the `triage` skill isn't installed (exploration told you), since an uninstalled skill needs no labels.

If it is installed, ask exactly one question:

> Do you want to keep the default triage labels? (recommended: **yes**)

The defaults are the five canonical roles, each label string equal to its name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. On **yes**, write them as-is. Only if the user says no, usually because their tracker already uses other names (e.g. `bug:triage` for `needs-triage`), collect the overrides so `triage` applies existing labels instead of creating duplicates.

**Section C: Domain docs.** Default to **single-context** (one `GLOSSARY.md` + `docs/adr/` at the repo root). This fits almost every repo; write it without asking.

Offer **multi-context** (a root `GLOSSARY-MAP.md` pointing to per-context `GLOSSARY.md` files) only when exploration found monorepo signals. Then confirm which layout they want.

**Section D: Review pipeline.**

*Runtime.* One runtime runs both the Orchestrator and the reviewers. Never offer a mix: the pipeline cannot dispatch one.

| Runtime | When to recommend it | Orchestrator | Reviewers |
| --- | --- | --- | --- |
| `codex` (`codex exec`) | Codex is installed | `gpt-6-astra`, `low` effort | `gpt-6.1-sol`, `high` effort |
| `claude` (sub-agents) | Codex is not installed | `claude-opus-5-5`, `medium` effort | `claude-sonnet-5-5`, `high` effort |

Offer `codex` only when Codex is installed.

*Reviewer pairs.* How many pairs run per round (default 2). Each pair is one Standards reviewer and one Spec reviewer, so N pairs cost 2N reviewer runs. One pair is the cheapest; more pairs find more, at more cost.

*Models and effort.* Ask whether to keep the runtime's defaults for both roles. Only if the user says no, ask for the model and effort of each role, from the chosen runtime only:

- Effort for `codex`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. A model can reject a value it does not support (for example, `gpt-6.1-sol` rejects `minimal`); Codex reports this when the pipeline runs.
- Effort for `claude`: `low`, `medium`, `high`, `xhigh`, `max`.
- A `claude` model is a full id (`claude-<family>-...`) or a bare `opus`, `sonnet`, `haiku`, `fable`. The family picks the sub-agent model.

*Round limit.* How many failed re-check rounds run before the pipeline stops and asks the user (`max_rounds`, default 2).

*Reviewer App.* Does a reviewer GitHub App post the reviews? With the App, the reviews show the App's bot, not the user, and at the end of the loop the App approves the PR or requests changes. Without it, the reviews post from the user's own `gh` account as COMMENT reviews, and the re-check gate is the merge gate. This skill uses an App that already exists and is installed on the repo; it does not create one. The App needs these permissions: Pull requests read and write, Contents read, Metadata read.

Offer the answers that fit what step 1 found, the recommended one first:

| Found | Answers |
| --- | --- |
| `~/.config/hero-forge/reviewer-app.env` | use the App (recommended when the current config has `app: enabled`, or there is no config yet); no App |
| no credentials | no App (recommended); add the credentials by hand, then use the App |

For credentials by hand, tell the user to create `~/.config/hero-forge/` (mode 700) with two files, both mode 600, and to tell you when they are there:

- `reviewer-app.pem`: the App's private key, as GitHub downloads it.
- `reviewer-app.env`, two lines: `HERO_FORGE_REVIEWER_APP_ID=<App ID or Client ID>` and `HERO_FORGE_REVIEWER_APP_KEY=<absolute path of reviewer-app.pem>`.

Never ask the user to paste the App ID or the key into the conversation.

*AFK mode.* Do GitHub events start the runs, with no slash command? With AFK mode on, the user adds `ready-for-agent` to a ticket or a spec, and the rest runs unattended: the Implementer App builds it and answers the reviews, and the reviewer App reviews, approves and merges. It needs:

- the reviewer App (the answer above);
- an Implementer GitHub App that already exists, installed on the repo, with its credentials in `~/.config/hero-forge/implementer-app.env`. This skill never creates an App;
- T3 Code on this machine, with T3 Connect (step 6 checks it).

Offer the answers that fit what step 1 found, the recommended one first:

| Found | Answers |
| --- | --- |
| the current config has `implementer.app: true` | AFK mode on (recommended); off |
| anything else | AFK mode off (recommended); on |

With AFK mode off, everything below works as written and the config gets none of the AFK lines.

AFK mode on with no reviewer App above: AFK mode needs both Apps. Ask whether to use the reviewer App after all, or to leave AFK mode off.

AFK mode on with no `implementer-app.env`: tell the user to add the credentials as for the reviewer App, in the same `~/.config/hero-forge/` folder: `implementer-app.pem`, and `implementer-app.env` with `HERO_FORGE_IMPLEMENTER_APP_ID=<App ID or Client ID>` and `HERO_FORGE_IMPLEMENTER_APP_KEY=<absolute path of implementer-app.pem>`. Wait until they say the files are there.

With AFK mode on, the YAML block gets these lines after the other fields: `paused` is the switch that stops both Apps, `app_daily_runs` caps the reviewer App's runs in a rolling 24 hours, and the `implementer:` block turns the Implementer App on, caps the builds of one ticket (`attempts`) and its runs in 24 hours (`daily_runs`).

```yaml
paused: false
app_daily_runs: 20
implementer:
  app: enabled
  attempts: 3
  daily_runs: 20
```

### 3. Confirm and edit

Show the user a draft of:

- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 4 for selection rules). When one part runs alone, show only that part's entry.
- The contents of `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, and `docs/agents/triage-labels.md` (the last only when `triage` is installed)
- The whole new `docs/agents/review.md`, from the seed template [review.md](./review.md) with every placeholder filled. The YAML block states every field, even the ones left at their defaults. With the App, the block has the line `app: enabled`. Without it, the block has no `app` line. With AFK mode on, the block also has the AFK lines of Section D, and the prose has the AFK mode line of the template.

Let them edit before writing.

### 4. Write

**Pick the file to edit:**

- If `CLAUDE.md` exists, edit it.
- Else if `AGENTS.md` exists, edit it.
- If neither exists, ask the user which one to create; don't pick for them.

Never create `AGENTS.md` when `CLAUDE.md` already exists (or vice versa); always edit the one that's already there.

If an `## Agent skills` block already exists in the chosen file, update its contents in-place rather than appending a duplicate. Don't overwrite user edits to the surrounding sections.

The block:

```markdown
## Agent skills

### Issue tracker

[one-line summary of where issues are tracked]. See `docs/agents/issue-tracker.md`.

### Triage labels

[one-line summary of the label vocabulary]. See `docs/agents/triage-labels.md`.

### Domain docs

[one-line summary of layout: "single-context" or "multi-context"]. See `docs/agents/domain.md`.

### Review

<N> reviewer pairs on <Codex | Claude sub-agents>, max <max_rounds> rounds, <reviews and approval by the reviewer App | COMMENT reviews as you><, AFK mode on: GitHub events start the runs, only with AFK mode>. See `docs/agents/review.md`.
```

Include the `### Triage labels` sub-block, and write `docs/agents/triage-labels.md`, only when `triage` is installed and Section B ran. When it isn't, both are omitted.

When one part runs alone, keep to that part's one entry:

- If its `###` subsection exists, replace it: from its heading through the line before the next `###` or `##` heading (or the end of the file). Change nothing else.
- Else if an `## Agent skills` block exists, add the entry as the last subsection of that block.
- Else add a new `## Agent skills` block, holding only this entry, at the end of the file.

Don't change the other subsections of the block or any other part of the file.

When Section B ran on GitHub or GitLab, create each configured label the tracker lacks (`gh label create` / `glab label create`).

Then write the docs files using the seed templates in this skill folder as a starting point:

- [issue-tracker-github.md](./issue-tracker-github.md): GitHub issue tracker
- [issue-tracker-gitlab.md](./issue-tracker-gitlab.md): GitLab issue tracker
- [issue-tracker-local.md](./issue-tracker-local.md): local-markdown issue tracker
- [triage-labels.md](./triage-labels.md): label mapping (only if `triage` is installed)
- [domain.md](./domain.md): domain doc consumer rules + layout
- [review.md](./review.md): review pipeline config. Write it last, in the **`docs/agents/review.md`** step below: with the App, only after the App check passes.

For "other" issue trackers, write `docs/agents/issue-tracker.md` from scratch using the user's description.

**The App credentials** (only when the user chose the App):

Check the App before the config says `app: enabled`. Save the draft config to a temp file outside the repo and run `review.ts app-token --repo O/R --check --config <temp file>`. It mints a token and prints nothing.

- Exit 0: the App can post on this repo. Write the config with `app: enabled`.
- Exit 4: show the message (for example, the App is not installed on `O/R`, or GitHub refused the key). Ask the user to fix it and check again, or to write the config without the App. Never write `app: enabled` for an App that fails this check.

With AFK mode on, check the Implementer App the same way, with the AFK lines in the draft: `review.ts app-token --repo O/R --app implementer --check --config <temp file>`. Exit 4: show the message, and ask the user to fix it and check again, or to leave AFK mode off. Never write `implementer:` with `app: enabled` for an App that fails this check.

**`docs/agents/review.md`**: write the whole file, replacing any previous version. Create `docs/agents/` if it is missing.

### 5. Check

When the review pipeline part ran: from the repo root, run `review.ts config`. It must exit 0. Show the user the JSON it prints: that is what `review-pipeline` will use. A non-zero exit means the file you wrote is wrong: fix it and run the check again. With the App, `app` is `true`; also run `review.ts app-token --repo O/R --login` and show the login it prints, `<slug>[bot]`: the reviews will show that name. With AFK mode on, `implementer.app` is `true`, and `review.ts app-token --repo O/R --app implementer --login` prints the name the builds will show.

### 6. AFK mode

Only with AFK mode on, after step 5 passes. Take the sub-steps in order: each App's webhook settings need the URL of its T3 task. Never create or change an App, and never click an App setting: each change is the user's. Name the exact page, wait for the user, then check again.

`route` reads the config from the default branch, so AFK mode starts once the `docs/agents/review.md` written above is on the default branch. Tell the user to land it through a pull request.

The T3 tasks copy the provider, the model and the runtime mode of the thread that creates them, and each router and reconcile thread copies them from the task. But each worker thread runs on the Claude model its row of the launch table names, because the workers run Claude Code plugin commands. `review` and `recheck` run on `<<light_worker_model>>`: Codex runs the reviewers and the re-checker, and the worker only keeps the run state, posts and hands off. Every other action runs on `<<worker_model>>`: it writes code or judges findings. The routers and the reconcile only run fixed commands, so a small model is enough for the tasks. Tell the user, so they run this part from a thread with the runtime mode the runs should use. To move a task to another model after it exists, the user changes it in the T3 UI: `update_scheduled_task` has no model field.

`<<worker_model>>`: the model of this thread when `orchestrator_capabilities` gives `inheritedProviderInstanceId` `claudeAgent` (its `inheritedModel`), else the newest Claude Opus model of the `claudeAgent` provider in its catalog.

`<<light_worker_model>>`: the newest Claude Sonnet model of the `claudeAgent` provider in the `orchestrator_capabilities` catalog. A Sonnet model is enough for the bookkeeping of a `review` or `recheck` worker, and costs less than the strongest model.

Find both once, before 6.2, and fill the same values in both templates.

**Each run's worktree.** T3 starts each run of a router or reconcile task in a new worktree of the project. `schedule_task` and `update_scheduled_task` cannot set a task's workspace, and `list_scheduled_tasks` does not show it, so each run removes its own worktree as its last shell command: the step of the template before the thread step. A run edits nothing in its worktree, and runs its commands in the project's `workspaceRoot`. The worker threads it launches keep their worktrees. The live tasks get this step when 6.2 and 6.4 update their prompts.

**Worktrees earlier runs left.** A router or reconcile task made before this step left one worktree per run in T3's worktree folder of the project, and one branch each. The folder is the parent of the paths that `t3_worktree_list` gives for the project (for example `~/.t3/worktrees/<project>`). When `git -C <workspaceRoot> worktree list` shows such worktrees, ask whether to look for them now (recommended) or not now. A leftover worktree and the worktree of a T3 thread that has not committed yet look the same, so run this only while no AFK run is in flight, and remove only the worktrees the user approves. First list the candidates into `<list file>`, a new file outside the repo. A candidate is in T3's worktree folder, is not the worktree this thread runs in, and has no change and no commit that the default branch lacks. A worktree outside that folder is never a candidate:

```sh
root=<workspaceRoot>; t3dir=<T3 worktree folder>; base=origin/<default branch>; self=$(git rev-parse --show-toplevel)
git -C "$root" fetch -q origin
git -C "$root" worktree list --porcelain | sed -n 's/^worktree //p' | while read -r wt; do
  case "$wt" in "$t3dir"/*) ;; *) continue ;; esac
  [ "$wt" = "$self" ] && continue
  [ -z "$(git -C "$wt" status --porcelain)" ] || continue
  git -C "$wt" merge-base --is-ancestor HEAD "$base" || continue
  printf '%s\t%s\n' "$wt" "$(git -C "$wt" branch --show-current)"
done > <list file>
```

Show the user every line of `<list file>`: the worktree and its branch. Ask them to approve the list, or to name the lines to keep. Take each line they keep out of the file. Then remove the rest:

```sh
root=<workspaceRoot>
while IFS=$'\t' read -r wt branch; do
  git -C "$root" worktree remove "$wt" && { [ -z "$branch" ] || git -C "$root" branch -D "$branch"; }
done < <list file>
git -C "$root" worktree prune
```

Show the user the `git worktree list` from before and after.

**6.1 T3 Connect.** Read the environment with `t3_environment_read`. AFK mode needs T3 Connect linked (remote access on), and its "Hold webhook requests while this environment is offline" preference on (`holdWebhooksWhileOffline`). Without the hold, a delivery that arrives while this machine is offline fails, and GitHub does not retry it (the hourly reconcile finds the missed work later). When the result does not show both as on, tell the user how to turn them on: in T3 Code, open the T3 Connect settings, sign in, turn on remote access, and turn on "Hold webhook requests while this environment is offline". Wait, then read it again. When the result has no field for them, ask the user to confirm both in the T3 Code settings. Step 6.2 shows whether Connect is linked: only then does a task get a `webhookUrl`.

**6.2 The router tasks.** One webhook task per App, because each App has one webhook URL for every repo it is installed on. Run `list_scheduled_tasks` first. Then, for each App (`reviewer`, then `implementer`), one of three cases applies. A task titled `hero-forge router: <app>` already exists (set up from another repo): keep it, and use its `webhookUrl`. Fill the template as step 3 says, with one change: in place of `<<clone_root>>`, use the path the task's prompt already holds. When its `prompt` is the same as the filled template, change nothing. When its `prompt` differs from the filled template, call `update_scheduled_task` with its `scheduledTaskId` and the new `prompt` only: its URL, its secret and its trigger stay. Only when no such task exists, create it:

1. Tell the user to make a webhook secret in their own terminal (for example `openssl rand -hex 32`) and to keep it for the App's settings. Never ask for it in the conversation.
2. Call `request_secret` with the label `<App slug> webhook secret` and the reason "T3 checks the signature of each GitHub delivery with it. Put the same value in the App's Webhook secret." A `secretRef` works once: one request per App.
3. Call `schedule_task` with:
   - `title`: `hero-forge router: <app>`;
   - `prompt`: the text of [router-prompt.md](./router-prompt.md), with each `<<app>>` replaced by `reviewer` or `implementer`, each `<<worker_model>>` by the worker model, each `<<light_worker_model>>` by the light worker model, and each `<<clone_root>>` by the absolute path of the folder that holds this repo's main clone: the parent of the `workspaceRoot` of this repo's project in `t3_project_list`, not of a T3 worktree (the router clones a repo it does not know there). Leave each `{{...}}` as it is: T3 fills it from the delivery;
   - `schedule`: `{type: 'webhook', signature: {header: 'x-hub-signature-256', encoding: 'hex', prefix: 'sha256=', secretRef: <the secretRef>}}`;
   - `bindToCurrentThread`: `false`, so each delivery gets a fresh thread.
4. Report the task's `webhookUrl`: the user pastes it in the App's Webhook URL. No `webhookUrl` means this environment has no T3 Connect managed tunnel: tell the user to turn on T3 Connect remote access (6.1), then read the task again with `list_scheduled_tasks`.

The prompts find the helper CLI through the installed plugin, so a plugin update needs no new task. A plugin update that changes a prompt template reaches the live tasks when this part runs again: the in-place update above, and the same one in 6.4.

**6.3 The App settings.** One App at a time. Run `review.ts app-check --app <app> --repo O/R --webhook-url <that App's webhookUrl>`. It reads the App's settings as the App and prints a report: `pages` (the App's settings page, its permissions page, and the installation page) and `items`, each `ok` or `wrong` with what to change (`fix`).

- Exit 0: no setting is wrong. Then ask the user to confirm each `unverified` item (its `fix` says what to look at, on which page): `webhook active` is always unverified, because the API has no field that shows it. Go on to the next App once they confirm. Each unverified item they cannot confirm: help them fix it, then run `app-check` again.
- Exit 1: show the user each wrong item's `fix`, which names the page, and each `unverified` item. Wait until they say they changed it, then run `app-check` again.
- A wrong `app slug`: `route` trusts only `contract-reviewer[bot]` and `contract-implementer[bot]`. The App named in the env file is another App: point the env file at the right App.
- Exit 4: the App's credentials are broken. Show the message and stop, as in step 4.

What `app-check` expects:

| Setting | `reviewer` | `implementer` |
| --- | --- | --- |
| App slug | `contract-reviewer` | `contract-implementer` |
| Repository permissions | Contents: Read-only; Pull requests: Read and write; Commit statuses: Read and write; Metadata: Read-only | Contents: Read and write; Pull requests: Read and write; Issues: Read and write; Metadata: Read-only; Workflows: No access |
| Subscribe to events (no others: each delivery costs one agent turn) | Pull request; Issue comment | Issues; Issue comment |
| Webhook | Active; URL: the reviewer task's `webhookUrl`; secret: the reviewer's; content type json | Active; URL: the implementer task's `webhookUrl`; secret: the implementer's; content type json |
| Installation | on O/R, with every requested permission accepted | on O/R, with every requested permission accepted |

The pages, for an App an organization owns: `https://github.com/organizations/<org>/settings/apps/<slug>` (the webhook), `.../apps/<slug>/permissions` (permissions and events), and `https://github.com/organizations/<org>/settings/installations/<id>` (the installation, where the user accepts new permissions). For an App a user owns: the same paths under `https://github.com/settings/`. A missing installation: `https://github.com/apps/<slug>/installations/new`.

**6.4 The reconcile task.** Once both Apps pass. `list_scheduled_tasks`: a task titled `hero-forge reconcile: O/R` already exists: keep it. When its `prompt` is the same as the filled template, change nothing. When its `prompt` differs from the filled template, call `update_scheduled_task` with its `scheduledTaskId` and the new `prompt` only: its schedule stays. Only when no such task exists, call `schedule_task` with the `title` `hero-forge reconcile: O/R`, the text of [reconcile-prompt.md](./reconcile-prompt.md) as the `prompt` with each `<<repo>>` replaced by `O/R`, each `<<worker_model>>` by the worker model, each `<<light_worker_model>>` by the light worker model, `schedule` `{type: 'interval', everyMs: 3600000}`, and `bindToCurrentThread` `false`. Report its `nextRunAt`. Each hour it starts the work that a missed delivery should have started.

**6.5 The ruleset.** A ruleset changes how every change reaches the default branch, so ask before you create it: create it now (recommended), or not now. Say what it does: nobody pushes to the default branch directly any more, and each pull request merges only with the `contract-reviewer/gate` status, which only the reviewer App posts. Without it, AFK mode still runs, but nothing on GitHub stops a merge that skipped the gate. Once the ruleset exists, the pull request that lands this config also needs the gate status: a `/review-pipeline` run by hand with the reviewer App posts it.

On yes, write this JSON to a file outside the repo, with `<app_id>` the `app_id` that `app-check --app reviewer` printed:

```json
{
  "name": "hero-forge gate",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "contract-reviewer/gate", "integration_id": <app_id> }]
      }
    }
  ]
}
```

`integration_id` pins the check to the reviewer App, so a status from anyone else does not count. Then `gh api repos/O/R/rulesets --jq '.[] | {id, name}'`: a ruleset named `hero-forge gate` exists: replace it, `gh api -X PUT repos/O/R/rulesets/<id> --input <file>`. Else create it: `gh api -X POST repos/O/R/rulesets --input <file>`. Show the user its page, `https://github.com/O/R/rules/<id>`.

### 7. Done

Tell the user the setup is complete and which engineering skills will now read from these files. Mention they can edit `docs/agents/*.md` directly later (`review-pipeline` reads `docs/agents/review.md` on every run, so its YAML block can be edited by hand); re-running this skill is only necessary if they want to switch issue trackers, change how the repo reviews pull requests, or restart from scratch. A re-run can take one part alone and leaves the other parts as they are.

With AFK mode on, also tell the user: adding `ready-for-agent` to a ticket or a spec starts a build, `paused: true` in the YAML block (on the default branch) stops both Apps, and each router thread ends with one line that says what it started or why it ignored the delivery. Each router and reconcile run removes its own worktree.
