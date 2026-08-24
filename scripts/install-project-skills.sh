#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT_DIR/skills"
TARGET="${DESIGN_SHARINGAN_SKILLS_DIR:-$HOME/.agents/skills}"

mkdir -p "$TARGET"

for skill in design-sharingan mangekyo-sharingan eternal-sharingan; do
  if [[ ! -f "$SOURCE/$skill/SKILL.md" ]]; then
    echo "Missing $SOURCE/$skill/SKILL.md" >&2
    exit 1
  fi

  rm -rf "$TARGET/$skill"
  cp -R "$SOURCE/$skill" "$TARGET/$skill"
  echo "Installed $skill -> $TARGET/$skill"
done

echo
echo "All Design Sharingan skills installed."
echo "Start a new Codex session before using them."
