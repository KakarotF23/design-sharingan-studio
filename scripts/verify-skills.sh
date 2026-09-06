#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SOURCE="$REPOSITORY_ROOT/skills"
TARGET=""

usage() {
  echo "Usage: $0 [--source <skills-directory>] [--target <installed-skills-directory>]" >&2
}

fail() {
  echo "Skill pack verification FAILED: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      SOURCE="$2"
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      TARGET="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

assert_no_symlink_components() {
  local path="$1"
  local label="$2"
  case "$path" in
    *$'\n'*|*$'\r'*) fail "$label contains a control character" ;;
  esac
  case "/$path/" in
    */../*) fail "$label must not contain parent traversal" ;;
  esac
  [[ ! -L "$path" ]] || fail "$label is a symbolic-link alias: $path"
}

link_count() {
  if stat -f '%l' "$1" >/dev/null 2>&1; then
    stat -f '%l' "$1"
  else
    stat -c '%h' "$1"
  fi
}

validate_plain_tree() {
  local root="$1"
  local label="$2"
  local entry count
  [[ -d "$root" && ! -L "$root" ]] || fail "$label is not a regular directory"
  while IFS= read -r -d '' entry; do
    case "$entry" in
      *$'\n'*|*$'\r'*) fail "$label contains a control-character path" ;;
    esac
    if [[ -L "$entry" ]]; then
      fail "$label contains a symbolic link: $entry"
    fi
    if [[ -f "$entry" ]]; then
      count="$(link_count "$entry")"
      [[ "$count" == "1" ]] || fail "$label contains a hard link (link count $count): $entry"
    elif [[ ! -d "$entry" ]]; then
      fail "$label contains a non-regular entry: $entry"
    fi
  done < <(find "$root" -mindepth 1 -print0)
}

required_files() {
  case "$1" in
    design-sharingan)
      printf '%s\n' \
        README.txt \
        SKILL.md \
        agents/openai.yaml \
        references/design-dna-schema.md \
        references/design-md-template.md \
        references/verification-cases.md \
        scripts/install.sh
      ;;
    mangekyo-sharingan)
      printf '%s\n' \
        README.txt \
        SKILL.md \
        agents/openai.yaml \
        references/pressure-tests.md \
        references/score-rubric.md \
        references/visual-loop-contract.md \
        scripts/install.sh
      ;;
    eternal-sharingan)
      printf '%s\n' \
        README.txt \
        SKILL.md \
        agents/openai.yaml \
        references/audit-protocol.md \
        references/governance-model.md \
        references/pressure-tests.md \
        references/reference-gate.md \
        references/release-gate.md \
        scripts/init-governance.sh \
        scripts/install.sh \
        templates/DESIGN-DECISIONS.md \
        templates/DESIGN-GENOME.md \
        templates/DRIFT-REPORT.md \
        templates/SCREEN-REGISTRY.md
      ;;
    *) fail "unsupported skill contract: $1" ;;
  esac
}

required_modes() {
  case "$1" in
    design-sharingan) printf '%s\n' scan assimilate evolve verify ;;
    mangekyo-sharingan) printf '%s\n' loop amaterasu tsukuyomi susanoo kamui ;;
    eternal-sharingan) printf '%s\n' init guard audit reference-gate evolve release ;;
    *) fail "unsupported skill contract: $1" ;;
  esac
}

verify_skill() {
  local pack_root="$1"
  local skill="$2"
  local skill_root="$pack_root/$skill"
  local relative_path expected_files actual_files mode name_count all_name_count
  validate_plain_tree "$skill_root" "$skill source"
  while IFS= read -r relative_path; do
    [[ -f "$skill_root/$relative_path" && ! -L "$skill_root/$relative_path" ]] ||
      fail "$skill is missing required resource: $relative_path"
  done < <(required_files "$skill")
  expected_files="$(required_files "$skill" | LC_ALL=C sort)"
  actual_files="$(cd "$skill_root" && find . -type f -print | sed 's#^\./##' | LC_ALL=C sort)"
  [[ "$actual_files" == "$expected_files" ]] ||
    fail "$skill has an unexpected or missing resource"

  [[ "$(sed -n '1p' "$skill_root/SKILL.md")" == "---" ]] ||
    fail "$skill SKILL.md frontmatter is invalid"
  name_count="$(sed -n '2,/^---$/p' "$skill_root/SKILL.md" | grep -Ec "^name: ${skill}$" || true)"
  all_name_count="$(sed -n '2,/^---$/p' "$skill_root/SKILL.md" | grep -Ec '^name:' || true)"
  [[ "$name_count" == "1" && "$all_name_count" == "1" ]] ||
    fail "$skill SKILL.md frontmatter name is invalid"
  grep -Fq "\$$skill" "$skill_root/SKILL.md" || fail "$skill invocation name is missing"
  grep -Fq "\$$skill" "$skill_root/agents/openai.yaml" ||
    fail "$skill manifest invocation name is missing"
  while IFS= read -r mode; do
    grep -Fq "\`$mode\`" "$skill_root/SKILL.md" ||
      fail "$skill invocation mode is missing: $mode"
  done < <(required_modes "$skill")
}

verify_pack() {
  local pack_root="$1"
  local label="$2"
  local skill
  assert_no_symlink_components "$pack_root" "$label"
  [[ -d "$pack_root" && ! -L "$pack_root" ]] || fail "$label is not a regular directory"
  for skill in design-sharingan mangekyo-sharingan eternal-sharingan; do
    verify_skill "$pack_root" "$skill"
  done
}

verify_pack "$SOURCE" "Skill source"
echo "PASS source skill pack: $SOURCE"

if [[ -n "$TARGET" ]]; then
  verify_pack "$TARGET" "Installed skill target"
  for skill in design-sharingan mangekyo-sharingan eternal-sharingan; do
    if ! diff -qr "$SOURCE/$skill" "$TARGET/$skill" >/dev/null; then
      fail "installed $skill differs from its verified source"
    fi
    echo "PASS installed $skill matches source byte-for-byte"
  done
fi

echo "Skill pack verification PASSED."
