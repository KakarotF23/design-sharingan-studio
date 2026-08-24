#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-design-governance}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

mkdir -p "$TARGET"

copy_if_missing() {
  local src="$1"
  local dst="$2"
  if [[ -e "$dst" ]]; then
    echo "KEEP: $dst already exists"
  else
    cp "$src" "$dst"
    echo "CREATE: $dst"
  fi
}

copy_if_missing "$SKILL_DIR/templates/DESIGN-GENOME.md" "$TARGET/DESIGN-GENOME.md"
copy_if_missing "$SKILL_DIR/templates/SCREEN-REGISTRY.md" "$TARGET/SCREEN-REGISTRY.md"
copy_if_missing "$SKILL_DIR/templates/DESIGN-DECISIONS.md" "$TARGET/DESIGN-DECISIONS.md"
copy_if_missing "$SKILL_DIR/templates/DRIFT-REPORT.md" "$TARGET/DRIFT-REPORT.md"

echo
echo "Governance templates initialized in: $TARGET"
echo "These are templates, not approved product truth."
echo 'Run "$eternal-sharingan init" in Codex to inspect the real product and propose the initial genome.'
