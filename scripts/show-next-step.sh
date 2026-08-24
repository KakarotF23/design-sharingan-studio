#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cat <<'EOF'
Design Sharingan Studio v0.1
============================

NEXT STEP:
1. bash scripts/install-project-skills.sh
2. Start a NEW Codex session with this folder open.
3. Paste CODEX-KICKOFF-PROMPT.md
4. Execute Task 1 only.

SOURCE OF TRUTH:
- AGENTS.md
- docs/superpowers/specs/2026-08-24-design-sharingan-studio-v0.1-design.md
- docs/superpowers/plans/2026-08-24-design-sharingan-studio-v0.1-implementation-plan.md
EOF
