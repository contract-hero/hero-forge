# The thread step of an AFK run

The AFK runs of `implement-pr`, `implement-spec-stack` and `review-pipeline` end with this step. Each `SKILL.md` says which of its outcomes use which action. This file holds the rest of the rule, in one place for the three skills.

- The thread step is the very last action of the run: `t3_thread_organize` with no `threadId`, so it acts on the run's own T3 thread.
- A run that ends with nothing for the maintainer uses action `settle`. A run that needs the maintainer uses action `mark_unread`, so the maintainer sees it.
- Settling takes effect when the turn ends, and a queued message keeps the thread active: a notification that a background job or a subagent sends after the thread step starts one more turn, and the settle of the earlier turn is lost.
- A turn that starts only because a background job or a subagent reported, after this run already did its thread step, does nothing else: it does the thread step again, with the same action, and ends.
- A session with no `t3_thread_organize` tool skips this step.
- A run without `--afk` never settles, archives or marks its thread.
