#!/usr/bin/env bash
# PreToolUse hook for the OpusClip connector's clip-edit tool.
# Allows an edit only when `clipper guard edit` says so: a dry run, a reviewer's
# needs_edit request, or an automatic fix of a failed check (fixing ops only,
# at most 2 per clip). See docs/ARCHITECTURE.md. Exit 2 blocks the tool call
# and shows stderr to Claude.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || { echo "guard: cannot find project dir" >&2; exit 2; }

# Pass the hook payload through. Any failure other than an explicit allow blocks.
npx --no-install tsx src/cli/index.ts guard edit
status=$?
if [[ $status -eq 0 ]]; then exit 0; fi
[[ $status -eq 2 ]] || echo "Blocked: edit guard failed (exit $status)." >&2
exit 2
