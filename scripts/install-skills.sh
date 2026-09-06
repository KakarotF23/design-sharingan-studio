#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SOURCE="$REPOSITORY_ROOT/skills"
if [[ -n "${DESIGN_SHARINGAN_SKILLS_DIR:-}" ]]; then
  TARGET="$DESIGN_SHARINGAN_SKILLS_DIR"
else
  [[ -n "${HOME:-}" ]] || { echo "HOME is required when no skill target is provided" >&2; exit 2; }
  TARGET="$HOME/.agents/skills"
fi

usage() {
  echo "Usage: $0 [--source <skills-directory>] [--target <installed-skills-directory>]" >&2
}

fail() {
  echo "Skill installation FAILED: $*" >&2
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

lexical_absolute_path() {
  local path="$1"
  local normalized
  if [[ "$path" != /* ]]; then
    path="$PWD/$path"
  fi
  normalized="$(printf '%s\n' "$path" | sed -e 's#//*#/#g' -e 's#/\./#/#g' -e 's#/\.$##' -e 's#/$##')"
  [[ -n "$normalized" ]] || normalized="/"
  printf '%s\n' "$normalized"
}

assert_disjoint_paths() {
  local source="$1"
  local target="$2"
  [[ "$target" != "/" ]] || fail "install target must not be the filesystem root"
  if [[ "$source" == "$target" || "$target" == "$source"/* || "$source" == "$target"/* ]]; then
    fail "install target must not overlap the verified skill source"
  fi
}

link_count() {
  if stat -f '%l' "$1" >/dev/null 2>&1; then
    stat -f '%l' "$1"
  else
    stat -c '%h' "$1"
  fi
}

assert_safe_existing_skill() {
  local root="$1"
  local entry count
  [[ -d "$root" && ! -L "$root" ]] || fail "installed skill is not a regular directory: $root"
  while IFS= read -r -d '' entry; do
    if [[ -L "$entry" ]]; then
      fail "installed skill contains a symbolic link: $entry"
    fi
    if [[ -f "$entry" ]]; then
      count="$(link_count "$entry")"
      [[ "$count" == "1" ]] || fail "installed skill contains a hard link: $entry"
    elif [[ ! -d "$entry" ]]; then
      fail "installed skill contains a non-regular entry: $entry"
    fi
  done < <(find "$root" -mindepth 1 -print0)
}

# Source verification is deliberately the first operation that can fail. A
# partial or aliased pack must never change the user's installed skill trees.
bash "$SCRIPT_DIR/verify-skills.sh" --source "$SOURCE"

assert_no_symlink_components "$TARGET" "Install target"
SOURCE="$(cd "$SOURCE" && pwd -P)"
planned_target="$(lexical_absolute_path "$TARGET")"
assert_disjoint_paths "$SOURCE" "$planned_target"
if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  [[ -d "$TARGET" && ! -L "$TARGET" ]] || fail "install target is not a regular directory"
else
  mkdir -p "$TARGET"
fi
assert_no_symlink_components "$TARGET" "Install target"
TARGET="$(cd "$TARGET" && pwd -P)"
assert_disjoint_paths "$SOURCE" "$TARGET"

LOCK="$TARGET/.design-sharingan-install.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  fail "another Design Sharingan skill installation is already in progress"
fi

STAGE=""
BACKUP=""
PROMOTED=""
COMPLETED=0

contains_skill() {
  case " $1 " in
    *" $2 "*) return 0 ;;
    *) return 1 ;;
  esac
}

cleanup_owned_directory() {
  local path="$1"
  [[ -n "$path" && "$path" == "$TARGET"/.design-sharingan-* && -d "$path" && ! -L "$path" ]] || return 0
  rm -R "$path"
}

finish() {
  local status=$?
  local rollback_failed=0
  local skill destination
  trap - EXIT INT TERM HUP
  set +e
  if [[ "$COMPLETED" -ne 1 ]]; then
    for skill in eternal-sharingan mangekyo-sharingan design-sharingan; do
      destination="$TARGET/$skill"
      if contains_skill "$PROMOTED" "$skill" && [[ -e "$destination" || -L "$destination" ]]; then
        /bin/mv "$destination" "$STAGE/.failed-$skill" || rollback_failed=1
      fi
      if [[ -n "$BACKUP" && -e "$BACKUP/$skill" ]]; then
        /bin/mv "$BACKUP/$skill" "$destination" || rollback_failed=1
      fi
    done
  fi
  cleanup_owned_directory "$STAGE"
  if [[ "$rollback_failed" -eq 0 ]]; then
    cleanup_owned_directory "$BACKUP"
  else
    echo "Skill installation rollback was incomplete; recoverable backups remain at $BACKUP" >&2
  fi
  rmdir "$LOCK" 2>/dev/null || true
  if [[ "$rollback_failed" -ne 0 ]]; then
    exit 1
  fi
  exit "$status"
}
trap finish EXIT INT TERM HUP

STAGE="$(mktemp -d "$TARGET/.design-sharingan-stage.XXXXXX")"
BACKUP="$(mktemp -d "$TARGET/.design-sharingan-backup.XXXXXX")"

for skill in design-sharingan mangekyo-sharingan eternal-sharingan; do
  cp -R "$SOURCE/$skill" "$STAGE/$skill"
done
bash "$SCRIPT_DIR/verify-skills.sh" --source "$SOURCE" --target "$STAGE"

for skill in design-sharingan mangekyo-sharingan eternal-sharingan; do
  destination="$TARGET/$skill"
  if [[ -e "$destination" || -L "$destination" ]]; then
    assert_safe_existing_skill "$destination"
    if diff -qr "$SOURCE/$skill" "$destination" >/dev/null; then
      echo "Already current: $skill"
      continue
    fi
    mv "$destination" "$BACKUP/$skill"
  fi
  mv "$STAGE/$skill" "$destination"
  PROMOTED="$PROMOTED $skill"
  echo "Installed $skill -> $destination"
done

bash "$SCRIPT_DIR/verify-skills.sh" --source "$SOURCE" --target "$TARGET"
COMPLETED=1
echo "All Design Sharingan skills are installed and verified."
