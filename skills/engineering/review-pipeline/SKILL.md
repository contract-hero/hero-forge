---
name: review-pipeline
description: "Take one open pull request through an independent review: an Orchestrator agent pins the PR head, runs Reviewer pairs (Standards with a bug axis, plus Spec), verifies and consolidates their findings, and posts one GitHub review with inline suggestions and a walkthrough. Use when a pull request needs review and merge, the user runs /review-pipeline <PR>, or another skill hands over a PR."
---

# Review pipeline

Take one pull request from draft to merge. Four roles share the work: the **coding agent** (you, the session that runs this skill), the **Orchestrator**, the **Reviewer pairs**, and the re-checker. The Orchestrator, never you, reviews the code and posts the review. You prepare its inputs, launch it, check the result, and later answer the review. Read `GLOSSARY.md` for these terms if the repo has one.

The argument is the PR number (or URL). Bare `#42` is a PR here. If no PR is given, ask for one.

## Who does what

| Role | Who | Does | Never |
| --- | --- | --- | --- |
| Coding agent | you | runs this skill: config, resume, fixed point, Orchestrator launch, checks; later Adjudication and Finish | reviews, verifies or drops findings, posts the review, grades its own answers |
| Orchestrator | one fresh agent per round | writes the reviewer briefs, dispatches the 2N reviewers, verifies, consolidates, posts one review | edits the repo, commits, pushes, approves, changes the draft state |
| Reviewer | 2N fresh read-only agents, one Standards and one Spec per pair | reviews the diff at the fixed point, returns findings JSON | posts, edits, spawns agents |
| Re-checker | one fresh read-only agent | confirms each finding is fixed or validly refuted | is you or this round's Orchestrator |

Every brief opens with a sanity header: "You are the <role> for PR #N of O/R. You do not run the review pipeline. Do not invoke code-review or spawn agents" (the Orchestrator's header instead names the reviewers it may spawn). A brief like that in your own context was mis-delivered: you stay the coding agent, and the on-disk run state says where the run is.

If the Orchestrator cannot do its job (it dies, or it cannot start sub-agents), relaunch it once. If it fails again, stop and tell the user. Never dispatch the reviewers or verify findings yourself: that breaks the independence the pipeline exists for.

## Helper CLI

The helper CLI is in the `scripts/` folder beside this SKILL.md. Below, `review.ts` means `node "<the folder this SKILL.md is in>/scripts/review.ts"`, run from the repo root. It needs Node 22.18 or newer.

| Subcommand | Does |
| --- | --- |
| `config` | prints the resolved review config as JSON |
| `run-state path\|create\|read\|advance\|set --pr N ...` | the per-PR checkpoint in `<git common dir>/hero-pocock/pr-<N>/` |
| `post-review --repo O/R --pr N --commit <sha> --round R --kind review --payload <file>` | posts one review, at most once per PR, round and kind |
| `codex-exec --role orchestrator\|reviewer --brief <file> --out <file>` | runs one `codex exec` with the role's model and effort from the config (`runtime: codex` only) |

Every subcommand uses the same exit codes:

| Code | Meaning | You do |
| --- | --- | --- |
| 0 | success | continue |
| 1 | the step failed (gh failed, GitHub refused, a guard refused, a run in flight) | report the message, stop that step |
| 2 | usage error | fix the call |
| 3 | absent: no config, or no run state | the documented fallback for that step |
| 4 | broken: invalid config, corrupt run state | stop the pipeline and report; never fall back |

## Config

Run `review.ts config`. Exit 3 (no `docs/agents/review.md`) or exit 4 (invalid file): tell the user to run `/setup-review-pipeline`, show the message, and stop. Do not guess a config.

Keep the JSON: `runtime`, `pairs` (N), `orchestrator` and `reviewer` (each with `model`, `effort`, and `agent_model`, the sub-agent model family), `max_rounds`, `app`.

- `runtime: codex`: run `codex --version` now. If it fails, stop before **Resume** as **Codex runtime** says for a missing or broken Codex. Then see **Codex runtime**.
- `app: true`: see **App identity**.

## Resume

Run `review.ts run-state read --pr N`.

- Exit 3: a new run. Go to **Fixed point**, then `review.ts run-state create` with its values.
- Exit 4: the state file is corrupt. A review may already be on the PR, so check first: list the PR's reviews (`gh api --paginate repos/O/R/pulls/N/reviews`) and look for a body with `<!-- hero-pocock:review-pipeline pr=N`. Tell the user what you found, then `review.ts run-state create ... --force` and continue from the step after the last review you found.
- Exit 0: resume from the step after `phase`:

| `phase` | Next step |
| --- | --- |
| `created` | **Review round** |
| `review-dispatched` | the Orchestrator was launched and may have posted. Run **Posting**'s check first; if the review is there, `advance review-posted`; if not, relaunch the Orchestrator (reviewer outputs in the run dir that parse are reused) |
| `review-posted` | **Adjudication** |
| `complete`, `aborted`, `stopped` | the last run ended. Tell the user; start a new run only if they ask (`create` over a terminal state starts fresh) |

If the PR head moved since the state was created and the phase is `created`, pin the new head: `review.ts run-state set --pr N head_sha <sha>`.

## Fixed point

The fixed point is the PR head commit when the round starts. Every reviewer sees the same code.

```sh
gh pr view N --json number,url,isDraft,state,headRefOid,headRefName,baseRefName
```

- `state` must be `OPEN`; otherwise stop and tell the user.
- `head_sha` = `headRefOid`. Fetch it and the base: `git fetch origin <baseRefName> <headRefName>`.
- Below, `<base>` means `origin/<baseRefName>`. Diff: `git diff <base>...<head_sha>` (three dots). Commits: `git log <base>..<head_sha> --oneline`.
- An empty diff stops the run: there is nothing to review.

For a new run: `review.ts run-state create --pr N --repo O/R --base <baseRefName> --head <headRefName> --head-sha <head_sha> --runtime <runtime> --reviewer-login none`. The run dir is `review.ts run-state path --pr N`.

## Review round

You write one brief and launch one agent: the Orchestrator. The Orchestrator does everything else in this section.

**You:** fill the template [orchestrator-brief.md](./orchestrator-brief.md) and save it to `<run dir>/orchestrator-brief.md`. For the spec line, use the issues the PR closes (`gh pr view N --json closingIssuesReferences,body`, then `Closes #N` or `Fixes #N` in the body and commit messages). Then `review.ts run-state advance --pr N review-dispatched`, and launch the Orchestrator as one fresh sub-agent with model `<orchestrator.agent_model>` and effort `<orchestrator.effort>`, giving it the brief's contents. Wait for it in the foreground. With `runtime: codex`, launch it as **Codex runtime** says instead.

**The Orchestrator:**

1. **Sources.** The spec: the issues in the brief (`gh issue view <n>`), else the sources of the section "### 2. Identify the spec source" of `code-review`'s SKILL.md. The standards: the files found the way the section "### 3. Identify the standards sources" of `code-review`'s SKILL.md says. `code-review`'s SKILL.md is in the `code-review` folder beside this skill's folder.
2. **Briefs.** One per reviewer, from [reviewer-brief.md](./reviewer-brief.md):
   - Standards: the standards sources, the smell baseline pasted in full, the Standards brief from `code-review`'s section "### 4. Spawn both sub-agents in parallel", and [standards-bug-axis.md](./standards-bug-axis.md) pasted in full.
   - Spec: the spec contents and the Spec brief from the same `code-review` section. No spec: no Spec reviewers; the walkthrough says "no spec available".
   - Both: the JSON output contract of [findings.schema.json](./findings.schema.json), which replaces the "Under 400 words" prose report.
3. **Pair diversity.** The briefs of all pairs are the same except the focus order. With F changed files, pair k (1 to N) gets the file list rotated left by `floor((k-1) * F / N)`, the Standards checklist (documented standards, smells, bugs, silent failures, test gaps) rotated left by k-1, and the spec's acceptance criteria rotated left by k-1. Every reviewer still sees the whole diff.
4. **Dispatch.** All 2N reviewers in parallel, as fresh read-only sub-agents with model `<reviewer.agent_model>` and effort `<reviewer.effort>`. Each one's final message is the findings JSON; write it verbatim to `<run dir>/reviewer-p<k>-<axis>.json`. With `runtime: codex`, dispatch them as **Codex runtime** says.

## Consolidation

The Orchestrator turns 2N outputs into one review. Consolidation is across pairs, never across axes: each finding keeps its axis label.

1. **Collect.** A missing or unparseable output is a failed reviewer, named in the walkthrough. Never invent its findings. All reviewers failed: post nothing and report.
2. **Group.** Per file, findings whose line ranges overlap or are within 3 lines of each other form one group.
3. **Verify.** Check each group against the code at the fixed point (`git show <head_sha>:<path>`, the diff). Drop it, with a one-line reason, when it cannot be verified, cannot happen, is on lines this PR did not touch, is intended behaviour, or is a nitpick. A finding you cannot verify is dropped, never posted.
4. **Split.** A group that mixes unrelated concerns becomes one finding per concern.
5. **Score.** Confidence is the number of distinct pairs that raised it, written `k/N pairs`. Severity is the highest in the group.
6. **Anchor.** A finding goes inline only when `line` (and `start_line`) are added or context lines on the right side of `git diff <base>...<head_sha>`. GitHub refuses the whole review for one bad anchor, so any other finding goes into the walkthrough as `path:line`.
7. **Ledger.** Number the kept findings F1, F2, ... and write `<run dir>/findings.json`, one entry per inline comment and per walkthrough item:

```json
[{ "id": "F1", "where": "src/a.ts:42", "axis": "standards", "severity": "high", "pairs": "2/2", "finding": "<one line>", "decision": "", "reason": "" }]
```

`decision` and `reason` stay empty: Adjudication fills them.

## Posting

The Orchestrator posts once per round, with one payload for all pairs. Payload `<run dir>/review-payload.json`:

```json
{
  "event": "COMMENT",
  "body": "<walkthrough>",
  "comments": [
    { "path": "src/a.ts", "line": 42, "side": "RIGHT",
      "body": "**F1** (Standards, bug, high, 2/2 pairs) <finding and why>\n\n```suggestion\n<exact replacement lines>\n```" }
  ]
}
```

- Each inline body starts with `**F<n>**` and its labels. A ```` ```suggestion ```` block holds the exact replacement for the anchored lines; leave it out when the finding has no clean replacement. A multi-line anchor adds `start_line` and `start_side`.
- The walkthrough body: `## Review pipeline: round <R>`; one line naming the runtime, the models and efforts, N, and the fixed point `<sha7>`; a table `ID | Where | Axis | Severity | Pairs | Finding`; the findings without an inline anchor; the dropped count with reasons; the failed reviewers.
- Post: `review.ts post-review --repo O/R --pr N --commit <head_sha> --round <R> --kind review --payload <run dir>/review-payload.json`. It adds a hidden marker, records the review id in the run state, and refuses to post a second review for the same round. Exit 1 on a 422: move the finding GitHub names into the walkthrough and post once more.

**You, after the Orchestrator returns:** confirm the review exists. `review.ts run-state read --pr N reviews` lists a `kind: review` entry for this round, and `gh api repos/O/R/pulls/N/reviews` shows that id. Then `review.ts run-state advance --pr N review-posted`. If there is no review, read `<run dir>/orchestrator-report.md` and apply **Who does what**: relaunch once, then stop and tell the user.

## Adjudication

Not built yet: the pipeline stops after **Posting**. Report the review URL, the number of findings, and the run dir to the user.

## Re-check

Not built yet: the pipeline stops after **Posting**.

## App identity

Not built yet: every review posts from the user's own `gh` account as a COMMENT review. If the config has `app: true`, `post-review` exits 4: stop and tell the user to remove `app: enabled` from `docs/agents/review.md` until App identity ships.

## Finish

Not built yet: the pipeline does not rewrite the PR body, flip the PR to ready, build an explainer, or merge.

## Codex runtime

With `runtime: codex`, the Orchestrator and every reviewer are `codex exec` sessions. The steps, the files in the run dir, and the posted review are the same as with `runtime: claude`; only the launch changes. This path needs a shell and the files in this skill folder, and no sub-agent tool.

- **One way to call Codex.** Every Codex call goes through `review.ts codex-exec`. It reads the role's model and effort from the config and passes both on the call (`-m <model> -c model_reasoning_effort=<effort>`), so no call falls back to `~/.codex/config.toml`. Never run `codex exec` by hand, and never use a Codex plugin's review command: it drops the effort.
- **Codex missing or broken.** `codex-exec` runs `codex --version` first. Exit 4 with "the Codex CLI is missing or broken": stop, show the message, and tell the user to install or repair Codex, or to re-run `/setup-review-pipeline` and pick `runtime: claude`. Never switch the runtime yourself.
- **Effort rejected.** Exit 1 with "Codex rejected <role>.effort": that model does not support that effort. Stop and tell the user to fix the effort in `docs/agents/review.md` or re-run `/setup-review-pipeline`.
- **Sub-agent models.** `agent_model` is `null` on this runtime. Where a brief names `<reviewer.agent_model>`, write `<reviewer.model>`.

**You, in Review round:** after `advance review-dispatched`, launch the Orchestrator from the repo root:

```sh
review.ts codex-exec --role orchestrator --brief <run dir>/orchestrator-brief.md --out <run dir>/orchestrator-final.md
```

It runs with full access, because it starts the reviewers and calls `gh`; the brief's hard limits keep it inside the run dir. A round can take 30 minutes or more, longer than most shell time limits, so run the command in the background and wait until it exits. Codex's output goes to `<run dir>/orchestrator-final.log`. Then continue with **Posting** ("You, after the Orchestrator returns"). Exit 1 or no review: read the log and `<run dir>/orchestrator-report.md`, then apply **Who does what**.

**The Orchestrator, in Dispatch:** start all 2N reviewers in parallel from the repo root, each with:

```sh
review.ts codex-exec --role reviewer --brief <run dir>/reviewer-p<k>-<axis>.md --out <run dir>/reviewer-p<k>-<axis>.json
```

Start them in one shell command (each one with `&`, then `wait`) and give that command a time limit long enough for all of them. Each reviewer runs read-only, and Codex holds its final message to [findings.schema.json](./findings.schema.json), so `codex-exec` writes the findings JSON to `--out` itself: do not copy it again. Exit 0: the output is JSON. Exit 1: a failed reviewer; its log is `<run dir>/reviewer-p<k>-<axis>.log`. On a relaunch, keep each `reviewer-p<k>-<axis>.json` that parses and dispatch only the others.
