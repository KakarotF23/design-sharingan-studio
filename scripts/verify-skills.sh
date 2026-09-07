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

validated_absolute_path() {
  local path="$1"
  local label="$2"
  local require_existing="$3"
  command -v node >/dev/null 2>&1 || fail "Node.js is required for safe path validation"
  node - "$path" "$label" "$require_existing" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [input, label, requireExisting] = process.argv.slice(2);
function reject(message) {
  process.stderr.write(`Skill pack verification FAILED: ${label} ${message}\n`);
  process.exit(1);
}
if (!input || /[\0\r\n]/.test(input)) reject("contains an invalid control character");
if (input.split(/[\\/]+/).includes("..")) reject("must not contain parent traversal");
const absolute = path.resolve(input);
const parsed = path.parse(absolute);
let current = parsed.root;
let missing = false;
for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
  current = path.join(current, component);
  if (missing) continue;
  try {
    const entry = fs.lstatSync(current);
    if (entry.isSymbolicLink()) reject(`contains a symbolic-link ancestor: ${current}`);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      missing = true;
      continue;
    }
    reject(`cannot be inspected safely: ${current}`);
  }
}
if (requireExisting === "1" && missing) reject(`does not exist: ${absolute}`);
process.stdout.write(`${absolute}\n`);
NODE
}

link_count() {
  node -e 'process.stdout.write(require("node:fs").lstatSync(process.argv[1], { bigint: true }).nlink.toString())' "$1"
}

validate_plain_tree() {
  local root="$1"
  local label="$2"
  node - "$root" "$label" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [root, label] = process.argv.slice(2);
function reject(message) {
  process.stderr.write(`Skill pack verification FAILED: ${label} ${message}\n`);
  process.exit(1);
}
function visit(entryPath, isRoot = false) {
  let entry;
  try { entry = fs.lstatSync(entryPath, { bigint: true }); }
  catch { reject(`cannot be inspected safely: ${entryPath}`); }
  if (/[\r\n]/.test(entryPath)) reject("contains a control-character path");
  if (entry.isSymbolicLink()) reject(`contains a symbolic link: ${entryPath}`);
  if (entry.isFile()) {
    if (entry.nlink !== 1n) reject(`contains a hard link (link count ${entry.nlink}): ${entryPath}`);
    return;
  }
  if (!entry.isDirectory()) reject(`contains a non-regular entry: ${entryPath}`);
  for (const child of fs.readdirSync(entryPath)) visit(path.join(entryPath, child));
}
visit(root, true);
NODE
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

required_directories() {
  case "$1" in
    design-sharingan|mangekyo-sharingan)
      printf '%s\n' agents references scripts
      ;;
    eternal-sharingan)
      printf '%s\n' agents references scripts templates
      ;;
    *) fail "unsupported skill contract: $1" ;;
  esac
}

invocation_heading() {
  case "$1" in
    design-sharingan) printf '%s\n' '## Invocation Modes' ;;
    mangekyo-sharingan|eternal-sharingan) printf '%s\n' '## Invocation' ;;
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
  local relative_path expected_files actual_files expected_directories actual_directories
  local expected_modes actual_modes name_count all_name_count closing_line invocation_section
  validate_plain_tree "$skill_root" "$skill source"
  while IFS= read -r relative_path; do
    [[ -f "$skill_root/$relative_path" && ! -L "$skill_root/$relative_path" ]] ||
      fail "$skill is missing required resource: $relative_path"
  done < <(required_files "$skill")
  expected_files="$(required_files "$skill" | LC_ALL=C sort)"
  actual_files="$(cd "$skill_root" && find . -type f -print | sed 's#^\./##' | LC_ALL=C sort)"
  [[ "$actual_files" == "$expected_files" ]] ||
    fail "$skill has an unexpected or missing resource"
  expected_directories="$(required_directories "$skill" | LC_ALL=C sort)"
  actual_directories="$(cd "$skill_root" && find . -mindepth 1 -type d -print | sed 's#^\./##' | LC_ALL=C sort)"
  [[ "$actual_directories" == "$expected_directories" ]] ||
    fail "$skill has an unexpected or missing directory"

  [[ "$(sed -n '1p' "$skill_root/SKILL.md")" == "---" ]] ||
    fail "$skill SKILL.md frontmatter is invalid"
  closing_line="$(awk 'NR > 1 && $0 == "---" { print NR; exit }' "$skill_root/SKILL.md")"
  [[ -n "$closing_line" && "$closing_line" -gt 2 ]] ||
    fail "$skill SKILL.md frontmatter has no closing delimiter"
  name_count="$(sed -n "2,$((closing_line - 1))p" "$skill_root/SKILL.md" | grep -Ec "^name: ${skill}$" || true)"
  all_name_count="$(sed -n "2,$((closing_line - 1))p" "$skill_root/SKILL.md" | grep -Ec '^name:' || true)"
  [[ "$name_count" == "1" && "$all_name_count" == "1" ]] ||
    fail "$skill SKILL.md frontmatter name is invalid"

  invocation_section="$(awk -v heading="$(invocation_heading "$skill")" '
    $0 == heading { found = 1; next }
    found && /^## / { exit }
    found { print }
  ' "$skill_root/SKILL.md")"
  [[ -n "$invocation_section" ]] || fail "$skill invocation contract section is missing"
  grep -Fq "\$$skill" <<<"$invocation_section" ||
    fail "$skill invocation name is missing from its invocation contract"
  expected_modes="$(required_modes "$skill")"
  actual_modes="$(sed -n 's/^| `\([^`]*\)` |.*/\1/p' <<<"$invocation_section")"
  [[ "$actual_modes" == "$expected_modes" ]] ||
    fail "$skill invocation mode contract is invalid"

  invocation_section="$(awk '
    $0 == "interface:" { found = 1; next }
    found && /^[^ ]/ { exit }
    found && /^  default_prompt:/ { print }
  ' "$skill_root/agents/openai.yaml")"
  [[ "$(grep -Ec '^  default_prompt:' <<<"$invocation_section" || true)" == "1" ]] ||
    fail "$skill manifest default_prompt contract is invalid"
  grep -Fq "\$$skill" <<<"$invocation_section" ||
    fail "$skill manifest invocation name is missing from interface.default_prompt"
}

verify_pack() {
  local pack_root="$1"
  local label="$2"
  local skill
  [[ -d "$pack_root" && ! -L "$pack_root" ]] || fail "$label is not a regular directory"
  for skill in design-sharingan mangekyo-sharingan eternal-sharingan; do
    verify_skill "$pack_root" "$skill"
  done
}

SOURCE="$(validated_absolute_path "$SOURCE" "Skill source" 1)"
verify_pack "$SOURCE" "Skill source"
echo "PASS source skill pack: $SOURCE"

if [[ -n "$TARGET" ]]; then
  TARGET="$(validated_absolute_path "$TARGET" "Installed skill target" 1)"
  verify_pack "$TARGET" "Installed skill target"
  for skill in design-sharingan mangekyo-sharingan eternal-sharingan; do
    if ! diff -qr "$SOURCE/$skill" "$TARGET/$skill" >/dev/null; then
      fail "installed $skill differs from its verified source"
    fi
    echo "PASS installed $skill matches source byte-for-byte"
  done
fi

echo "Skill pack verification PASSED."
