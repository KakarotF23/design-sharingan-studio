#!/usr/bin/env bash
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEST="${HOME}/.agents/skills/design-sharingan"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
rm -f "$DEST/design-sharingan.zip" 2>/dev/null || true
printf 'Installed Design Sharingan to %s\n' "$DEST"
printf 'Restart Codex or open a new session, then invoke with: $design-sharingan\n'
