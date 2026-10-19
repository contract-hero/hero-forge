hero-forge router for the <<app>> App. One GitHub webhook delivery came in. Route it and start at most one thread. Run only the steps below: no other command, no edits, no questions. Each exit is one line, as each step says.

Delivery id: `{{headers.x-github-delivery}}`. Event: `{{headers.x-github-event}}`. Repo: `{{body.repository.full_name}}`.

1. Check the three values. The delivery id holds only letters, digits and `-`. The event holds only `a-z` and `_`. The repo is empty, or `OWNER/REPO` with only letters, digits, `.`, `_` and `-`. Anything else: exit with `ignore: malformed headers`.
2. Find the helper CLI: `node -p 'require(process.env.HOME + "/.claude/plugins/installed_plugins.json").plugins["hero-forge@contract-hero"][0].installPath'`. Below, `review.ts` means `node "<that path>/skills/engineering/review-pipeline/scripts/review.ts"`. A failure: exit with `stop: hero-forge is not installed`.
3. Fetch the payload from GitHub: `review.ts delivery --app <<app>> --delivery <id> --out "${TMPDIR:-/tmp}/hero-forge-<id>.json"`. A non-zero exit: exit with `stop: <its message>`. It prints `{event, action, repo}`. Its `event` is not the event above, or its `repo` is not the repo above: exit with `ignore: the delivery does not match its headers`. Its `repo` is null: exit with `ignore: event <event> has no repository`.
4. Find the local clone of the repo, as a T3 project. List the projects with `t3_project_list` (every page). The clone is the project that is not deleted and whose `repositoryIdentity` names the repo, or whose `git -C <workspaceRoot> remote get-url origin` is the repo on github.com. No project: with `<name>` the part of the repo after the `/`, if `<<clone_root>>/<name>` is a clone whose origin is the repo, register it with `t3_project_create` (`workspaceRoot` that path, `title` `<name>`). Else clone it with `t3_project_clone` (`repository` the repo, `destinationPath` `<<clone_root>>/<name>`), then register it the same way. A path that holds something else: exit with `stop: <<clone_root>>/<name> is not a clone of <repo>`. A failure: exit with `stop: <the error>`.
5. In that project's `workspaceRoot`, run `review.ts route --app <<app>> --event <event> --delivery <id> --payload "${TMPDIR:-/tmp}/hero-forge-<id>.json"`. A non-zero exit: exit with `stop: <its message>`. It prints `{action, repo, pr, issue, reason, lock_token}`. `action` is `ignore`: exit with `ignore: <reason>`.
6. Pick the launch message, with `<n>` the `pr` or the `issue` of the decision, and its base:

   | action | message | base |
   | --- | --- | --- |
   | `review` | `/hero-forge:review-pipeline <pr> --afk review --lock <lock_token>` | the PR head |
   | `adjudicate` | `/hero-forge:review-pipeline <pr> --afk adjudicate --lock <lock_token>` | the PR head |
   | `recheck` | `/hero-forge:review-pipeline <pr> --afk recheck --lock <lock_token>` | the PR head |
   | `resume`, `pr` set | `/hero-forge:review-pipeline <pr> --afk adjudicate --resume --lock <lock_token>` | the PR head |
   | `build-ticket` | `/hero-forge:implement-pr <issue> --afk --lock <lock_token>` | the default branch |
   | `build-spec` | `/hero-forge:implement-spec-stack <issue> --afk --lock <lock_token>` | the default branch |
   | `resume`, `issue` set | `/hero-forge:implement-pr <issue> --afk --resume --lock <lock_token>`; `implement-spec-stack` in place of `implement-pr` when `gh api repos/<repo>/issues/<issue> --jq .sub_issues_summary.total` is more than 0 | the default branch |

   The PR head: `gh pr view <pr> --repo <repo> --json headRefName --jq .headRefName`. The default branch: `gh repo view <repo> --json defaultBranchRef --jq .defaultBranchRef.name`.
7. Launch one thread with `t3_thread_launch`: `projectId` the project of step 4, `title` `<<app>> <action> <repo>#<n>`, `workspaceStrategy` `{type: "worktree", baseRef: <base>, startFromOrigin: true}`, and `message` the message of step 6. Exit with `started: <action> <repo>#<n>`.
   The launch fails: release the lock, `review.ts lock release --pr <pr> --token <lock_token>` (or `--issue <issue>` when `pr` is null), in the `workspaceRoot`. Then exit with `stop: launch failed: <the error>`.
