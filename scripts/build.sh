#!/bin/bash
# Build the Thunderbird MCP extension. Delegates to the reproducible Node
# build (scripts/build-xpi.cjs), so every platform produces the same XPI.
# Arguments are passed through (e.g. --verify, --from <commit>).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node > /dev/null 2>&1; then
  echo "Error: Node.js is required to build the XPI (scripts/build-xpi.cjs)" >&2
  exit 1
fi

exec node "$SCRIPT_DIR/build-xpi.cjs" "$@"
