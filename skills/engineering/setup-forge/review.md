# Review pipeline

Every pull request in this repo goes through `review-pipeline`: an Orchestrator runs <N> Reviewer pairs (Standards and Spec) on <runtime>, posts one review per round, and the PR merges by squash when CI is green.

- Runtime: <Codex (`codex exec`) | Claude sub-agents>. The Orchestrator and the reviewers always share one runtime.
- Orchestrator: `<orchestrator model>` at <orchestrator effort> effort. Reviewers: `<reviewer model>` at <reviewer effort> effort.
- Reviewer pairs per round: <N>.
- Failed re-check rounds before the pipeline stops and asks: <max_rounds>.
- Reviewer identity: <the reviewer GitHub App, which also approves the PR or requests changes (credentials in `~/.config/hero-forge/`, never in this repo) | your own `gh` account, COMMENT reviews only>.
- AFK mode: on. GitHub events start the runs through T3 Code: the Implementer App builds each `ready-for-agent` ticket and answers the reviews, and the reviewer App reviews and merges. Each App runs at most 20 times in 24 hours, and a ticket gets 3 builds. `paused: true` stops both Apps.   <only with AFK mode; leave the line out without it>

Edit the block below, or re-run `/setup-forge`. Agents read only the block.

```yaml
runtime: <codex | claude>
pairs: <N>
orchestrator:
  model: <orchestrator model>
  effort: <orchestrator effort>
reviewer:
  model: <reviewer model>
  effort: <reviewer effort>
max_rounds: <max_rounds>
app: enabled   <only with the reviewer App; leave the line out without it>
paused: false            <this line and the five below only with AFK mode; leave them out without it>
app_daily_runs: 20
implementer:
  app: enabled
  attempts: 3
  daily_runs: 20
```
