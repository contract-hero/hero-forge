## What it does

`review-pipeline` gives one open pull request an independent review on GitHub. An **Orchestrator** pins the PR head commit, runs N **Reviewer pairs** on it, checks every finding against the code, merges the duplicates, and posts one review with inline ```` ```suggestion ```` blocks and a walkthrough.

The **Implementer**, the [agent](https://www.aihero.dev/ai-coding-dictionary/agent) that wrote the code, never reviews it. It only pins the PR head, prepares the inputs and launches the Orchestrator. On Claude, the Orchestrator is a fresh [subagent](https://www.aihero.dev/ai-coding-dictionary/subagent) that dispatches the reviewers, verifies what they found, and posts. On Codex, it is a read-only session that verifies and consolidates, and the helper CLI starts the reviewers and posts the result. A finding the Orchestrator cannot verify against the code is dropped, not posted.

Then the Implementer does **Adjudication**: it accepts or refutes every finding, answers each one on the PR (a reply in each inline thread, plus one comment per round with every answer), and lands all accepted fixes of the round in one commit. A fresh re-checker, which is neither the Implementer nor the Orchestrator, then checks every finding against the new code: fixed, validly refuted, or still open. A deterministic gate in the helper CLI reads that result, records it at the re-checked commit, and the pipeline posts it as a re-check comment. With or without the reviewer App, the merge needs a passing gate recorded at the PR's head.

When the re-check passes, the pipeline finishes the PR. It rewrites the PR body with [pr](https://aihero.dev/skills-pr) so the body matches the final code, flips the PR from draft to ready, gets the reviewer App's approval when you use one, and builds an explainer page that pitches the change to reviewers and stakeholders. Then it squash-merges the PR, but only when CI is green (or the repo has no PR checks at all) and GitHub reports the PR mergeable. Red CI or a merge conflict stops the pipeline and asks you: it never merges around them.

With a reviewer GitHub App configured, the App's bot posts the review, the re-checks and the verdict, so the review is clearly not from you. A passing re-check gets the App's approval on the re-checked commit right after the PR goes ready, and the merge waits for that approval, confirmed on GitHub. When the rounds run out, the App requests changes. Without the App, everything posts from your own account as COMMENT reviews.

## When to reach for it

Type `/review-pipeline <PR>`, or the agent reaches for it automatically when a task fits.

Reach for it when a pull request is open and needs a review that lands on the PR itself, including a PR you opened by hand. For a quick review of a branch that reports to chat inside your own session, use [code-review](https://aihero.dev/skills-code-review) instead.

## Prerequisites

| It needs | Why |
| --- | --- |
| `docs/agents/review.md`, written by [setup-review-pipeline](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/setup-review-pipeline.md) | it holds the runtime, the number of pairs, and the model and effort of each role; without it the pipeline stops and points you to setup |
| the Codex CLI, installed and logged in, for `runtime: codex` | the Orchestrator and the reviewers run as `codex exec` sessions; if `codex` is missing or broken, the pipeline stops and points you to setup |
| Node 22.18 or newer, and `gh` logged in | the helper CLI that posts the review and keeps the run state is TypeScript run by Node, and it posts through `gh api` |
| the reviewer App's credentials in `~/.config/hero-pocock/`, for `app: enabled` (optional) | the helper CLI mints a short-lived App token from them for each post; setup writes them, or copies them from `/lfg` |

It keeps its working files outside the repo, in `hero-pocock/pr-<N>/` inside the git common dir, so nothing is committed.

## Reviewer pairs

Each pair is two fresh reviewers looking at the same fixed point:

| Reviewer | Judges the diff against | Reuses |
| --- | --- | --- |
| Standards | the repo's documented standards, a code-smell baseline, and a bug axis: bugs, silent failures, test gaps | `code-review`'s Standards prompt, plus the pipeline's own bug-axis file |
| Spec | the issue or spec the PR closes | `code-review`'s Spec prompt |

Every pair gets the same prompt and a different focus order (a rotated file list and checklist), so more pairs find more for little extra cost. The Orchestrator groups findings that land on the same lines across pairs. Agreement raises a finding's confidence, shown as `2/2 pairs`. Findings stay labelled by axis and are never merged across axes.

## Runtimes

One runtime runs both the Orchestrator and the reviewers, set by `runtime` in the config:

| Runtime | Orchestrator | Reviewers |
| --- | --- | --- |
| `codex` | one read-only `codex exec` session that verifies and consolidates; the helper CLI starts the reviewers and posts | 2N read-only `codex exec` sessions, each held to the findings JSON schema |
| `claude` | one Claude subagent | 2N read-only Claude subagents |

The steps, the run dir and the posted review are the same on both. Only the launch changes.

## Common questions

**With two pairs, do I get two reviews on the PR?**

No. The Orchestrator consolidates all 2N reviewer outputs into one payload and posts one review. The walkthrough table shows which pairs raised each finding.

**What is a round, and does a failed round review the PR again?**

A round is one Adjudication plus one re-check. When the re-check leaves findings open, the next round answers only those open findings and runs a new re-check. It does not start a new full review, so the goalposts do not move between rounds.

**What happens when the rounds run out?**

`max_rounds` in `docs/agents/review.md` sets how many failed rounds the pipeline accepts (2 by default). When the last one fails, the pipeline stops, the PR stays in draft, and the agent asks you what to do, with the open findings listed. It never starts an extra round by itself.

**Will it merge a PR in a repo with no CI?**

Yes. A PR with no checks at all counts as green (`ci: none`). Right after a push, in a repo with workflow files, the pipeline waits 30 seconds once, because GitHub may not have registered the checks yet.

**Will it merge when CI is red, or when the PR has a conflict?**

No. Before the merge, the helper CLI reads the PR's checks and its mergeability. A failed check, a conflict, a branch that is behind or blocked by branch protection, or a new commit after the re-check stops the pipeline, and the agent asks you what to do. While CI runs, it waits. The merge is always a squash merge of the exact commit the re-checker graded, and it never uses `--admin`.

**Where does the explainer go? Is it published?**

It stays on your machine, in the run dir (`hero-pocock/pr-<N>/explainer.html` inside the git common dir). It is never committed and never published. The PR gets one comment with its local path, so whoever opens the PR on that machine can find it.

**Can I review a PR without merging it?**

A plain `/review-pipeline <PR>` merges at the end. [implement-spec-stack](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/implement-spec-stack.md) starts the run with `--mode layer` or `--mode stack-final`, which stop earlier: a stack layer stops once the PR is ready, and the whole-stack PR stops after the explainer, because the stack lands its layers itself. Those modes are for the stack; a plain run has no "do not merge" switch yet. To keep the PR open, tell the agent so before it reaches the merge.

**Can the Implementer mark its own fixes as done?**

No. The Implementer writes the fixes and the refutations, so a fresh re-checker grades them, and the gate is a fixed check, not a judgment: every finding has a decision, every posted finding is in the ledger, the re-check covers exactly the ledger, and nothing is open.

**What if the session dies halfway through?**

Run it again on the same PR. The run state records the last completed step and the id of the posted review, so a re-run on the same PR and commit resumes and does not post a second review. If the state file is lost, the pipeline still finds its own review on GitHub by a hidden marker, and it trusts that marker only in a review from the same account on the same commit.

**What if the Orchestrator ends before its reviewers report?**

On Claude, the Orchestrator starts its reviewers in the foreground and waits for all of them, so this should not happen. If it ends anyway with reviewer outputs missing, the Implementer resumes the same Orchestrator with a message and does not start a new one, because a new one would lose the reviewers that still run. If outputs are still missing after that one resume, the pipeline stops and names the missing reviewers.

**Does it post as a bot?**

Only with a reviewer GitHub App. Run `/setup-review-pipeline` and choose the App: the config then has `app: enabled`, and every review, re-check and verdict shows the App's `<slug>[bot]` name. The helper CLI mints the App's token itself for each post, so no agent sees it. Without the App, the reviews post from your own `gh` account as COMMENT reviews, which never approve or block the PR, and the recorded re-check gate decides the merge.

**What if the App is set up but broken?**

The pipeline stops and tells you why: the credentials are missing, the key is wrong, or the App is not installed on the repo. It never posts as you instead, because that would quietly turn the approval gate off. Fix the App, or re-run `/setup-review-pipeline` without it.

**Can it run on Codex?**

Yes. With `runtime: codex`, every Codex call goes through the helper CLI, which passes the model and the effort from your config on each call. Every Codex session is read-only, with no network and no gh token, because it reads untrusted PR text. So the helper CLI, not an agent, starts each reviewer, checks the Orchestrator's payload against a schema, and posts it. It refuses to post a payload that looks like it holds a token or a key. That scan is a second line of defence, not a guarantee: an agent could encode a secret so that no scanner sees it, which is why no Codex session gets a token in the first place. It does not use a Codex plugin's review command, because that command drops the effort and Codex then falls back to `~/.codex/config.toml`. If a model rejects the configured effort (for example, `gpt-6.1-sol` rejects `minimal`), the pipeline stops and tells you to fix the effort in the config.

**Does the Codex runtime need Claude Code?**

No. The Implementer needs a shell, `git`, `node`, `gh` and `codex`, and nothing else. A Codex session can run the whole pipeline.

**How do I see what a helper CLI subcommand takes?**

Run `review.ts help` for the list of every subcommand with its one-line summary. Then add `--help` to one of them, for example `review.ts codex-exec --help`, to see its summary and its usage line. Both print to stdout and exit 0. An unknown subcommand, or a typo, exits non-zero and prints the same list. All of that text comes from one usage table in the CLI, so the help never drifts from what the subcommands accept.

## It's working if

- The PR gets exactly one review per run, from the App's bot or from your account, with inline suggestions you can apply in the GitHub UI. Each round adds only a re-check comment.
- The walkthrough names the runtime, the models, the number of pairs and the commit it reviewed, and lists the findings it dropped with a reason.
- Running it again on the same PR and commit posts nothing new.
- Every inline finding gets an `ACCEPT:` or `REFUTE:` reply in its thread, and each round gets one adjudication comment that also covers the walkthrough items.
- Each round with accepted fixes adds exactly one `apply review round <R>` commit.
- Each round ends with a re-check comment that lists every finding as fixed, refutation accepted, or open.
- With the App, the PR goes ready first and then gets one App approval on the re-checked commit, and a run that runs out of rounds ends with one App request for changes.
- After a passing re-check, the PR body shows the `pr` template for the final code and still closes its issues, the PR is ready for review, and it carries one "Explainer (local, not published)" comment.
- The PR lands as one squash commit only after its checks pass. A red check or a conflict gets a question from the agent, not a merge.
- A repo with no `docs/agents/review.md` gets a pointer to `/setup-review-pipeline`, not a guessed review.
- On `runtime: codex`, each Codex log in the run dir shows the model and the reasoning effort from your config, not your `~/.codex/config.toml` defaults.

## Where it fits

`review-pipeline` is the **chain step** after a pull request opens: it follows [pr](https://aihero.dev/skills-pr), which shapes the PR body, and it needs the run-once [setup-review-pipeline](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/setup-review-pipeline.md) first. Its in-session sibling is [code-review](https://aihero.dev/skills-code-review), whose two axes it reuses. For which skill to reach for next, [ask-matt](https://aihero.dev/skills-ask-matt) routes the whole set.
