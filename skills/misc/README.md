# Misc

Tools I keep around but rarely use, not promoted in the plugin.

- **[git-guardrails-claude-code](./git-guardrails-claude-code/SKILL.md)**: Set up Claude Code hooks to block dangerous git commands (push, reset --hard, clean, etc.) before they execute.
- **[implement](./implement/SKILL.md)**: Upstream's build step. Builds a spec or a set of tickets with `/tdd`, reviews it with `/code-review` in the same session, and commits to the current branch. The plugin ships `implement-pr` in its place.
- **[implement-spec](./implement-spec/SKILL.md)**: Upstream's whole-spec build. Works the tickets as a task graph on one integration branch, then closes out with `/code-review`. The plugin ships `implement-spec-stack` in its place.
- **[migrate-to-shoehorn](./migrate-to-shoehorn/SKILL.md)**: Migrate test files from `as` type assertions to @total-typescript/shoehorn.
- **[scaffold-exercises](./scaffold-exercises/SKILL.md)**: Create exercise directory structures with sections, problems, solutions, and explainers.
- **[setup-pre-commit](./setup-pre-commit/SKILL.md)**: Set up Husky pre-commit hooks with lint-staged, Prettier, type checking, and tests.
