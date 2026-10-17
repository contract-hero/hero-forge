#!/usr/bin/env bash
set -euo pipefail

# Strict type-check of the review-pipeline helper CLI.
#
# The repo has no dependencies (ADR 0004), so TypeScript and Node's types are
# installed into a temp prefix, removed on exit, and never into the repo.
# Node 22 types: the oldest Node the CLI supports.
#
# Usage: scripts/typecheck.sh [project-dir]
# project-dir defaults to the helper CLI's scripts folder.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${1:-$REPO/skills/engineering/review-pipeline/scripts}"

PREFIX="$(mktemp -d)"
trap 'rm -rf "$PREFIX"' EXIT

npm install --prefix "$PREFIX" --no-audit --no-fund --loglevel=error typescript@5 @types/node@22

"$PREFIX/node_modules/.bin/tsc" -p "$PROJECT" --noEmit --typeRoots "$PREFIX/node_modules/@types"
