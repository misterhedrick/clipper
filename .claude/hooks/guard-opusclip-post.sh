#!/usr/bin/env bash
# PreToolUse hook for the OpusClip connector's post and schedule tools.
# Allows a post only when `clipper guard post` confirms the call matches a post
# the database issued for an approved, packaged clip. Until that command exists,
# every post is blocked. Exit 2 blocks the tool call and shows stderr to Claude.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || { echo "guard: cannot find project dir" >&2; exit 2; }

npx --no-install tsx src/cli/index.ts guard post
status=$?
if [[ $status -eq 0 ]]; then exit 0; fi
[[ $status -eq 2 ]] || echo "Blocked: post guard failed (exit $status)." >&2
exit 2
