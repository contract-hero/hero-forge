# Two GitHub Apps drive the pipeline from webhooks, and the skills keep the logic

The **Review pipeline** (ADR 0005) still needs a person to start each run: `/implement-pr`, `/implement-spec-stack` or `/review-pipeline`. We want the user's job to end at the ticket: grill, write the spec and tickets, then add the `ready-for-agent` label. We decided that two GitHub Apps start the runs from GitHub events, through T3 Code webhook tasks. `contract-implementer` (new) is the **Implementer**: it builds tickets and adjudicates reviews. `contract-reviewer` (the existing reviewer App) runs the review pipeline and merges. The Apps are only identities and event sources. The skills keep all the logic, and the slash commands still work by hand.

## Decision

- **Triggers.** The Implementer starts when the user adds `ready-for-agent` to a spec or to a ticket with no parent (the event `sender` must be the user). The triage hand-off moves `needs-triage` to `ready-for-agent`, and GitHub sends its two deliveries in the same second, so the removal of `needs-triage` also starts the build when `ready-for-agent` is on the issue: a router that fails on one delivery loses nothing. Each label event is decided from the issue's labels as GitHub gives them at that time, not from the payload. The removal of any other label starts nothing. A build releases its issue lock when it opens its pull request or pauses, so the second delivery can come after that: an open pull request that closes the issue, or a pause record, then starts nothing. The reviewer starts on every pull request in a repo that has `docs/agents/review.md`, human pull requests included. A re-check starts on the Implementer's "adjudication done" marker comment, or on a `/recheck` comment from a human **Implementer**, never on a push.
- **Merge is automatic.** The reviewer squash-merges on green CI, also for pull requests that the user wrote. A ruleset on `main` requires a pull request and the `contract-reviewer/gate` status check, which only the reviewer App posts, so GitHub enforces the gate even when an agent skips a step.
- **Decisions while the user is away.** The Implementer decides two-way decisions itself and logs them in the pull request body, and the **Spec** reviewer checks each one. A one-way door (data shape, public API, new dependency, migration, destructive action) pauses the run with a comment, the `needs-info` label and a push notification. The user's reply comment resumes it.
- **Trust.** The Implementer acts only on text from the user and from `contract-reviewer[bot]`. Every push, pull request and comment goes through a helper CLI subcommand that mints the App token in its own process, so no agent holds a token.
- **Stacks.** The reviewer merges each layer after the final stack review passes. The Implementer restacks the next layer and pushes. Neither App does the other's job.
- **Routing.** Each App has one webhook URL, so it has one T3 router task. The router finds or clones the target repo as a T3 project and starts a fresh thread in a new worktree there. A per-pull-request lock in the run state serializes events, and a repeat event exits at once.
- **Limits.** Per-ticket attempt cap, a daily run cap for each App, `max_rounds` for review, and `paused: true` in the config as the kill switch. T3 Connect holds webhook requests for 24 hours while the machine is offline, and an hourly reconcile sweep starts any run it missed.
- **Setup.** `setup-forge` grows: it writes the `implementer:` block and the caps, guides the user through the App settings and then verifies them through the API, and creates the T3 tasks. It does not create the Apps.

## Considered options

- **Move the logic into a separate service per App.** An independent deploy, but a second codebase that drifts from the skills.
- **Stop at "approved" and let the user merge.** Safer while trust grows, but the user wanted a pipeline that is fully AFK from label to `main`. The required status check carries that risk instead of a human click.
- **Pause on every decision the spec did not cover.** No guesses reach `main`, but most builds stall overnight. Only one-way doors pause.
- **One long-lived thread per App.** No races, but no parallel builds and an ever-growing context.

## Consequences

- The plugin now depends on T3 Code for unattended runs. Without T3 the skills still work by hand.
- Each event costs one agent turn, because T3 does not filter or dedupe GitHub events. The router must exit fast on events it ignores, and duplicate handling stays in the run state.
- A two-way decision that the Spec reviewer accepts reaches `main` without a human seeing it first. The pull request body's decision log is the audit trail.
