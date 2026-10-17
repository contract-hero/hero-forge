## What it does

`review-pipeline` gives one open pull request an independent review on GitHub. An **Orchestrator** pins the PR head commit, runs N **Reviewer pairs** on it, checks every finding against the code, merges the duplicates, and posts one review with inline ```` ```suggestion ```` blocks and a walkthrough.

The agent that wrote the code never reviews it. The coding [agent](https://www.aihero.dev/ai-coding-dictionary/agent) only prepares the inputs and launches the Orchestrator, a fresh [subagent](https://www.aihero.dev/ai-coding-dictionary/subagent) that dispatches the reviewers, verifies what they found, and posts. A finding the Orchestrator cannot verify against the code is dropped, not posted.

This version stops after the review is posted. Adjudication, the re-check, the reviewer App identity, the merge and the Codex runtime arrive in later steps of the [spec](https://github.com/contract-hero/hero-pocock/issues/2).

## When to reach for it

Type `/review-pipeline <PR>`, or the agent reaches for it automatically when a task fits.

Reach for it when a pull request is open and needs a review that lands on the PR itself, including a PR you opened by hand. For a quick review of a branch that reports to chat inside your own session, use [code-review](https://aihero.dev/skills-code-review) instead.

## Prerequisites

| It needs | Why |
| --- | --- |
| `docs/agents/review.md`, written by [setup-review-pipeline](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/setup-review-pipeline.md) | it holds the runtime, the number of pairs, and the model and effort of each role; without it the pipeline stops and points you to setup |
| `runtime: claude` in that file | this version runs the Orchestrator and the reviewers as Claude subagents only |
| Node 22.18 or newer, and `gh` logged in | the helper CLI that posts the review and keeps the run state is TypeScript run by Node, and it posts through `gh api` |

It keeps its working files outside the repo, in `hero-pocock/pr-<N>/` inside the git common dir, so nothing is committed.

## Reviewer pairs

Each pair is two fresh reviewers looking at the same fixed point:

| Reviewer | Judges the diff against | Reuses |
| --- | --- | --- |
| Standards | the repo's documented standards, a code-smell baseline, and a bug axis: bugs, silent failures, test gaps | `code-review`'s Standards prompt, plus the pipeline's own bug-axis file |
| Spec | the issue or spec the PR closes | `code-review`'s Spec prompt |

Every pair gets the same prompt and a different focus order (a rotated file list and checklist), so more pairs find more for little extra cost. The Orchestrator groups findings that land on the same lines across pairs. Agreement raises a finding's confidence, shown as `2/2 pairs`. Findings stay labelled by axis and are never merged across axes.

## Common questions

**With two pairs, do I get two reviews on the PR?**

No. The Orchestrator consolidates all 2N reviewer outputs into one payload and posts one review per round. The walkthrough table shows which pairs raised each finding.

**What if the session dies halfway through?**

Run it again on the same PR. The run state records the last completed step and the id of the posted review, so a re-run on the same PR and commit resumes and does not post a second review. If the state file is lost, the pipeline still finds its own review on GitHub by a hidden marker, and it trusts that marker only in a review from the same account on the same commit.

**Does it post as a bot?**

Not yet. This version posts from your own `gh` account as a COMMENT review. A COMMENT review never approves or blocks the PR.

**Can it run on Codex?**

Not in this version. With `runtime: codex` in the config, it stops before the review and tells you so.

## It's working if

- The PR gets exactly one review per run, from your account, with inline suggestions you can apply in the GitHub UI.
- The walkthrough names the runtime, the models, the number of pairs and the commit it reviewed, and lists the findings it dropped with a reason.
- Running it again on the same PR and commit posts nothing new.
- A repo with no `docs/agents/review.md` gets a pointer to `/setup-review-pipeline`, not a guessed review.

## Where it fits

`review-pipeline` is the **chain step** after a pull request opens: it follows [pr](https://aihero.dev/skills-pr), which shapes the PR body, and it needs the run-once [setup-review-pipeline](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/setup-review-pipeline.md) first. Its in-session sibling is [code-review](https://aihero.dev/skills-code-review), whose two axes it reuses. For which skill to reach for next, [ask-matt](https://aihero.dev/skills-ask-matt) routes the whole set.
