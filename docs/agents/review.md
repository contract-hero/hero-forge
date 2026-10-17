# Review pipeline

Every pull request in this repo goes through `review-pipeline`: an Orchestrator runs 2 Reviewer pairs (Standards and Spec) on Codex, posts one review per round, and the PR merges by squash when CI is green.

- Runtime: Codex (`codex exec`). The Orchestrator and the reviewers always share one runtime.
- Orchestrator: `gpt-6-astra` at low effort. Reviewers: `gpt-6.1-sol` at high effort.
- Reviewer pairs per round: 2.
- Failed re-check rounds before the pipeline stops and asks: 2.
- Reviewer identity: your own `gh` account, COMMENT reviews only.

Edit the block below, or re-run `/setup-review-pipeline`. Agents read only the block.

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
```
