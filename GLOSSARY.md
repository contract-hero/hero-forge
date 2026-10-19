# hero-forge

A collection of agent skills (slash commands and behaviors) loaded by Claude Code. Skills are organized into buckets and consumed by per-repo configuration emitted by `/setup-forge`.

## Language

**Issue tracker**:
The tool that hosts a repo's issues: GitHub Issues, Linear, a local `.scratch/` markdown convention, or similar. Skills like `to-tickets`, `to-spec`, and `triage` read from and write to it.
_Avoid_: backlog manager, backlog backend, issue host

**Issue**:
A single tracked unit of work inside an **Issue tracker**: a bug, task, spec, or slice produced by `to-tickets`.
_Avoid_: ticket (use only when quoting external systems that call them tickets, or for a **Decision ticket**, see below)

**Decision ticket**:
A `wayfinder` unit: a child **Issue** of a `wayfinder:map` holding a *question* whose resolution is a decision, not a slice of a build to execute. The **decision** qualifier is what keeps it distinct from an implementation ticket; `wayfinder` introduces the term, then uses "ticket".

**Triage role**:
A canonical state-machine label applied to an **Issue** during triage (e.g. `needs-triage`, `ready-for-afk`). Each role maps to a real label string in the **Issue tracker** via `docs/agents/triage-labels.md`.

**Review pipeline**:
The path a pull request takes from draft to merge: review, adjudication, re-check, and merge. A repo configures it once, at setup.

**Orchestrator**:
The agent that owns one review round: it verifies and consolidates the findings of the **Reviewer pairs** into the one review that the round posts on the pull request. It is never the **Implementer**.
_Avoid_: lead, coordinator

**Reviewer pair**:
Two fresh reviewers that look at the same fixed point: **Standards** and **Spec**. A **Review pipeline** runs one or more pairs per round.

**Standards** (reviewer):
The reviewer that judges the change against the repo's own standards, a code-smell baseline, and correctness (bugs, silent failures, test gaps).

**Spec** (reviewer):
The reviewer that judges the change against the **Issue** or spec it came from.

**Implementer**:
The agent that builds a ticket into a pull request and answers the reviews of that pull request (**Adjudication**). On a pull request a human wrote, the human is the **Implementer**.
_Avoid_: coding agent, writer, author

**Adjudication**:
The **Implementer**'s answer to a posted review: it accepts or refutes each finding, and lands the accepted fixes.

**Re-checker**:
A fresh, read-only agent that checks an **Adjudication** against the code: each finding is fixed, validly refuted, or still open. It is never the **Implementer** or that round's **Orchestrator**.

**AFK run**:
A run of a skill that a T3 router task starts from a GitHub event, with no person at the keyboard. The router passes `--afk` and a lock token. The run asks no question: it decides each two-way decision itself and logs it (a build in the pull request body's "Decisions" section, an **Adjudication** in its ledger), and it pauses at a one-way door with a **Pause record**. In the **Review pipeline**, an AFK run is split into parts (`review`, `adjudicate`, `recheck`), each in a fresh thread, and a **Hand-off marker** starts the next part.
_Avoid_: unattended run, headless run

**Hand-off marker**:
The hidden line (`<!-- hero-forge:handoff kind=<kind> pr=<N> round=<R> -->`) that one part of an **AFK run** posts as the last line of its last comment, after it saves the run state and releases its lock. Anywhere else in a comment, the line is no hand-off. The comment's webhook wakes the next part through the other App's router: `review-posted` and `recheck-failed` start an **Adjudication**, and `adjudicated` starts a re-check. Only the helper CLI writes it: the CLI refuses agent text that holds one. It is not the **Review pipeline**'s own hidden marker (`hero-forge:review-pipeline`).
_Avoid_: trigger comment, done marker

**Pause record**:
The file that holds the one-way-door question of a paused **AFK run** until the maintainer answers it: one per paused issue or pull request, under the run state root. The run writes it before it posts the question, so only a reply at or after its `paused_at` is the answer. It also keeps the branch and the commit that the run pushed, and the decisions it logged, so that the resumed run starts from them. The maintainer's reply comment turns it into a resume, and the resumed run deletes it.

## Relationships

- An **Issue tracker** holds many **Issues**
- An **Issue** carries one **Triage role** at a time
- A **Decision ticket** is an **Issue** (a child of a `wayfinder:map`)
- An **Orchestrator** runs one or more **Reviewer pairs** per review round
- Each **Reviewer pair** is one **Standards** reviewer plus one **Spec** reviewer
- Every posted review is followed by **Adjudication** by the pull request's **Implementer**
- Round 1 is the posted review, its **Adjudication**, and one check by a **Re-checker**; each later round is an **Adjudication** of the findings still open plus a new check, with no new review, up to the repo's round limit
- A part of an **AFK run** in the **Review pipeline** that leaves work for the other App ends with one **Hand-off marker**, which starts the next part; a part that ends the run (a merge or a stop) posts none
- A **Hand-off marker** comes only from the helper CLI, after the run state is saved and the lock is released
- A **Pause record** blocks an **AFK run** until the maintainer replies on its issue or pull request

## Flagged ambiguities

- "backlog" was previously used to mean both the *tool* hosting issues and the *body of work* inside it. Resolved: the tool is the **Issue tracker**; "backlog" is no longer used as a domain term.
- "backlog backend" / "backlog manager". Resolved: collapsed into **Issue tracker**.
