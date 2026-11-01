#!/usr/bin/env bash
# Packs the Claude Desktop extension from a built server bundle and the
# manifest assemble-public.mjs wrote to mcpb/, validates it with the official
# mcpb CLI (installed with npm ci from mcpb/tool's lockfile, so it and every
# dependency are pinned by integrity hash), then unpacks the result and
# smoke-tests it the way Desktop launches it: both optional credential fields
# left at their empty defaults. Run from the public repo's root, in a job that
# holds no credential.
#
# Usage: scripts/pack-mcpb.sh <dist/index.js> <out.mcpb>

set -euo pipefail

MCPB_VERSION=2.1.2

if [ $# -ne 2 ]; then
  echo "usage: scripts/pack-mcpb.sh <dist/index.js> <out.mcpb>" >&2
  exit 1
fi
SERVER=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
OUT=$(mkdir -p "$(dirname "$2")" && cd "$(dirname "$2")" && pwd)/$(basename "$2")
ROOT=$(pwd)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cp -R mcpb/tool "$WORK/tool"
(cd "$WORK/tool" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
MCPB="$WORK/tool/node_modules/.bin/mcpb"
[ "$("$MCPB" --version)" = "$MCPB_VERSION" ] || {
  echo "mcpb/tool/package-lock.json does not pin mcpb $MCPB_VERSION" >&2
  exit 1
}

ENTRY=$(node -p "require('./mcpb/manifest.json').server.entry_point")
mkdir -p "$WORK/bundle/$(dirname "$ENTRY")"
cp "$SERVER" "$WORK/bundle/$ENTRY"
cp mcpb/manifest.json mcpb/icon.png LICENSE README.md "$WORK/bundle/"

"$MCPB" validate "$WORK/bundle/manifest.json"
"$MCPB" pack "$WORK/bundle" "$OUT"
"$MCPB" unpack "$OUT" "$WORK/unpacked"
ARCSYNC_CLIENT_ID='' ARCSYNC_CLIENT_SECRET='' \
  node "$ROOT/scripts/smoke-stdio.mjs" node "$WORK/unpacked/$ENTRY"
