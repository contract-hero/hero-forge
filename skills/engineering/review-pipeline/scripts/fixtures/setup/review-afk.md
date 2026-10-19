# Review pipeline

Every pull request in this repo goes through `review-pipeline`: an Orchestrator runs 2 Reviewer pairs (Standards and Spec) on Codex (`codex exec`), posts one review per round, and the PR merges by squash when CI is green.

- Runtime: Codex (`codex exec`). The Orchestrator and the reviewers always share one runtime.
- Orchestrator: `gpt-6-astra` at low effort. Reviewers: `gpt-6.1-sol` at high effort.
- Reviewer pairs per round: 2.
- Failed re-check rounds before the pipeline stops and asks: 2.
- Reviewer identity: the reviewer GitHub App, which also approves the PR or requests changes (credentials in `~/.config/hero-forge/`, never in this repo).
- AFK mode: on. GitHub events start the runs through T3 Code: the Implementer App builds each `ready-for-agent` ticket and answers the reviews, and the reviewer App reviews and merges. Each App runs at most 20 times in 24 hours, and a ticket gets 3 builds. `paused: true` stops both Apps.

Edit the block below, or re-run `/setup-forge`. Agents read only the block.

```yaml
runtime: codex
pairs: 2
orchestrator:
  model: gpt-6-astra
  effort: low
reviewer:
  model: gpt-6.1-sol
  effort: high
max_rounds: 2
app: enabled
paused: false
app_daily_runs: 20
implementer:
  app: enabled
  attempts: 3
  daily_runs: 20
```
