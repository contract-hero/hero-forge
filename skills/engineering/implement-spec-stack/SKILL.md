---
name: implement-spec-stack
description: "Implement a spec as a stack of pull requests, one per ticket along the blocked_by graph: review each layer, review the whole stack once, then land it bottom-up."
disable-model-invocation: true
---

You have been provided a spec. This spec should have tickets associated with it, describing how to implement the spec.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`. This skill reads the tickets as GitHub sub-issues of the spec, and their order from GitHub's native `blocked_by` dependencies (`docs/agents/issue-tracker.md`, **Blocking**). On any other tracker, tell the user that this skill needs GitHub Issues, and stop.

The goal is every ticket of the spec on the default branch, each through its own reviewed pull request, after one final review of the whole stack against the spec.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

Each ticket becomes one **layer**: a branch and a draft PR. A layer branches from its **parent layer** (the ticket it waits on) and its PR targets the parent layer's branch, so the review of each layer sees only that ticket's diff. A ticket with no parent layer branches from the default branch. Layers do not merge until the final review of the whole stack passes.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec, tickets, the stack plan, research notes, and previous commits. Don't duplicate information already available via pointers.

**Implementer subagents** should be run in the background where possible for maximum concurrency.

## Helper CLI

The helper CLI lives in the `review-pipeline` skill folder, a sibling of the folder this SKILL.md is in. Below, `review.ts` means `node "<the folder this SKILL.md is in>/../review-pipeline/scripts/review.ts"`, run from the root of the worktree you are in. Its exit codes are the ones `review-pipeline` documents (0 success, 1 failed, 2 usage, 3 absent, 4 broken).

| Subcommand | Does |
| --- | --- |
| `stack order --repo O/R --spec N` | prints the stack plan as JSON: `layers` (parents first, each with `ticket`, `title`, `branch`, `parent`, `depth`, `blockers`, `children`), `rewired` and `excluded` |
| `stack path --spec N` | prints the stack dir, `<git common dir>/hero-pocock/stack-<N>/` |
| `stack restack --from <sha> --onto <ref>` | in a layer's worktree: rebases the checked-out layer onto `<ref>` from its parent's pre-landing tip, and passes only when `git range-diff` shows no content change; otherwise it puts the branch back |
| `stack merge-layer --repo O/R --pr N --base <default branch> --stack-pr S` | squash-merges a reviewed layer at its re-checked head, through the same gate as `review.ts merge`, and only once the `stack-final` run of the stack PR S is `complete` |

The plan follows two rules. A ticket with more than one open blocker branches from the deepest one. When two blockers are independent, the plan stacks one blocker's branch onto the other, and lists that edge in `rewired`. A ticket with an open blocker outside the spec is not ready: the plan lists it in `excluded`, with every ticket that waits on it.

## Steps

1. **Check the review config.** Run `review.ts config`. Exit 3 or 4: show the message, tell the user to run `/setup-review-pipeline`, and stop. Read the default branch (`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`) and `O/R`.

2. **Plan the stack.** Create the stack dir (`mkdir -p "$(review.ts stack path --spec <N>)"`). If `<stack dir>/order.json` exists, this is a resume: keep it and go to **Resume**. Do not plan again, because a landed ticket closes and would drop out of a new plan. Otherwise run `review.ts stack order --repo O/R --spec <N>` and save its output to `<stack dir>/order.json`.
   - Exit 1 on a cycle: show the message, which names the tickets in the cycle, and stop. Build nothing.
   - Exit 1 because no ticket is ready: show the message and stop.
   - Exit 0: show the user the stack as a tree of tickets, one line per `rewired` edge ("#Z now branches from #X so that #F has one base"), and each `excluded` ticket with its reason. Excluded tickets are not built in this run.

3. (optional) Use an **exploration subagent** to conduct any exploration required by the tickets - relevant codebase files or external documentation. Ensure the exploration subagent can save files - it should save its markdown notes in a directory outside the repo, accessible by all future subagents. This lets **implementer subagents** focus on implementation rather than exploration.

4. **Build the frontier.** A layer is ready when it has no parent, or when its parent layer's review is complete (step 5). Use **implementer subagents** to build every ready layer, each in its own worktree on its own branch. Give each one pointers to the spec, its ticket, and its entry in `order.json`. Each **implementer subagent**:
   - runs `review.ts config` and stops with the message on a non-zero exit;
   - fetches its base, `origin/<parent layer branch>` (the default branch for a layer with no parent), and creates the layer's `branch` from it. It confirms the worktree is based on it (`git merge-base --is-ancestor origin/<base> HEAD`), and resets onto it if not. An open PR on the branch is a re-run: it builds only what is missing and reuses that PR;
   - calls the Skill tool with `tdd` to build the ticket, runs the typecheck and the tests, commits, and pushes (`git push -u origin <branch>`);
   - calls the Skill tool with `pr` to write the body for `git diff origin/<base>...HEAD`, ending with `Closes #<ticket>` on its own line, saves it to a file outside the repo, and opens the draft PR: `gh pr create --draft --base <base> --head <branch> --title "<ticket title>" --body-file <file>`;
   - never calls `review-pipeline`, merges, or rebases. It reports the branch, the worktree path, the PR number, and the head SHA.

5. **Review each layer.** When an implementer reports, go to that layer's worktree and call the Skill tool with `review-pipeline`, with `<PR> --mode layer`. Run these reviews here, one at a time, never inside a subagent: the pipeline starts its own Orchestrator subagent. The review sees `git diff origin/<parent layer branch>...<head>`, only this layer's diff. In `layer` mode the pipeline ends after the ready flip (and, with the App, its approval), with no explainer and no merge. When the run is `complete` (`review.ts run-state read --pr <PR> phase`), the layer's children are ready: go back to step 4 for them. They branch from the reviewed tip, with its fixes.
   - If a layer run stops (the rounds ran out, the re-checker failed twice, or the App broke), start no new layers. Let the implementers in flight finish, then stop and ask the user, with the layer and the pipeline's message.

6. **Review the whole stack.** When every layer is `complete`:
   - Create the temporary stack branch `stack/spec-<N>` from `origin/<default branch>` in its own worktree. Merge each layer that has no children into it, in plan order (`git merge --no-ff origin/<branch>`). A merge conflict: stop and ask the user. Push it.
   - Call the Skill tool with `pr` to write the body for `git diff origin/<default branch>...HEAD`. Start it with `Spec: #<N>` on its own line, list the layer PRs, and say that this PR never merges: the layers land one by one, and this PR closes after. Add no `Closes` line. Open it: `gh pr create --draft --base <default branch> --head stack/spec-<N> --title "Stack: <spec title>" --body-file <file>`, and write its number to `<stack dir>/stack-pr`. Step 7 passes it to `merge-layer`.
   - From the stack worktree, call the Skill tool with `review-pipeline`, with `<stack PR> --mode stack-final`. Its Spec reviewers judge the whole stack against the spec. Its accepted fixes land on the layer each finding is about, and each changed layer is merged into the stack branch again. It builds the explainer, the only one of this run, and ends with the PR still a draft. The App never approves this PR: it never leaves draft and never merges, so its passing re-check is what the landing waits for.
   - If the run stops, stop and ask the user. Nothing has landed yet, so any layer can still change.

7. **Land the stack bottom-up**, only after the `stack-final` run is `complete`: `merge-layer` checks it, from the stack PR number in `<stack dir>/stack-pr`. Take the layers in `order.json` order (parents first). For each layer L with PR P:
   1. In L's worktree: `git fetch origin`, then `git merge --ff-only origin/<branch>`, so it has any fix from step 6.
   2. **Pin the head.** If `git rev-parse HEAD` differs from `review.ts run-state read --pr P head_sha`, run `review.ts run-state set --pr P head_sha <HEAD>`.
   3. **Approve the head again**, with the App only (the config has `app: enabled`). A restack or a stack fix moved the head, so the App's approval is on an old commit. Write `<run dir of P>/verdict-landing.json`: `{"event": "APPROVE", "body": "<body>", "comments": []}`. The body: `## Verdict: landing`, the head `<sha7>`, and the reason this head needs no new review: the stack PR #S passed its re-check, and the range-diff of the restack showed no content change (or: the new commits are the fixes the stack re-check graded). Then `review.ts post-review --repo O/R --pr P --commit <HEAD> --round <round> --kind verdict --payload <that file> --ledger <run dir of P>/findings.json --recheck <run dir of P>/recheck-r<round>.json`, where `<round>` is `review.ts run-state read --pr P round`. It posts at most once per head, and it records the gate result at the new head, which `merge-gate` needs. The layer's run is `complete`, which is the one phase after `ready` where an APPROVE is allowed.
   4. **Record the pre-landing tip.** Write `git rev-parse HEAD` to `<stack dir>/tip-<ticket>`. The children of L are rebased from this commit. Never overwrite the file after P merged.
   5. **Wait for the gate**: `review.ts merge-gate --repo O/R --pr P`, handled as `review-pipeline`'s **Finish** step 5 says (`go`, `wait`, `stop`, `merged`).
   6. **Merge**: `review.ts stack merge-layer --repo O/R --pr P --base <default branch> --stack-pr <S>`, where `<S>` is in `<stack dir>/stack-pr`. Never `review.ts merge`: it refuses a layer. Exit 1: stop and ask the user, with the message.
   7. **Move each child onto the default branch.** For each ticket C in L's `children`, in C's worktree: `git fetch origin`, `git merge --ff-only origin/<C branch>`, then `review.ts stack restack --from <tip-<L>> --onto origin/<default branch>`. It rebases only C's own commits, so no commit of L is duplicated after the squash merge. The tip can be past the point C branched from, when step 6 put a fix on L: restack handles that, because the commits after the tip are still only C's own.
      - Exit 0: `git push --force-with-lease=<C branch>:<old_tip> origin <C branch>`, then `gh pr edit <C PR> --base <default branch>`, then `review.ts run-state set --pr <C PR> head_sha <new_tip>`.
      - Exit 1 (a conflict or a content change): the branch is back at its old tip and nothing was pushed. Stop and ask the user, with the message.

   A layer whose parent landed earlier can be behind the default branch. That is fine for a squash merge, unless GitHub reports `BEHIND`: then `merge-gate` stops, and you ask the user.

8. **Close out.** Close the stack PR: `gh pr close <S> --comment "Landed as #<P1>, #<P2>, ..."`, then delete its branch: `git push origin --delete stack/spec-<N>`. Each merged layer closed its ticket. Comment on the spec with the landed PRs. If every sub-issue of the spec is closed, close the spec; otherwise leave it open. Report the layer PRs and their merge commits, the explainer path, the `rewired` edges, and the `excluded` tickets.

9. Clean up all **implementer subagent** worktrees, and the stack worktree.

## Resume

After an interrupted session, keep `<stack dir>/order.json` and read where each layer is on GitHub and in its run state:

| You find | Next step |
| --- | --- |
| a layer with no PR (`gh pr list --head <branch> --state all --json number,state`) | step 4 for it, when its parent is complete |
| a layer PR whose run is not `complete` | step 5: `review-pipeline` with `<PR> --mode layer` resumes the run |
| every layer `complete`, and no stack PR | step 6 |
| a stack PR whose run is not `complete` | step 6: `review-pipeline` with `<stack PR> --mode stack-final` resumes it |
| a merged layer PR | step 7.7 for each child whose PR still targets the merged layer's branch, using `<stack dir>/tip-<ticket>`; then the next layer |
| every layer merged | step 8 |
