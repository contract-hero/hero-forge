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
ONE_LINE=$(printf '%s' "$COMMAND" | tr '\t\n' '  ' | tr -s ' ')

# The shell drops quotes and backslashes before git reads its arguments, so
# `git "reset" \--hard` is `git reset --hard`.
unquote() { tr -d "\"'\\\\" | tr -s ' '; }

# `[^;&|]*` keeps a match inside one command of a `&&` or `;` chain.
ARGS="( [^;&|]*)?"

# An alias defined inline (`git -c alias.p=push p`) can run any blocked
# command under a name no pattern knows.
if printf '%s' "$ONE_LINE" | unquote | grep -qE "git$ARGS (-c ?|--config-env[ =])alias\."; then
  block "'$COMMAND' defines a git alias inline."
fi

# Git takes a long option by any unique prefix, so `--fo` is `--force` and
# `--del` is `--delete`. A prefix git finds ambiguous fails in git anyway.
# `--ha` is `--hard` through the reset pattern below.
expand_prefixes() {
  sed -E \
    -e ':a' \
    -e 's/(^| )--f(o|or|orc)?( |[;&|]|$)/\1--force\3/' \
    -e 's/(^| )--d(e|el|ele|elet)?( |[;&|]|$)/\1--delete\3/' \
    -e 'ta'
}

NORMALIZED=$(printf '%s' "$ONE_LINE" | sed -E "s/git( ($GLOBAL))+ /git /g" | unquote | expand_prefixes)
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
