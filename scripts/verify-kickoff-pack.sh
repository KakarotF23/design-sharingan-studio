#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

required=(
  "AGENTS.md"
  "README.md"
  "CODEX-KICKOFF-PROMPT.md"
  "PROJECT-MANIFEST.md"
  "docs/superpowers/specs/2026-08-24-design-sharingan-studio-v0.1-design.md"
  "docs/superpowers/plans/2026-08-24-design-sharingan-studio-v0.1-implementation-plan.md"
  "skills/design-sharingan/SKILL.md"
  "skills/mangekyo-sharingan/SKILL.md"
  "skills/eternal-sharingan/SKILL.md"
)

failed=0
for rel in "${required[@]}"; do
  if [[ -f "$ROOT_DIR/$rel" ]]; then
    echo "PASS $rel"
  else
    echo "FAIL $rel"
    failed=1
  fi
done

echo
grep -q "Task 1: Bootstrap" \
  "$ROOT_DIR/docs/superpowers/plans/2026-08-24-design-sharingan-studio-v0.1-implementation-plan.md" \
  && echo "PASS implementation plan contains Task 1" \
  || { echo "FAIL Task 1 not found"; failed=1; }

grep -q "Safe Mode + Mangekyō Mode" \
  "$ROOT_DIR/docs/superpowers/specs/2026-08-24-design-sharingan-studio-v0.1-design.md" \
  && echo "PASS approved dual-mode architecture" \
  || { echo "FAIL dual-mode architecture missing"; failed=1; }

grep -q "No mutation occurs before approval" \
  "$ROOT_DIR/docs/superpowers/specs/2026-08-24-design-sharingan-studio-v0.1-design.md" \
  && echo "PASS Safe Mode approval boundary" \
  || { echo "FAIL Safe Mode boundary missing"; failed=1; }

if [[ "$failed" -ne 0 ]]; then
  echo
  echo "Kickoff pack verification FAILED."
  exit 1
fi

echo
echo "Kickoff pack verification PASSED."
