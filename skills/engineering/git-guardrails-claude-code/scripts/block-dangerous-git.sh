#!/bin/bash

block() {
  echo "BLOCKED: $1 The user has prevented you from doing this." >&2
  exit 2
}

# Fail closed: a command we cannot read is a command we cannot check.
command -v jq >/dev/null 2>&1 || block "jq is not installed, so the git guardrail cannot read the command."
INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) ||
  block "the git guardrail cannot parse the tool input."

# One space between words, and no git global options, so
# `git -C "/tmp/a b"  push` reads as `git push`. An option value may be
# joined (-C/tmp), separate, or quoted.
VALUE="(\"[^\"]*\"|'[^']*'|[^ ]+)"
GLOBAL="-[Cc] ?$VALUE|--(git-dir|work-tree|namespace|super-prefix|exec-path|config-env) $VALUE|--[a-z-]+(=$VALUE)?|-p|-P"
NORMALIZED=$(printf '%s' "$COMMAND" | tr '\t\n' '  ' | tr -s ' ' | sed -E "s/git( ($GLOBAL))+ /git /g")

# `[^;&|]*` keeps a match inside one command of a `&&` or `;` chain. Git takes
# a long option by any unique prefix, so `--ha` is `--hard`.
ARGS="( [^;&|]*)?"
DANGEROUS_PATTERNS=(
  "git push"
  "git reset$ARGS --ha"
  "git clean$ARGS (-[a-zA-Z]*f|--force)"
  "git branch$ARGS -[a-zA-Z]*D"
  "git branch$ARGS -[a-zA-Z]*(d[a-zA-Z]*f|f[a-zA-Z]*d)"
  "git branch$ARGS (-d|--delete)$ARGS (-f|--force)"
  "git branch$ARGS (-f|--force)$ARGS (-d|--delete)"
  "git checkout \\."
  "git restore \\."
  "push --force"
  "reset --hard"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if printf '%s' "$NORMALIZED" | grep -qE "$pattern"; then
    block "'$COMMAND' matches dangerous pattern '$pattern'."
  fi
done

exit 0
