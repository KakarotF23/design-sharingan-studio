#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEST_ROOT="${AGENTS_SKILLS_HOME:-$HOME/.agents/skills}"
DEST="$DEST_ROOT/mangekyo-sharingan"

mkdir -p "$DEST_ROOT"
rm -rf "$DEST"
cp -R "$SRC_DIR" "$DEST"

echo "Installed Mangekyo Sharingan to: $DEST"
echo "Restart Codex or open a new session, then invoke:"
echo '  $mangekyo-sharingan loop'
echo '  $mangekyo-sharingan amaterasu'
echo '  $mangekyo-sharingan tsukuyomi'
echo '  $mangekyo-sharingan susanoo'
echo '  $mangekyo-sharingan kamui'
