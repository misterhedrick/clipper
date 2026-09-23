#!/usr/bin/env bash
# PreToolUse hook for the OpusClip connector's submit tool.
# Allows a submission only when `clipper guard submit` confirms it matches an
# open credit reservation (see docs/ARCHITECTURE.md, "record first, then spend").
# Exit 2 blocks the tool call and shows stderr to Claude.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || { echo "guard: cannot find project dir" >&2; exit 2; }

GUARD=src/cli/index.ts
if [[ ! -f "$GUARD" ]]; then
  echo "Blocked: the submission guard (clipper guard submit, BUILD_PLAN task 8) isn't built yet, so no OpusClip submissions are allowed." >&2
  exit 2
fi

# Pass the hook payload through. Any failure other than an explicit allow blocks.
npx --no-install tsx "$GUARD" guard submit
status=$?
if [[ $status -eq 0 ]]; then exit 0; fi
[[ $status -eq 2 ]] || echo "Blocked: submission guard failed (exit $status)." >&2
exit 2
