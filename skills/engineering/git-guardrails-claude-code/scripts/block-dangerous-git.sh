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
# The shell joins a line that ends in a backslash with the next one.
CONTINUATION=$'\\\n'
ONE_LINE=$(printf '%s' "${COMMAND//"$CONTINUATION"/}" | tr '\t\n' '  ' | tr -s ' ')

# The shell drops quotes and backslashes before git reads its arguments.
unquote() { tr -d "\"'\\\\" | tr -s ' '; }

# `[^;&|]*` keeps a match inside one command of a `&&` or `;` chain.
ARGS="( [^;&|]*)?"

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

# The text view keeps the quotes, so a blocked command inside quoted text
# (`sh -c 'git push'`) still matches.
NORMALIZED=$(printf '%s' "$ONE_LINE" | sed -E "s/git( ($GLOBAL))+ /git /g" | expand_prefixes)

# The word view splits the command the way the shell does: quotes group a
# word, a backslash escapes the next character, and ; & | ( ) end a word, so
# `git "reset" \--hard` is `git reset --hard`. A space or ; & | inside a word
# becomes \001: a quoted option value (`git "-C" "/tmp/a b" push`) stays one
# word when the global options go, and a quoted message never reads as a
# command. awk keeps this fast on a long command.
shell_words() {
  printf '%s\n' "$1" | awk -v SQ="'" -v SEP=$'\001' '{
    out = ""; word = ""; quote = ""
    for (i = 1; i <= length($0); i++) {
      c = substr($0, i, 1)
      if (quote != "" && c == quote) quote = ""
      else if (quote != SQ && c == "\\") { i++; c = substr($0, i, 1); word = word (c ~ /[ ;&|]/ ? SEP : c) }
      else if (quote != "") word = word (c ~ /[ ;&|]/ ? SEP : c)
      else if (c == SQ || c == "\"") quote = c
      else if (c == " ") { out = out " " word; word = "" }
      else if (c ~ /[;&|()]/) { out = out " " word " " c; word = "" }
      else word = word c
    }
    print out " " word
  }' | tr -s ' ' | sed -E 's/^ //; s/ $//'
}
RAW_WORDS=$(shell_words "$ONE_LINE")

# An alias defined inline (`git -c alias.p=push p`), or loaded by an include,
# can run any blocked command under a name no pattern knows. Git config
# section names ignore case. The word view keeps a quoted `;` inside its word
# (`git -c core.editor="a;b" -c alias.p=push p`).
if printf '%s\n%s' "$(printf '%s' "$ONE_LINE" | unquote)" "$RAW_WORDS" | grep -qiE "git$ARGS (-c ?|--config-env[ =])(alias|include|includeif)\."; then
  block "'$COMMAND' defines a git alias or include inline."
fi

WORD_GLOBAL="-[Cc] ?[^ ]+|--(git-dir|work-tree|namespace|super-prefix|exec-path|config-env) [^ ]+|--[a-z-]+(=[^ ]+)?|-p|-P"
WORDS=$(printf '%s' "$RAW_WORDS" | sed -E "s/git( ($WORD_GLOBAL))+ /git /g" | expand_prefixes)

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
  if printf '%s\n%s' "$NORMALIZED" "$WORDS" | grep -qE "$pattern"; then
    block "'$COMMAND' matches dangerous pattern '$pattern'."
  fi
done

exit 0
