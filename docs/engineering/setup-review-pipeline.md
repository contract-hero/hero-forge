## What it does

`setup-review-pipeline` decides, once per repo, how pull requests get reviewed: which runtime runs the review, how many Reviewer pairs run per round, which model and effort each role uses, how many failed rounds the pipeline tries before it stops and asks, and whether a reviewer GitHub App posts the reviews. It writes the answers to `docs/agents/review.md` and adds a `### Review` entry to the `## Agent skills` block of `CLAUDE.md` or `AGENTS.md`.

One runtime runs every role. The Orchestrator and its reviewers are all Codex (`codex exec`) or all Claude [subagents](https://www.aihero.dev/ai-coding-dictionary/subagent), never a mix, because the pipeline dispatches every reviewer through the Orchestrator's own runtime. The skill finds out whether Codex is installed and recommends the matching defaults, so most runs need only a few confirmations.

## When to reach for it

You invoke this by typing `/setup-review-pipeline`, and the [agent](https://www.aihero.dev/ai-coding-dictionary/agent) won't reach for it on its own.

Reach for it once per repo, before the first pull request goes through [review-pipeline](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/review-pipeline.md). If `review-pipeline` stops and tells you to run setup, the repo has no `docs/agents/review.md` yet, or the file is broken. For the issue tracker, triage labels and domain docs instead, use [setup-matt-pocock-skills](https://aihero.dev/skills-setup-matt-pocock-skills).

## Prerequisites

| It needs | Why |
| --- | --- |
| Node 22.18 or newer | the helper CLI that checks the config is TypeScript run by Node, with no build step |
| The Codex CLI (optional) | with it, the recommended runtime is Codex; without it, Claude subagents |
| A reviewer GitHub App, already created and installed on the repo (optional) | with it, the reviews post as the App's bot and the App approves or requests changes; setup reads the App, it does not create one |

It writes into the repo you run it in:

| It writes | Where |
| --- | --- |
| `review.md`: a few lines of prose, then one YAML block | `docs/agents/` |
| A `### Review` entry | the `## Agent skills` block of whichever of `CLAUDE.md` or `AGENTS.md` already exists |
| The App credentials, only when you copy them from `/lfg` | `~/.config/hero-pocock/` on your machine, never the repo |

## One runtime, two roles

The config is a choice of runtime first, then numbers inside it. The runtime fixes the defaults:

| Runtime | Recommended when | Orchestrator | Reviewers |
| --- | --- | --- | --- |
| Codex | `codex --version` works | `gpt-6-astra`, low effort | `gpt-6.1-sol`, high effort |
| Claude subagents | Codex is not installed | `claude-opus-5-5`, medium effort | `claude-sonnet-5-5`, high effort |

Then it asks for the number of Reviewer pairs (default 2, each pair is one Standards and one Spec reviewer), whether to change the model or effort of either role, the round limit (default 2), and whether the reviewer App posts. It shows both drafts before it writes anything, and it runs the helper CLI's `config` check on the result.

Agents read only the YAML block. The prose above it is for you.

## Common questions

**Can the reviewers run on Codex and the Orchestrator on Claude?**

No. Setup offers one runtime for both roles, and the `config` check rejects a file that mixes them (for example `runtime: codex` with a `claude-` reviewer model). The Orchestrator dispatches the reviewers itself, so they must run where it runs.

**Does the review post as a bot?**

Only if you choose the reviewer App. The App's credentials live in `~/.config/hero-pocock/` (an env file and a private key), never in the repo. Setup checks that the App can post on this repo before it writes `app: enabled`, so a broken App never reaches the config. Without the App, every review posts from your own `gh` account as a COMMENT review, and the re-checker's verdict is the merge gate.

**I already use `/lfg`. Do I set the App up again?**

No. When `~/.config/lfg/reviewer-app.env` exists, setup offers to copy it. The helper CLI copies the private key and writes a new env file with this plugin's names, and it shows you only the two paths. It never overwrites credentials that are already in `~/.config/hero-pocock/` unless you say so.

**Can I edit `docs/agents/review.md` by hand?**

Yes. The YAML block is a small, strict subset: `KEY: value` lines, and `model` and `effort` indented two spaces under `orchestrator` and `reviewer`. Every `review-pipeline` run checks the block first and stops with the file, the line and the reason when something is wrong. Re-running setup also works, and it starts from the answers already in the file.

**The `### Review` entry disappeared from `CLAUDE.md`.**

A later `setup-matt-pocock-skills` run rewrites the `## Agent skills` block from its own template, which has no `### Review` entry. Run `/setup-review-pipeline` again: it replaces its own entry and never adds a second one.

## It's working if

- `docs/agents/review.md` exists, and its YAML block names one runtime and states every field.
- The `## Agent skills` block has one `### Review` entry, and a second setup run leaves it as one.
- The last thing setup shows you is a JSON summary of the config, with the models and efforts you chose, and with the App, its `<slug>[bot]` login.
- The next `review-pipeline` run starts its review without asking you how to review.

## Where it fits

`setup-review-pipeline` is a **run-once setup**, the precondition of [review-pipeline](https://github.com/contract-hero/hero-pocock/blob/main/docs/engineering/review-pipeline.md), which reads this config at the start of every run. It sits beside [setup-matt-pocock-skills](https://aihero.dev/skills-setup-matt-pocock-skills), which configures the issue tracker the pipeline's Spec reviewers read from. For which skill to reach for next, [ask-matt](https://aihero.dev/skills-ask-matt) routes the whole set.
