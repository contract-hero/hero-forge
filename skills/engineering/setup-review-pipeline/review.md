# Review pipeline

Every pull request in this repo goes through `review-pipeline`: an Orchestrator runs <N> Reviewer pairs (Standards and Spec) on <runtime>, posts one review per round, and the PR merges by squash when CI is green.

- Runtime: <Codex (`codex exec`) | Claude sub-agents>. The Orchestrator and the reviewers always share one runtime.
- Orchestrator: `<orchestrator model>` at <orchestrator effort> effort. Reviewers: `<reviewer model>` at <reviewer effort> effort.
- Reviewer pairs per round: <N>.
- Failed re-check rounds before the pipeline stops and asks: <max_rounds>.
- Reviewer identity: <the reviewer GitHub App, which also approves the PR or requests changes (credentials in `~/.config/hero-pocock/`, never in this repo) | your own `gh` account, COMMENT reviews only>.

Edit the block below, or re-run `/setup-review-pipeline`. Agents read only the block.

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
```
