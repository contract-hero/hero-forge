---
name: setup-review-pipeline
description: "Configure how this repo reviews pull requests: the runtime, the number of reviewer pairs, the model and effort of each role, the round limit, and whether a reviewer GitHub App posts the reviews. Run once before the first review-pipeline run. Use only on an explicit request for this skill by name: the user runs /setup-review-pipeline, or an agent or router asks for setup-review-pipeline through the Skill tool. Do not start it because the review config is missing or mentioned."
---

# Setup Review Pipeline

Write the per-repo config that `review-pipeline` reads: `docs/agents/review.md` (prose plus one YAML block) and a `### Review` entry in the `## Agent skills` block of `CLAUDE.md` or `AGENTS.md`.

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write.

The helper CLI lives in the `review-pipeline` skill folder, a sibling of the folder this SKILL.md is in. Below, `review.ts` means `node "<the folder this SKILL.md is in>/../review-pipeline/scripts/review.ts"`.

## Process

### 1. Explore

Read whatever exists; don't assume:

- `node --version`: the helper CLI needs Node 22.18 or newer. If it is older, tell the user to upgrade Node and stop.
- `codex --version`: exit 0 means Codex is installed. This picks the recommended runtime.
- `docs/agents/review.md`: a previous run's output. If it exists, run `review.ts config` (from the repo root). Exit 0 gives the current answers as JSON: use them as the recommended answers below in place of the defaults. Exit 4 means the file is broken: show the message, and recommend the defaults.
- `CLAUDE.md` and `AGENTS.md` at the repo root: which exists, and does it already have an `## Agent skills` block with a `### Review` entry?
- `gh repo view --json nameWithOwner`: the repo as `O/R`, for the App check.
- Reviewer App credentials. Check only that these files exist (`test -f <path>`). Never print, `cat` or read them: they hold the App ID and the path to a private key.
  - `~/.config/hero-forge/reviewer-app.env`: this plugin's credentials.

### 2. Present findings and ask

Summarise what you found. Then ask, one question at a time, each with the recommended answer first so the user can accept it in a word.

**Runtime.** One runtime runs both the Orchestrator and the reviewers. Never offer a mix: the pipeline cannot dispatch one.

| Runtime | When to recommend it | Orchestrator | Reviewers |
| --- | --- | --- | --- |
| `codex` (`codex exec`) | Codex is installed | `gpt-6-astra`, `low` effort | `gpt-6.1-sol`, `high` effort |
| `claude` (sub-agents) | Codex is not installed | `claude-opus-5-5`, `medium` effort | `claude-sonnet-5-5`, `high` effort |

Offer `codex` only when Codex is installed.

**Reviewer pairs.** How many pairs run per round (default 2). Each pair is one Standards reviewer and one Spec reviewer, so N pairs cost 2N reviewer runs. One pair is the cheapest; more pairs find more, at more cost.

**Models and effort.** Ask whether to keep the runtime's defaults for both roles. Only if the user says no, ask for the model and effort of each role, from the chosen runtime only:

- Effort for `codex`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. A model can reject a value it does not support (for example, `gpt-6.1-sol` rejects `minimal`); Codex reports this when the pipeline runs.
- Effort for `claude`: `low`, `medium`, `high`, `xhigh`, `max`.
- A `claude` model is a full id (`claude-<family>-...`) or a bare `opus`, `sonnet`, `haiku`, `fable`. The family picks the sub-agent model.

**Round limit.** How many failed re-check rounds run before the pipeline stops and asks the user (`max_rounds`, default 2).

**Reviewer App.** Does a reviewer GitHub App post the reviews? With the App, the reviews show the App's bot, not the user, and at the end of the loop the App approves the PR or requests changes. Without it, the reviews post from the user's own `gh` account as COMMENT reviews, and the re-check gate is the merge gate. This skill uses an App that already exists and is installed on the repo; it does not create one. The App needs these permissions: Pull requests read and write, Contents read, Metadata read.

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

Show the user both drafts and let them edit before you write:

- The whole new `docs/agents/review.md`, from the seed template [review.md](./review.md) with every placeholder filled. The YAML block states every field, even the ones left at their defaults.
- The `### Review` entry for the `## Agent skills` block (step 4 has the format).

With the App, the block has the line `app: enabled`. Without it, the block has no `app` line.

### 4. Write

**The App credentials** (only when the user chose the App):

Check the App before the config says `app: enabled`. Save the draft config to a temp file outside the repo and run `review.ts app-token --repo O/R --check --config <temp file>`. It mints a token and prints nothing.
- Exit 0: the App can post on this repo. Write the config with `app: enabled`.
- Exit 4: show the message (for example, the App is not installed on `O/R`, or GitHub refused the key). Ask the user to fix it and check again, or to write the config without the App. Never write `app: enabled` for an App that fails this check.

**`docs/agents/review.md`**: write the whole file, replacing any previous version. Create `docs/agents/` if it is missing.

**The `### Review` entry.** Pick the file the same way `setup-matt-pocock-skills` does:

- If `CLAUDE.md` exists, edit it.
- Else if `AGENTS.md` exists, edit it.
- If neither exists, ask the user which one to create; don't pick for them.

The entry:

```markdown
### Review

<N> reviewer pairs on <Codex | Claude sub-agents>, max <max_rounds> rounds, <reviews and approval by the reviewer App | COMMENT reviews as you>. See `docs/agents/review.md`.
```

Keep it to one entry:

- If a `### Review` subsection exists, replace it: from its heading through the line before the next `###` or `##` heading (or the end of the file). Change nothing else.
- Else if an `## Agent skills` block exists, add the entry as the last subsection of that block.
- Else add a new `## Agent skills` block, holding only this entry, at the end of the file.

Don't change the other subsections of the block or any other part of the file.

### 5. Check

From the repo root, run `review.ts config`. It must exit 0. Show the user the JSON it prints: that is what `review-pipeline` will use. A non-zero exit means the file you wrote is wrong: fix it and run the check again. With the App, `app` is `true`; also run `review.ts app-token --repo O/R --login` and show the login it prints, `<slug>[bot]`: the reviews will show that name.

### 6. Done

Tell the user the setup is complete. `review-pipeline` reads `docs/agents/review.md` on every run, so they can edit the YAML block by hand later; re-running this skill is only needed to start over. If `setup-matt-pocock-skills` runs again later, it can rewrite the `## Agent skills` block from its own template and drop the `### Review` entry: then run this skill again to restore it.
