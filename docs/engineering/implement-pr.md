## What it does

`implement-pr` builds one [ticket](https://www.aihero.dev/ai-coding-dictionary/ticket) and takes it to a reviewed pull request. It fetches the ticket, builds it with [tdd](https://aihero.dev/skills-tdd) at the pre-agreed seams the way upstream `implement` does, pushes a branch, and opens a **draft** PR whose body follows [pr](https://aihero.dev/skills-pr) and closes the ticket. Then it hands the PR to [review-pipeline](https://github.com/contract-hero/hero-forge/blob/main/docs/engineering/review-pipeline.md) with no question in between.

The [agent](https://www.aihero.dev/ai-coding-dictionary/agent) that writes the code never reviews it. Upstream `implement` runs `code-review` in its own session and commits to the current branch. `implement-pr` never commits on the default branch and runs no review of its own: the review comes from the pipeline's Orchestrator and lands on the PR.

## When to reach for it

Type `/implement-pr <ticket>`, or an agent or router asks for `implement-pr` by name through the Skill tool, so an orchestrated or [AFK](https://www.aihero.dev/ai-coding-dictionary/afk) run can build a ticket. It does not fire on a passing mention of a ticket.

| The work is... | Reach for |
| --- | --- |
| A ticket that should reach `main` through a reviewed PR | `/implement-pr #42` |
| A PR that is already open, built by hand or by another tool | [review-pipeline](https://github.com/contract-hero/hero-forge/blob/main/docs/engineering/review-pipeline.md) directly |
| A spec, not yet split up | [to-tickets](https://aihero.dev/skills-to-tickets) first, then `/implement-pr` per ticket |

## Prerequisites

| It needs | Why |
| --- | --- |
| `docs/agents/review.md`, written by [setup-review-pipeline](https://github.com/contract-hero/hero-forge/blob/main/docs/engineering/setup-review-pipeline.md) | the pipeline reads it; without it, `implement-pr` stops before it builds anything and points you to setup |
| Node 22.18 or newer, and `gh` logged in | the config check is the pipeline's helper CLI, and the PR opens through `gh` |
| A ticket on the issue tracker that [setup-matt-pocock-skills](https://aihero.dev/skills-setup-matt-pocock-skills) configured | it fetches the ticket from there, and a GitHub issue gets closed by the merge |

## Ticket to merged PR

One run is a chain with one owner change in the middle:

| Step | Owner |
| --- | --- |
| Check the review config, fetch the ticket, pick the branch | `implement-pr` |
| Build at the seams with `tdd`, commit, push | `implement-pr` |
| Write the body with `pr`, ending with `Closes #<ticket>`, and open the draft PR | `implement-pr` |
| Review, Adjudication, re-check, body rewrite, ready, explainer, squash merge | `review-pipeline` |

The draft state is the point. A PR goes ready only after the pipeline's re-check passes, so "ready" means reviewed.

## Common questions

**Why not `/implement` and then `/review-pipeline`?**

Upstream `implement` commits to the branch you are on, which can be the default branch, and it runs a review inside the coding session first. `implement-pr` puts the work on a ticket branch, opens the PR, and starts the pipeline itself, so an AFK run goes from ticket to merge without you. That is why the plugin no longer ships `implement`: it moved to `misc/`, unedited, so that upstream merges do not conflict.

**What happens without `docs/agents/review.md`?**

It stops at the first step, before any code changes, and tells you to run `/setup-review-pipeline`. A broken config stops it the same way, with the error from the config check.

**Does it close the ticket?**

The merge does. The PR body ends with `Closes #<ticket>`, and the pipeline keeps that line when it rewrites the body after review. A ticket on a tracker other than GitHub Issues gets a link in the body instead, and you close it yourself.

**Will it merge without asking me?**

Only when the review passes and CI is green. The pipeline stops and asks you when the rounds run out, when CI is red, or when the PR has a conflict.

## It's working if

- An agent that calls the Skill tool with `implement-pr` and a ticket starts the same run as `/implement-pr`.
- The run states the ticket's title before it builds, and you can see a `tdd` Skill tool call in the trace.
- The work never lands on the default branch: a run started there creates a `ticket/<number>-<slug>` branch first.
- The PR opens as a draft, with Summary, Evidence and Merge Danger sections, and GitHub lists the ticket under the PR's linked issues.
- The pipeline's first review appears on the PR without you typing `/review-pipeline`.
- A repo with no review config gets a pointer to `/setup-review-pipeline` and no new commits.

## Where it fits

`implement-pr` is the build step of the PR chain: `to-tickets → implement-pr → review-pipeline`. It consumes the tickets [to-tickets](https://aihero.dev/skills-to-tickets) produces, drives [tdd](https://aihero.dev/skills-tdd) at each seam, and hands the PR to [review-pipeline](https://github.com/contract-hero/hero-forge/blob/main/docs/engineering/review-pipeline.md), which needs the run-once [setup-review-pipeline](https://github.com/contract-hero/hero-forge/blob/main/docs/engineering/setup-review-pipeline.md). For which skill to reach for next, [ask-matt](https://aihero.dev/skills-ask-matt) routes the whole set.
