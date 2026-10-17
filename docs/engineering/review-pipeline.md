## What it does

`review-pipeline` gives one open pull request an independent review on GitHub. An **Orchestrator** pins the PR head commit, runs N **Reviewer pairs** on it, checks every finding against the code, merges the duplicates, and posts one review with inline ```` ```suggestion ```` blocks and a walkthrough.

The agent that wrote the code never reviews it. The coding [agent](https://www.aihero.dev/ai-coding-dictionary/agent) only prepares the inputs and launches the Orchestrator, a fresh [subagent](https://www.aihero.dev/ai-coding-dictionary/subagent) or Codex session that dispatches the reviewers, verifies what they found, and posts. A finding the Orchestrator cannot verify against the code is dropped, not posted.

Then the coding agent does **Adjudication**: it accepts or refutes every finding, answers each one on the PR (a reply in each inline thread, plus one comment per round with every answer), and lands all accepted fixes of the round in one commit. A fresh re-checker, which is neither the coding agent nor the Orchestrator, then checks every finding against the new code: fixed, validly refuted, or still open. A deterministic gate in the helper CLI reads that result, and the pipeline posts it as a re-check comment. Without the reviewer App, that gate is the merge gate.

This version stops after a passing re-check, with the PR still in draft. The reviewer App identity and the merge arrive in later steps of the [spec](https://github.com/contract-hero/hero-pocock/issues/2).

## When to reach for it

Type `/review-pipeline <PR>`, or the agent reaches for it automatically when a task fits.

Reach for it when a pull request is open and needs a review that lands on the PR itself, including a PR you opened by hand. For a quick review of a branch that reports to chat inside your own session, use [code-review](https://aihero.dev/skills-code-review) instead.

## Prerequisites

| It needs | Why |
| --- | --- |
| `docs/agents/review.md`, written by [setup-review-pipeline](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/setup-review-pipeline.md) | it holds the runtime, the number of pairs, and the model and effort of each role; without it the pipeline stops and points you to setup |
| the Codex CLI, installed and logged in, for `runtime: codex` | the Orchestrator and the reviewers run as `codex exec` sessions; if `codex` is missing or broken, the pipeline stops and points you to setup |
| Node 22.18 or newer, and `gh` logged in | the helper CLI that posts the review and keeps the run state is TypeScript run by Node, and it posts through `gh api` |

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
| `codex` | one `codex exec` session with full access, so it can start the reviewers and post | 2N read-only `codex exec` sessions, each held to the findings JSON schema |
| `claude` | one Claude subagent | 2N read-only Claude subagents |

The steps, the run dir and the posted review are the same on both. Only the launch changes.

## Common questions

**With two pairs, do I get two reviews on the PR?**

No. The Orchestrator consolidates all 2N reviewer outputs into one payload and posts one review. The walkthrough table shows which pairs raised each finding.

**What is a round, and does a failed round review the PR again?**

A round is one Adjudication plus one re-check. When the re-check leaves findings open, the next round answers only those open findings and runs a new re-check. It does not start a new full review, so the goalposts do not move between rounds.

**What happens when the rounds run out?**

`max_rounds` in `docs/agents/review.md` sets how many failed rounds the pipeline accepts (2 by default). When the last one fails, the pipeline stops, the PR stays in draft, and the agent asks you what to do, with the open findings listed. It never starts an extra round by itself.

**Can the coding agent mark its own fixes as done?**

No. The coding agent writes the fixes and the refutations, so a fresh re-checker grades them, and the gate is a fixed check, not a judgment: every finding has a decision, every posted finding is in the ledger, the re-check covers exactly the ledger, and nothing is open.

**What if the session dies halfway through?**

Run it again on the same PR. The run state records the last completed step and the id of the posted review, so a re-run on the same PR and commit resumes and does not post a second review. If the state file is lost, the pipeline still finds its own review on GitHub by a hidden marker, and it trusts that marker only in a review from the same account on the same commit.

**Does it post as a bot?**

Not yet. This version posts from your own `gh` account as a COMMENT review. A COMMENT review never approves or blocks the PR.

**Can it run on Codex?**

Yes. With `runtime: codex`, every Codex call goes through the helper CLI, which passes the model and the effort from your config on each call. It does not use a Codex plugin's review command, because that command drops the effort and Codex then falls back to `~/.codex/config.toml`. If a model rejects the configured effort (for example, `gpt-6.1-sol` rejects `minimal`), the pipeline stops and tells you to fix the effort in the config.

**Does the Codex runtime need Claude Code?**

No. The coding agent needs a shell, `git`, `node`, `gh` and `codex`, and nothing else. A Codex session can run the whole pipeline.

## It's working if

- The PR gets exactly one review per run, from your account, with inline suggestions you can apply in the GitHub UI. Each round adds only a re-check comment.
- The walkthrough names the runtime, the models, the number of pairs and the commit it reviewed, and lists the findings it dropped with a reason.
- Running it again on the same PR and commit posts nothing new.
- Every inline finding gets an `ACCEPT:` or `REFUTE:` reply in its thread, and each round gets one adjudication comment that also covers the walkthrough items.
- Each round with accepted fixes adds exactly one `apply review round <R>` commit.
- Each round ends with a re-check comment that lists every finding as fixed, refutation accepted, or open.
- A repo with no `docs/agents/review.md` gets a pointer to `/setup-review-pipeline`, not a guessed review.
- On `runtime: codex`, each Codex log in the run dir shows the model and the reasoning effort from your config, not your `~/.codex/config.toml` defaults.

## Where it fits

`review-pipeline` is the **chain step** after a pull request opens: it follows [pr](https://aihero.dev/skills-pr), which shapes the PR body, and it needs the run-once [setup-review-pipeline](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/setup-review-pipeline.md) first. Its in-session sibling is [code-review](https://aihero.dev/skills-code-review), whose two axes it reuses. For which skill to reach for next, [ask-matt](https://aihero.dev/skills-ask-matt) routes the whole set.
