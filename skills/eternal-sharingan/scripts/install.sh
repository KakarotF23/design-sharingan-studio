#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEST_ROOT="${AGENTS_SKILLS_HOME:-$HOME/.agents/skills}"
DEST="$DEST_ROOT/eternal-sharingan"

mkdir -p "$DEST_ROOT"
rm -rf "$DEST"
cp -R "$SRC_DIR" "$DEST"

echo "Installed Eternal Sharingan to: $DEST"
echo "Restart Codex or open a new session, then invoke:"
echo '  $eternal-sharingan init'
echo '  $eternal-sharingan guard'
echo '  $eternal-sharingan audit'
echo '  $eternal-sharingan reference-gate'
echo '  $eternal-sharingan evolve'
echo '  $eternal-sharingan release'
