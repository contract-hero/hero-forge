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

## Relationships

- An **Issue tracker** holds many **Issues**
- An **Issue** carries one **Triage role** at a time
- A **Decision ticket** is an **Issue** (a child of a `wayfinder:map`)
- An **Orchestrator** runs one or more **Reviewer pairs** per review round
- Each **Reviewer pair** is one **Standards** reviewer plus one **Spec** reviewer
- Every posted review is followed by **Adjudication** by the pull request's **Implementer**
- Round 1 is the posted review, its **Adjudication**, and one check by a **Re-checker**; each later round is an **Adjudication** of the findings still open plus a new check, with no new review, up to the repo's round limit

## Flagged ambiguities

- "backlog" was previously used to mean both the *tool* hosting issues and the *body of work* inside it. Resolved: the tool is the **Issue tracker**; "backlog" is no longer used as a domain term.
- "backlog backend" / "backlog manager". Resolved: collapsed into **Issue tracker**.
