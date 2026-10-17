## What it does

`implement-spec-stack` takes a [spec](https://www.aihero.dev/ai-coding-dictionary/spec) and its [tickets](https://www.aihero.dev/ai-coding-dictionary/ticket) and turns them into a **stack** of draft pull requests, one per ticket. Each ticket is a **layer**: a branch cut from the ticket it waits on, with a PR that targets that branch. Implementer [subagents](https://www.aihero.dev/ai-coding-dictionary/subagent) build the ready tickets in their own git worktrees, and each layer goes through [review-pipeline](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/review-pipeline.md) against its parent layer. Then one final review of the whole stack runs against the spec, and the stack lands bottom-up.

Nothing merges until the whole stack has passed its final review. Upstream `implement-spec` collapses every ticket into one integration branch and reviews it once in the coding session; this skill keeps one reviewed PR per ticket, so each review is small, and the final review can still change any layer before the first one lands.

## When to reach for it

You invoke this by typing `/implement-spec-stack <spec>`, and the agent won't reach for it on its own.

| Your situation | Reach for |
| --- | --- |
| A spec split into tickets with `blocked_by` edges, that should reach `main` as reviewed PRs, one per ticket | `/implement-spec-stack #2` |
| One ticket that should reach `main` through a reviewed PR | [implement-pr](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/implement-pr.md) |
| A spec that isn't split into tickets yet | [to-tickets](https://aihero.dev/skills-to-tickets) first |

## Prerequisites

| It needs | Why |
| --- | --- |
| `docs/agents/review.md`, written by [setup-review-pipeline](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/setup-review-pipeline.md) | every layer and the final review go through the pipeline; without the config, the skill stops before it builds anything |
| GitHub Issues, with the tickets as sub-issues of the spec and the edges as native `blocked_by` dependencies | the stack order comes from that graph; on any other tracker the skill stops |
| Node 22.18 or newer, and `gh` logged in | the stack steps run through the pipeline's helper CLI and `gh` |
| A [harness](https://www.aihero.dev/ai-coding-dictionary/harness) that runs subagents in the background, each in its own git worktree | independent tickets build at the same time |

## The stack

The `blocked_by` graph decides the shape. A ticket with one open blocker branches from it. A ticket with two blockers branches from the deeper one, and when the two are independent, one is stacked onto the other so that the ticket has a single base. A cycle in the graph stops the run with the tickets in the cycle named. A ticket that waits on an open issue outside the spec is left out, with every ticket that waits on it.

| Phase | What happens |
| --- | --- |
| Layer review | each layer's PR targets its parent layer's branch, so its review sees only that ticket's diff. The pipeline stops after the ready flip and, with the reviewer App, its approval: no explainer, no merge |
| Final review | a temporary draft PR from a `stack/spec-<N>` branch to `main` holds the whole stack: the stack is a tree, so the branch merges every layer that has no children. The pipeline reviews it against the spec and builds the explainer, once for the run. A fix lands on the layer it is about. The PR stays a draft, so the App never approves it |
| Landing | bottom-up: squash-merge a layer, then rebase each child `--onto main` from the parent's **pre-landing tip**, so no commit is duplicated. A `git range-diff` must show no content change before the child is pushed, and the gate runs again at the new head (the reviewer App, when you use one, approves it) |

## Common questions

**Why not `/implement-spec` and then `/review-pipeline` on the integration branch?**

One PR for a whole spec gives the reviewers one huge diff, and the review lands only at the end. A stack keeps one PR per ticket, so each review is small and sees only that ticket's change, while the final review still checks the gaps between tickets against the spec. That is why the plugin no longer ships `implement-spec`: it moved to `misc/`, unedited, so that upstream merges do not conflict.

**Why a temporary stack PR for the final review?**

An inline review comment must anchor in its PR's own diff. The top layer's PR diffs against its parent layer, so a finding on a lower layer has nowhere to anchor there. The stack PR diffs the whole stack against `main`. It never merges: it closes after the last layer lands.

**What happens when a rebase during landing changes something?**

The skill puts the branch back where it was, pushes nothing, and asks you. The same happens on a rebase conflict. A landing that needs a human never guesses.

**Can a layer merge early?**

No. A layer run ends at ready, and the skill lands nothing until the final review passes: `stack merge-layer` refuses to merge while the run of the stack PR is not complete. The pipeline's own `merge` refuses a layer.

## It's working if

- The run shows the stack as a tree before it builds, with any re-stacked edge and any left-out ticket named.
- Each layer PR targets its parent layer's branch, and its review comments touch only that ticket's files.
- No layer merges before the stack PR's final review passes, and only the stack PR gets an explainer comment.
- After landing, `git log main` shows one squash commit per ticket, and no commit of a lower layer appears twice.
- The stack PR is closed, and each ticket is closed by its own merged PR.

## Where it fits

`implement-spec-stack` is the whole-spec build step of the PR chain: `to-tickets → implement-spec-stack → review-pipeline`. It consumes the tickets [to-tickets](https://aihero.dev/skills-to-tickets) writes, drives [tdd](https://aihero.dev/skills-tdd) in each implementer, and hands every layer and the final stack to [review-pipeline](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/review-pipeline.md), which needs the run-once [setup-review-pipeline](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/setup-review-pipeline.md). For one ticket at a time, [implement-pr](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/implement-pr.md) is the sibling. For which skill to reach for next, [ask-matt](https://aihero.dev/skills-ask-matt) routes the whole set.
