#!/usr/bin/env bash
# Installs dependencies in a fresh checkout (e.g. a cloud operator session)
# so `npx clipper` works. No-op when node_modules already exists.
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund --loglevel=error >&2
fi
