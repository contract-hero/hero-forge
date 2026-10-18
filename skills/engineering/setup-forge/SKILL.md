---
name: setup-forge
description: "Configure this repo for the engineering skills in one run: its issue tracker, triage label vocabulary, domain doc layout, and how it reviews pull requests (runtime, reviewer pairs, model and effort per role, round limit, reviewer App). Re-runs one part alone when asked. Run once before first use of the other engineering skills. Use when the user wants a repo set up for the engineering skills, or asks to change its issue tracker, triage labels, domain doc layout, or how it reviews pull requests. Do not start it only because a config file is missing."
---

# Setup Forge

Scaffold the per-repo configuration that the engineering skills assume, in four parts:

- **Issue tracker**: where issues live (GitHub by default; local markdown is also supported out of the box)
- **Triage labels**: the strings used for the five canonical triage roles
- **Domain docs**: where `GLOSSARY.md` and ADRs live, and the consumer rules for reading them
- **Review pipeline**: the config that `review-pipeline` reads, `docs/agents/review.md` (prose plus one YAML block): the runtime, the number of reviewer pairs, the model and effort of each role, the round limit, and whether a reviewer GitHub App posts the reviews

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

### 3. Confirm and edit

Show the user a draft of:

- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 4 for selection rules). When one part runs alone, show only that part's entry.
- The contents of `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, and `docs/agents/triage-labels.md` (the last only when `triage` is installed)
- The whole new `docs/agents/review.md`, from the seed template [review.md](./review.md) with every placeholder filled. The YAML block states every field, even the ones left at their defaults. With the App, the block has the line `app: enabled`. Without it, the block has no `app` line.

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

<N> reviewer pairs on <Codex | Claude sub-agents>, max <max_rounds> rounds, <reviews and approval by the reviewer App | COMMENT reviews as you>. See `docs/agents/review.md`.
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

**`docs/agents/review.md`**: write the whole file, replacing any previous version. Create `docs/agents/` if it is missing.

### 5. Check

When the review pipeline part ran: from the repo root, run `review.ts config`. It must exit 0. Show the user the JSON it prints: that is what `review-pipeline` will use. A non-zero exit means the file you wrote is wrong: fix it and run the check again. With the App, `app` is `true`; also run `review.ts app-token --repo O/R --login` and show the login it prints, `<slug>[bot]`: the reviews will show that name.

### 6. Done

Tell the user the setup is complete and which engineering skills will now read from these files. Mention they can edit `docs/agents/*.md` directly later (`review-pipeline` reads `docs/agents/review.md` on every run, so its YAML block can be edited by hand); re-running this skill is only necessary if they want to switch issue trackers, change how the repo reviews pull requests, or restart from scratch. A re-run can take one part alone and leaves the other parts as they are.
