#!/usr/bin/env bash
# Build p2flux.mcpb: the compiled server with its production dependencies, nothing else.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
( cd "$root" && npm run build >/dev/null )
cp -r "$root/dist" "$root/manifest.json" "$root/package.json" "$root/package-lock.json" "$root/README.md" "$stage/"
( cd "$stage" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 )
npx -y @anthropic-ai/mcpb pack "$stage" "$root/p2flux.mcpb" | tail -3
rm -rf "$stage"
ls -la "$root/p2flux.mcpb"
