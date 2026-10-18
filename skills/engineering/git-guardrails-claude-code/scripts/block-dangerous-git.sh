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

# One space between words, and no git global options (-C <path>, -c <k=v>,
# --git-dir=..., --no-pager), so `git -C /tmp  push` reads as `git push`.
NORMALIZED=$(printf '%s' "$COMMAND" | tr '\t\n' '  ' | tr -s ' ' |
  sed -E 's/git( (-[Cc] [^ ]+|--[a-z-]+(=[^ ]+)?|-p|-P))+ /git /g')

# `[^;&|]*` keeps a match inside one command of a `&&` or `;` chain.
DANGEROUS_PATTERNS=(
  "git push"
  "git reset [^;&|]*--hard"
  "git clean [^;&|]*(-[a-zA-Z]*f|--force)"
  "git branch [^;&|]*(-[a-zA-Z]*D|--delete [^;&|]*--force|--force [^;&|]*--delete)"
  "git checkout \."
  "git restore \."
  "push --force"
  "reset --hard"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if printf '%s' "$NORMALIZED" | grep -qE "$pattern"; then
    block "'$COMMAND' matches dangerous pattern '$pattern'."
  fi
done

exit 0
