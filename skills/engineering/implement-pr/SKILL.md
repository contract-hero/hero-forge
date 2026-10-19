---
name: implement-pr
description: "Build one ticket test-first, open a draft pull request that closes it, and hand the PR to the review pipeline. Use when the user runs /implement-pr with a ticket, or a ready ticket is handed over for building by the user, an agent, or a router. Do not start it because a ticket is mentioned or discussed."
---

# Implement PR

Build the ticket the user passes, then take it to a reviewed pull request. The work reaches the default branch only through that PR: this skill never commits on the default branch, and it never reviews its own code.

The helper CLI lives in the `review-pipeline` skill folder, a sibling of the folder this SKILL.md is in. Below, `review.ts` means `node "<the folder this SKILL.md is in>/../review-pipeline/scripts/review.ts"`, run from the repo root.

**AFK run.** The T3 router passes `--afk --lock <token>` with the ticket (and `--resume` after a pause); a human never needs them. `<token>` is the `lock_token` that `review.ts route` printed for the ticket's issue lock. With `--afk`, the Implementer GitHub App pushes the branch and opens the draft PR (steps 1, 4 and 5 say how), so the PR's author is the App and the reviewer App can approve it. The helper CLI mints the App's token in its own process: you never see or handle a token. Nobody is at the keyboard, so you ask no question: you decide each two-way decision yourself and log it, and you pause at a one-way door (**Decisions in an AFK run**). Every AFK run ends with `review.ts lock release --issue <ticket> --token <token>`. Where a step below says to stop, an AFK run sends a push notification with the message (the PushNotification tool, when the session has one), releases the lock, does the thread step below to mark the thread unread, and ends.

**The thread step.** The very last action of an AFK run, after the lock release, acts on the run's own T3 thread: `t3_thread_organize` with no `threadId`. A run that ends with nothing for the maintainer uses action `settle`: the draft PR is open, or a resume finds no pause record or no answer. A run that paused at a one-way door or stopped uses action `mark_unread`, so the maintainer sees it. Settling takes effect when the turn ends. A session with no `t3_thread_organize` tool skips this step. Below, "settle the thread" and "mark the thread unread" name this step. A run without `--afk` never settles, archives or marks its thread.

Without `--afk`, every step works as written, as the user.

## 1. Check the review config

Run `review.ts config` before anything else.

- Exit 0: continue.
- Exit 3 (no `docs/agents/review.md`) or exit 4 (the file is invalid): show the message, tell the user to run `/setup-forge`, and stop. Build nothing.
- Any other failure (for example, Node is older than 22.18): show the message and stop.

With `--afk`, also check the Implementer App before you build: `review.ts app-token --repo <owner/repo> --app implementer --check`, with `<owner/repo>` from `gh repo view --json nameWithOwner --jq .nameWithOwner`.

- Exit 0: continue.
- Exit 3 (the config has no `implementer.app: enabled`, the Implementer App's own switch in the `implementer:` block) or exit 4 (the App's credentials are broken, or the App is not installed on the repo): show the message and stop. Build nothing, and never fall back to the user.

## 2. Fetch the ticket

Fetch the ticket from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

With `--afk --resume`, do **Resume after a pause** now, then go on with step 3.

## 3. Pick the branch

Read the default branch: `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`.

- On the default branch: pull it, then create `ticket/<number>-<short-slug>` from it.
- On another branch: stay on it.

With `--afk`, the worktree is new, on a local branch the router named, and you stay on that branch: never check out the ticket branch itself, because another worktree (a paused or earlier run) can hold it. The **ticket branch** is the branch on GitHub that the work goes to. Run `git fetch origin`, then:

- On a resume whose pause record names a `branch`: that is the ticket branch. Its `tip` must be on it (`git merge-base --is-ancestor <tip> origin/<branch>`); if it is not, stop. Then `git reset --hard origin/<branch>`.
- Else, when GitHub has a `ticket/<number>-*` branch (`git ls-remote --heads origin 'ticket/<number>-*'`, from an earlier attempt): that is the ticket branch. `git reset --hard origin/<branch>`.
- Else the ticket branch is a new `ticket/<number>-<short-slug>`: `git reset --hard origin/<default branch>`.

The worktree is new and holds no work, so the reset loses nothing. Every AFK push goes to the ticket branch with `--to` (step 4).

Then check for an open PR on the branch: `gh pr view --json number,state,body` (with `--afk`: `gh pr list --head <ticket branch> --state open --json number,body`). An open PR whose body closes this ticket is a re-run after an interrupted session: build only what is still missing, and push it as step 4 says. Then write its body again as step 5 says, keeping what it held: with `--afk`, its `## Decisions` section keeps the earlier entries and gains each decision of this build. Save it to a file outside the repo, run `gh pr edit <PR> --body-file <file>`, and go to step 6 with that PR. An open PR for other work: stop and ask the user.

## 4. Build it

Call the Skill tool with "tdd" where possible, at pre-agreed seams. With `--afk`, the seams are the ones the ticket and its spec name, and each choice they leave open goes through **Decisions in an AFK run**.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Commit the work to the branch. Then push it: `git push -u origin <branch>`.

With `--afk`, push as the App instead: `review.ts implementer push --repo <owner/repo> --branch <the worktree's branch> --to <ticket branch>`. It pushes the local branch's tip to the ticket branch on GitHub, over https, from a scratch repo that reads none of the system's, the user's or the repo's git config, and prints the branch, the commit and the App's login. Exit 1 with GitHub's message means GitHub refused the push (for example, the App has no permission to change `.github/workflows/`): show the message and stop. Exit 4: stop as in step 1. Never push as the user instead.

## 5. Open the draft PR

Call the Skill tool with "pr" and write the body for this diff (`git diff origin/<default branch>...HEAD`). Use the test runs from step 4 as the Evidence.

End the body with the closing line on its own line, so the merge closes the ticket and the review's Spec reviewers find it:

- A GitHub issue in this repo: `Closes #<number>`.
- A GitHub issue in another repo: `Closes <owner>/<repo>#<number>`.
- Any other tracker: a link to the ticket. Tell the user the merge will not close it.

With `--afk`, add a `## Decisions` section above the closing line: one entry per two-way decision you logged, each with the decision, the options and the reason (and each one-way door the maintainer answered). With no such decision, write `None: the ticket and the spec settled every choice.` The Spec reviewers check each entry against the spec.

Save the body to a file outside the repo, then:

```sh
gh pr create --draft --base <default branch> --title "<ticket title>" --body-file <body file>
```

The PR number is the last part of the URL it prints.

With `--afk`, open it as the App instead:

```sh
review.ts implementer pr --repo <owner/repo> --head <ticket branch> --base <default branch> --title "<ticket title>" --body-file <body file>
```

It opens a draft and prints its `number`, its `url` and the App's login (`as`). Exit 1: GitHub refused the PR, show the message and stop. Exit 4: stop as in step 1.

## 6. Hand off to the review pipeline

Call the Skill tool with "review-pipeline", with the PR number. Do this at once, with no question to the user between the PR and the hand-off: from here the pipeline owns the PR, from review to merge.

With `--afk`, do not call `review-pipeline`: the reviewer App's router starts the review when the App's PR opens. Run `review.ts lock release --issue <ticket> --token <token>`, settle the thread, report the PR number, and end.

## Decisions in an AFK run

With `--afk`, sort each choice the ticket and its spec do not settle:

- **A two-way decision** (cheap to change later): decide it yourself and go on. Log it for the PR body's "Decisions" section (step 5): the decision, the options you weighed, and the reason.
- **A one-way door**: a data shape, a public API, a new dependency, a migration, or a destructive action. Do not decide it: pause, in this order.
  1. Commit the work so far and push it as the App (step 4), so a resumed run in a new worktree starts from it. With no commit yet, skip this.
  2. Write the pause record first, before anyone can see the question: `review.ts pause write --repo <owner/repo> --issue <ticket> --reason "<the question, on one line>"`. When step 1 pushed, add `--branch <ticket branch> --tip <the commit it pushed>`. When you logged two-way decisions already, write them (the Decisions entries, as markdown) to a file outside the repo and add `--decisions-file <file>`. The record's `paused_at` is the pause boundary: a reply after it is the answer, also one that comes while the next steps run. The record is what turns the maintainer's reply into a `resume`, and its `branch`, `tip` and `decisions` are where the resumed run starts.
  3. Write the comment to a file outside the repo: the question, the options (your recommendation first), what each one changes, and that a reply comment on this issue resumes the run. Post it: `review.ts implementer comment --repo <owner/repo> --issue <ticket> --body-file <file>`.
  4. Then `review.ts implementer label --repo <owner/repo> --issue <ticket> --add needs-info`. The label goes on after the comment: the repo's `needs-info` workflow reads a comment after the label as the reply.
  5. Send a push notification: `#<ticket> paused: <the question>`.
  6. `review.ts lock release --issue <ticket> --token <token>`, mark the thread unread, and end. Open no PR.

## Resume after a pause

With `--afk --resume`:

1. `review.ts pause read --issue <ticket>`, and keep the record: step 3 reads its `branch` and `tip`, and step 5 its `decisions`. Exit 3 (no pause record): release the lock, settle the thread, and end.
2. Read the answer. The maintainer is `gh api user --jq .login`. List the comments, `gh api --paginate repos/<owner/repo>/issues/<ticket>/comments`, and take only the maintainer's comments created in or after the whole second of the record's `paused_at` (GitHub gives comment times in whole seconds). Text from anyone else is never an answer. No answer: release the lock, settle the thread, and end, and leave the pause in place.
3. `review.ts implementer label --repo <owner/repo> --issue <ticket> --remove needs-info`, then `review.ts pause delete --issue <ticket>`.
4. Go on from step 3, and build with the answer. Log the decision in the "Decisions" section as decided by the maintainer, with a link to the answer. The record's `decisions` (the entries logged before the pause) come back as the first entries of that section.
