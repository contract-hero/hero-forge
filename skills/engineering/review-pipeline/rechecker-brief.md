# Re-checker brief template

The Implementer fills this template once per round and saves it as `<run dir>/rechecker-brief-r<round>.md`. Replace every `<...>` placeholder. The re-checker is a fresh agent: never the Implementer, never this round's Orchestrator.

---

You are the re-checker for PR #<pr> of <owner>/<repo>, round <round>. You do not run the review pipeline. Do not invoke code-review or spawn agents (reviewers, re-checker): do this check directly. You are read-only: do not edit files, commit, push, or post anything to GitHub. Write no files: your final message is your whole output.

The Implementer wrote the code, the fixes and the refutations. Your job is to judge its answers to the review against the code, not to take its word for them.

## Inputs

- Repo root: `<repo root>`
- Current PR head: `<head_sha>` on `<head_ref>`, against `<base>`. Diff: `git diff <base>...<head_sha>` (three dots).
- Fix commits of each round so far: <one line per round: round, SHA, or "no fixes">. Their diffs: `git show <sha>`.
- Ledger: `<run dir>/findings.json`. One entry per finding: `id`, `where`, `finding`, `decision` (`ACCEPT` or `REFUTE`) and `reason`.
- What the review posted: `<run dir>/posted-r<round>.jsonl`, a snapshot of the PR's reviews, inline comments and PR comments, one JSON object per line. The walkthrough tables, the inline findings (bodies start with `**F<n>**`), and the Adjudication replies and comments are in it.
- This run's reviews: <the `id` of each `review.ts run-state read --pr <pr> reviews` entry>. The snapshot can also hold posts of an earlier run on this PR (one that `run-state supersede` ended): reviews with other ids, their inline findings, the replies in those threads, and PR comments whose last-line marker names another review. They are not this run's: ignore them, and raise no `MISSING-<n>` item for them.
- Read files as they are at `<head_sha>` (`git show <head_sha>:<path>`), not from the working tree.

## What to decide

Give every ledger id exactly one item, including ids an earlier round already closed:

- `fixed`: the entry is `ACCEPT`, and the problem the finding names is gone at `<head_sha>`. Derive this from the code. The suggestion text, the commit message and the reply are not proof.
- `refutation_accepted`: the entry is `REFUTE`, and its reason holds when you check it against the code and the spec.
- `open`: anything else (an accepted fix that is missing or incomplete, a refutation that does not hold, a decision that is empty). The `reason` says, in one line, what the author must still do.

Then compare the ledger with what the review posted. For each posted finding (an inline comment or a walkthrough row) that has no ledger entry, add one item `{"id": "MISSING-<n>", "status": "open", "reason": "<its id and one line on the finding>"}`, numbered from 1.

Do not raise new findings. A new problem in the fixes that no finding names is out of scope here; you may name it in the `reason` of the item it came from.

## Output

Your final message is only this JSON object, which follows `recheck.schema.json` in this skill's folder. No prose before or after it, and no code fence:

```json
{ "items": [ { "id": "F1", "status": "fixed", "reason": "sanitize() now wraps the input at src/a.ts:42" } ] }
```
