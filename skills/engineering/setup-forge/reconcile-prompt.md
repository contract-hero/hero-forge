hero-forge hourly reconcile for <<repo>>. Start the work a missed webhook should have started: one thread per decision that is not `ignore`. Run only the steps below: no other command, no edits, no questions. End with one line, as the last step says.

1. Find the helper CLI: `node -p 'require(process.env.HOME + "/.claude/plugins/installed_plugins.json").plugins["hero-forge@contract-hero"][0].installPath'`. Below, `review.ts` means `node "<that path>/skills/engineering/review-pipeline/scripts/review.ts"`. A failure: exit with `stop: hero-forge is not installed`.
2. Find the local clone of <<repo>>, as a T3 project. List the projects with `t3_project_list` (every page). The clone is the project that is not deleted and whose `repositoryIdentity` names <<repo>>, or whose `git -C <workspaceRoot> remote get-url origin` is <<repo>> on github.com. No project: exit with `stop: no T3 project for <<repo>>` (the router registers or clones it on the next delivery).
3. In that project's `workspaceRoot`, run `review.ts reconcile --repo <<repo>>`. It prints zero or more lines, each one decision as JSON: `{action, repo, pr, issue, reason, lock_token, app}`. A non-zero exit before any line: exit with `stop: <its message>`. A non-zero exit after some lines: still start the lines it printed (they hold their locks), then say the message in the last line.
4. For each line whose `action` is not `ignore`, pick the launch message, with `<n>` the `pr` or the `issue` of the decision, and its base:

   | action | message | base |
   | --- | --- | --- |
   | `review` | `/hero-forge:review-pipeline <pr> --afk review --lock <lock_token>` | the PR head |
   | `adjudicate` | `/hero-forge:review-pipeline <pr> --afk adjudicate --lock <lock_token>` | the PR head |
   | `recheck` | `/hero-forge:review-pipeline <pr> --afk recheck --lock <lock_token>` | the PR head |
   | `resume`, `pr` set | `/hero-forge:review-pipeline <pr> --afk adjudicate --resume --lock <lock_token>` | the PR head |
   | `build-ticket` | `/hero-forge:implement-pr <issue> --afk --lock <lock_token>` | the default branch |
   | `build-spec` | `/hero-forge:implement-spec-stack <issue> --afk --lock <lock_token>` | the default branch |
   | `resume`, `issue` set | `/hero-forge:implement-pr <issue> --afk --resume --lock <lock_token>`; `implement-spec-stack` in place of `implement-pr` when `gh api repos/<<repo>>/issues/<issue> --jq .sub_issues_summary.total` is more than 0 | the default branch |

   The PR head: `gh pr view <pr> --repo <<repo>> --json headRefName --jq .headRefName`. The default branch: `gh repo view <<repo>> --json defaultBranchRef --jq .defaultBranchRef.name`.
5. Launch one thread per such line with `t3_thread_launch`: `projectId` the project of step 2, `title` `<app> <action> <<repo>>#<n>`, `workspaceStrategy` `{type: "worktree", baseRef: <base>, startFromOrigin: true}`, and `message` the message of step 4. A launch that fails: release its lock, `review.ts lock release --pr <pr> --token <lock_token>` (or `--issue <issue>` when `pr` is null), in the `workspaceRoot`, and count it as failed.
6. Exit with one line: `reconcile: started <count>, ignored <count>, failed <count>`, then the non-zero exit message of step 3, if any.
