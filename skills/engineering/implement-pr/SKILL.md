---
name: implement-pr
description: "Build one ticket test-first, open a draft pull request that closes it, and hand the PR to the review pipeline. Use when the user runs /implement-pr with a ticket, or a ready ticket is handed over for building by the user, an agent, or a router. Do not start it because a ticket is mentioned or discussed."
---

# Implement PR

Build the ticket the user passes, then take it to a reviewed pull request. The work reaches the default branch only through that PR: this skill never commits on the default branch, and it never reviews its own code.

The helper CLI lives in the `review-pipeline` skill folder, a sibling of the folder this SKILL.md is in. Below, `review.ts` means `node "<the folder this SKILL.md is in>/../review-pipeline/scripts/review.ts"`, run from the repo root.

## 1. Check the review config

Run `review.ts config` before anything else.

- Exit 0: continue.
- Exit 3 (no `docs/agents/review.md`) or exit 4 (the file is invalid): show the message, tell the user to run `/setup-forge`, and stop. Build nothing.
- Any other failure (for example, Node is older than 22.18): show the message and stop.

## 2. Fetch the ticket

Fetch the ticket from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

## 3. Pick the branch

Read the default branch: `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`.

- On the default branch: pull it, then create `ticket/<number>-<short-slug>` from it.
- On another branch: stay on it.

Then check for an open PR on the branch: `gh pr view --json number,state,body`. An open PR whose body closes this ticket is a re-run after an interrupted session: build only what is still missing, push it, and go to step 6 with that PR. An open PR for other work: stop and ask the user.

## 4. Build it

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Commit the work to the branch. Then push it: `git push -u origin <branch>`.

## 5. Open the draft PR

Call the Skill tool with "pr" and write the body for this diff (`git diff origin/<default branch>...HEAD`). Use the test runs from step 4 as the Evidence.

End the body with the closing line on its own line, so the merge closes the ticket and the review's Spec reviewers find it:

- A GitHub issue in this repo: `Closes #<number>`.
- A GitHub issue in another repo: `Closes <owner>/<repo>#<number>`.
- Any other tracker: a link to the ticket. Tell the user the merge will not close it.

Save the body to a file outside the repo, then:

```sh
gh pr create --draft --base <default branch> --title "<ticket title>" --body-file <body file>
```

The PR number is the last part of the URL it prints.

## 6. Hand off to the review pipeline

Call the Skill tool with "review-pipeline", with the PR number. Do this at once, with no question to the user between the PR and the hand-off: from here the pipeline owns the PR, from review to merge.
