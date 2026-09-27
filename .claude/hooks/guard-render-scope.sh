#!/usr/bin/env bash
# PreToolUse hook for the Render connector.
# The Render workspace also holds services that aren't part of Clipper (the
# `options` repo's qrps-paper-automation-worker). This repo's sessions must
# never act on them, so any Render call that names one is blocked.
# Exit 2 blocks the tool call and shows stderr to Claude.
set -uo pipefail

payload=$(cat)
if grep -qiE 'srv-damka3sri2ms73dn2130|qrps-paper-automation-worker|evm-d9pkgrqjnfac73ese6ng|misterhedrick/options' <<<"$payload"; then
  echo "Blocked: that Render service belongs to a separate project (qrps-paper-automation-worker). Clipper sessions only touch clipper-review (srv-dapjuq0u01pc73cteut0)." >&2
  exit 2
fi
exit 0
