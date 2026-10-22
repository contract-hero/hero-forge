# The thread step of an AFK run

The AFK runs of `implement-pr`, `implement-spec-stack` and `review-pipeline` end with this step. Each `SKILL.md` says which of its outcomes use which action. This file holds the rest of the rule, in one place for the three skills.

- The thread step is the very last action of the run, on the run's own T3 thread.
- A run that ends with nothing for the maintainer uses action `settle`: `t3_thread_organize` with no `threadId` (so it acts on the run's own thread) and action `settle`.
- A run that needs the maintainer uses action `mark_unread`, so the maintainer sees it. T3 refuses `mark_unread` on a thread whose latest run is still active, also from a queued follow-up turn, so the run calls `t3_thread_configuration` with no `threadId`, which gives its own `threadId`, and then runs `review.ts unread add --thread <threadId>` in the repo. It neither settles the thread nor calls `mark_unread`. The hourly reconcile lists the thread after the run ends and marks the thread unread. The push notification is the signal of the moment; the unread mark comes within one hour. A stop where `review.ts` cannot run (for example, Node is too old) adds nothing: the push notification only.
- Settling takes effect when the turn ends, and a queued message keeps the thread active: a notification that a background job or a subagent sends after the thread step starts one more turn, and the settle of the earlier turn is lost.
- A turn that starts only because a background job or a subagent reported, after this run already did its thread step, does nothing else: it does the thread step again, with the same action, and ends. A second `unread add` of the same thread changes nothing.
- A session with no `t3_thread_organize` tool skips this step.
- A run without `--afk` never settles, archives or marks its thread.
