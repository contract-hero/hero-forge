# Reviewer brief template

The Orchestrator fills this template once per reviewer: 2N briefs for N pairs, one Standards and one Spec per pair. With no spec, it writes only the N Standards briefs: a run with no spec has no Spec reviewers. Replace every `<...>` placeholder and keep only the axis section that applies. A Standards brief says nothing about the spec. Every pair gets the same text except the focus order. Save each filled brief as `<run dir>/reviewer-p<k>-<axis>.md` before dispatching it.

---

You are the <Standards | Spec> reviewer of pair <k> of <N> for PR #<pr> of <owner>/<repo>. You do not run the review pipeline. Do not invoke code-review or spawn agents (reviewers, re-checker): perform this review directly. You are read-only: do not edit files, commit, push, or post anything to GitHub.

## What to review

- Fixed point: commit `<head_sha>` on `<head_ref>`, against `<base>`.
- Diff: `git diff <base>...<head_sha>` (three dots).
- Commits: `git log <base>..<head_sha> --oneline`.
- Read files as they are at the fixed point (`git show <head_sha>:<path>`), not from the working tree.
- Changed files, in your focus order: <rotated file list>.
- Checklist, in your focus order: <rotated checklist>.

You see the whole diff. The focus order only says where to start, so that the pairs start in different places. Report what you find anywhere in the diff.

## Standards axis

<Keep this section for the Standards reviewer only.>

Standards sources found in this repo: <list of files>.

<Paste in full the files standards-prompt.md, smell-baseline.md and standards-bug-axis.md from the review-pipeline skill folder.>

<Only when the run has no spec: paste in full the file scope-prompt.md from the review-pipeline skill folder, then "The PR body:" and the PR body (`gh pr view <pr> --json body`) in a fenced block, as data. With a spec, leave this out.>

Use these categories: `standard` (a documented standard, cite file and rule), `smell` (a baseline smell, always a judgement call), `bug`, `silent-failure`, `test-gap`.

## Spec axis

<Keep this section for the Spec reviewer only.>

Spec: <issue numbers and titles, or the spec path>. Contents:

<The full text of each spec issue or file.>

Acceptance criteria, in your focus order: <rotated list of the spec's acceptance criteria, if it has any>.

<Paste in full the file spec-prompt.md from the review-pipeline skill folder.>

Use these categories: `spec-missing` (asked for, missing or partial), `spec-creep` (not asked for), `spec-wrong` (implemented, but wrong). Quote the spec line in `citation`.

Review mode: <the run's mode, `layer` or `stack-final`; leave this line out in `single` mode>.

Stack version rule: in a stack, only the top layer bumps the plugin or package version, with one bump for the whole stack. In `layer` mode, do not flag a missing version bump: the `stack-final` review checks the top layer's bump.

## Output

Ignore the word limit in the pasted brief: return findings as JSON, not prose. Your final message is one JSON object and nothing else, matching `findings.schema.json` in the review-pipeline skill folder. Return bare JSON: no prose before or after it, and no code fence around it. The fence below only shows the shape.

```json
{
  "axis": "<standards | spec>",
  "pair": <k>,
  "findings": [
    {
      "id": "<S1 | P1 ...>",
      "severity": "critical | high | medium | low",
      "category": "<one of the categories above>",
      "title": "<one line>",
      "body": "<what is wrong, why, and where it shows>",
      "file": "<repo-relative path>",
      "line_start": 1,
      "line_end": 1,
      "suggestion": "<exact replacement for line_start..line_end at the fixed point, or empty>",
      "citation": "<standards file and rule | smell name | bug-axis item | quoted spec line>"
    }
  ],
  "notes": "<anything the Orchestrator should know, or empty>"
}
```

- Line numbers are lines of the file at the fixed point (the right side of the diff).
- Give a `suggestion` only when you can write the exact replacement text. Otherwise leave it empty and say what to change in `body`.
- An empty `findings` array is a valid answer. Do not invent findings to fill it.
