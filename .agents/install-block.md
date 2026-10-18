# The canonical install block

One install story, one wording. `README.md` and `.changeset/*` must say **this** and nothing else. Change it here first, then propagate.

## One route: the Contract Hero marketplace

hero-forge ships for Claude Code only (see [ADR 0007](./adr/0007-hero-forge-is-a-hard-fork.md)). It installs from the Contract Hero marketplace, `contract-hero/plugin-marketplace`, as `hero-forge@contract-hero`. The marketplace reinstalls the plugin only when the `version` in `plugin.json` changes, so that field is bumped by hand. Never promise "instant".

## Claude Code

<canonical-block name="claude-code">

```bash
claude plugin marketplace add contract-hero/plugin-marketplace
claude plugin install hero-forge@contract-hero
```

Updates itself when the marketplace has auto-update on. If `mattpocock-skills` is also installed, uninstall it (`claude plugin uninstall mattpocock-skills`): both plugins ship the same skills.

</canonical-block>
