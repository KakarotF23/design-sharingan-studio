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
  process.stderr.write(`Skill installation FAILED: ${label} ${message}\n`);
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

sync_directories() {
  command -v node >/dev/null 2>&1 || fail "Node.js is required for durable installation"
  node - "$@" <<'NODE'
const fs = require("node:fs");
for (const directory of process.argv.slice(2)) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
NODE
}

sync_tree() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
function syncEntry(entryPath) {
  const entry = fs.lstatSync(entryPath);
  if (entry.isSymbolicLink()) throw new Error(`Refusing to sync symbolic link: ${entryPath}`);
  if (entry.isDirectory()) {
    for (const child of fs.readdirSync(entryPath)) syncEntry(path.join(entryPath, child));
  } else if (!entry.isFile()) {
    throw new Error(`Refusing to sync non-regular entry: ${entryPath}`);
  }
  const descriptor = fs.openSync(entryPath, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
syncEntry(process.argv[2]);
NODE
}

durable_write() {
  local destination="$1"
  local content="$2"
  node - "$destination" "$content" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [destination, content] = process.argv.slice(2);
const parent = path.dirname(destination);
const temporary = path.join(
  parent,
  `.${path.basename(destination)}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
);
let descriptor;
try {
  descriptor = fs.openSync(temporary, "wx", 0o600);
  fs.writeFileSync(descriptor, `${content}\n`, "utf8");
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  descriptor = undefined;
  fs.renameSync(temporary, destination);
  const parentDescriptor = fs.openSync(parent, "r");
  try {
    fs.fsyncSync(parentDescriptor);
  } finally {
    fs.closeSync(parentDescriptor);
  }
} finally {
  if (descriptor !== undefined) fs.closeSync(descriptor);
  try { fs.unlinkSync(temporary); } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}
NODE
}

durable_move() {
  local source="$1"
  local destination="$2"
  [[ ! -e "$destination" && ! -L "$destination" ]] ||
    fail "transaction destination already exists: $destination"
  mv "$source" "$destination"
  sync_directories "$(dirname "$source")" "$(dirname "$destination")"
}

process_identity() {
  local pid="$1"
  local started
  started="$(ps -p "$pid" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true)"
  [[ -n "$started" ]] || return 1
  printf '%s' "$started" | shasum -a 256 | awk '{print $1}'
}

directory_mtime() {
  node -e 'process.stdout.write(String(Math.floor(require("node:fs").statSync(process.argv[1]).mtimeMs / 1000)))' "$1"
}

random_transaction_id() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))'
}

test_hook() {
  local boundary="$1"
  [[ "${DESIGN_SHARINGAN_INSTALL_TEST_HOOK:-}" == "$boundary" ]] || return 0
  local hook_directory="${DESIGN_SHARINGAN_INSTALL_TEST_HOOK_DIR:-}"
  [[ -n "$hook_directory" && -d "$hook_directory" && ! -L "$hook_directory" ]] ||
    fail "test hook directory is invalid"
  : > "$hook_directory/reached"
  while [[ ! -f "$hook_directory/release" ]]; do
    sleep 0.02
  done
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

cleanup_owned_directory() {
  local path="$1"
  [[ -n "$path" && "$path" == "$TARGET"/.design-sharingan-* ]] ||
    fail "refusing to clean a non-transaction path: $path"
  [[ -e "$path" || -L "$path" ]] || return 0
  [[ -d "$path" && ! -L "$path" ]] ||
    fail "transaction path is not a regular directory: $path"
  assert_safe_existing_skill "$path"
  rm -R "$path"
}

cleanup_atomic_temps() {
  local directory="$1"
  local entry name
  while IFS= read -r -d '' entry; do
    name="$(basename "$entry")"
    case "$name" in
      .owner.tmp-*|.journal.tmp-*) ;;
      *) continue ;;
    esac
    [[ -f "$entry" && ! -L "$entry" && "$(link_count "$entry")" == "1" ]] ||
      fail "orphan transaction temporary is not a regular owned file: $entry"
    rm -f "$entry"
  done < <(find "$directory" -mindepth 1 -maxdepth 1 -print0)
  sync_directories "$directory"
}

LOCK=""
OWNER=""
JOURNAL=""
LOCK_OWNED=0
COMPLETED=0
TRANSACTION=""
STAGE=""
BACKUP=""
DISCARD=""
PHASE=""
DESIGN_OLD="unknown"
DESIGN_STATE="UNSEEN"
MANGEKYO_OLD="unknown"
MANGEKYO_STATE="UNSEEN"
ETERNAL_OLD="unknown"
ETERNAL_STATE="UNSEEN"

skill_old() {
  case "$1" in
    design-sharingan) printf '%s\n' "$DESIGN_OLD" ;;
    mangekyo-sharingan) printf '%s\n' "$MANGEKYO_OLD" ;;
    eternal-sharingan) printf '%s\n' "$ETERNAL_OLD" ;;
  esac
}

skill_state() {
  case "$1" in
    design-sharingan) printf '%s\n' "$DESIGN_STATE" ;;
    mangekyo-sharingan) printf '%s\n' "$MANGEKYO_STATE" ;;
    eternal-sharingan) printf '%s\n' "$ETERNAL_STATE" ;;
  esac
}

set_skill_old() {
  case "$1" in
    design-sharingan) DESIGN_OLD="$2" ;;
    mangekyo-sharingan) MANGEKYO_OLD="$2" ;;
    eternal-sharingan) ETERNAL_OLD="$2" ;;
  esac
}

set_skill_state() {
  case "$1" in
    design-sharingan) DESIGN_STATE="$2" ;;
    mangekyo-sharingan) MANGEKYO_STATE="$2" ;;
    eternal-sharingan) ETERNAL_STATE="$2" ;;
  esac
}

write_journal() {
  local content
  content="version=1
transaction=$TRANSACTION
stage=$(basename "$STAGE")
backup=$(basename "$BACKUP")
discard=$(basename "$DISCARD")
phase=$PHASE
design-sharingan.old=$DESIGN_OLD
design-sharingan.state=$DESIGN_STATE
mangekyo-sharingan.old=$MANGEKYO_OLD
mangekyo-sharingan.state=$MANGEKYO_STATE
eternal-sharingan.old=$ETERNAL_OLD
eternal-sharingan.state=$ETERNAL_STATE"
  durable_write "$JOURNAL" "$content"
}

journal_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { count += 1; value = substr($0, length(key) + 2) } END { if (count == 1) print value; else exit 1 }' "$JOURNAL"
}

load_journal() {
  local keys expected_keys stage_name backup_name discard_name
  [[ -f "$JOURNAL" && ! -L "$JOURNAL" && "$(link_count "$JOURNAL")" == "1" ]] ||
    fail "transaction journal is not a regular owned file"
  keys="$(sed 's/=.*//' "$JOURNAL")"
  expected_keys="version
transaction
stage
backup
discard
phase
design-sharingan.old
design-sharingan.state
mangekyo-sharingan.old
mangekyo-sharingan.state
eternal-sharingan.old
eternal-sharingan.state"
  [[ "$keys" == "$expected_keys" ]] || fail "transaction journal structure is invalid"
  [[ "$(journal_value version)" == "1" ]] || fail "transaction journal version is invalid"
  TRANSACTION="$(journal_value transaction)"
  [[ "$TRANSACTION" =~ ^[a-f0-9]{32}$ ]] || fail "transaction journal identity is invalid"
  stage_name="$(journal_value stage)"
  backup_name="$(journal_value backup)"
  discard_name="$(journal_value discard)"
  [[ "$stage_name" == ".design-sharingan-stage.$TRANSACTION" ]] || fail "transaction stage path is invalid"
  [[ "$backup_name" == ".design-sharingan-backup.$TRANSACTION" ]] || fail "transaction backup path is invalid"
  [[ "$discard_name" == ".design-sharingan-discard.$TRANSACTION" ]] || fail "transaction discard path is invalid"
  STAGE="$TARGET/$stage_name"
  BACKUP="$TARGET/$backup_name"
  DISCARD="$TARGET/$discard_name"
  PHASE="$(journal_value phase)"
  [[ "$PHASE" == "ACTIVE" || "$PHASE" == "COMMITTED" ]] || fail "transaction journal phase is invalid"
  DESIGN_OLD="$(journal_value design-sharingan.old)"
  DESIGN_STATE="$(journal_value design-sharingan.state)"
  MANGEKYO_OLD="$(journal_value mangekyo-sharingan.old)"
  MANGEKYO_STATE="$(journal_value mangekyo-sharingan.state)"
  ETERNAL_OLD="$(journal_value eternal-sharingan.old)"
  ETERNAL_STATE="$(journal_value eternal-sharingan.state)"
  for skill in design-sharingan mangekyo-sharingan eternal-sharingan; do
    [[ "$(skill_old "$skill")" =~ ^(unknown|0|1)$ ]] || fail "transaction old-state is invalid for $skill"
    [[ "$(skill_state "$skill")" =~ ^(UNSEEN|UNCHANGED|PREPARE_BACKUP|BACKED_UP|PREPARE_PROMOTE|PROMOTED|ROLLBACK_PREPARE_DISCARD|ROLLBACK_DISCARDED|ROLLBACK_PREPARE_RESTORE|ROLLED_BACK)$ ]] ||
      fail "transaction state is invalid for $skill"
    case "$(skill_old "$skill"):$(skill_state "$skill")" in
      unknown:UNSEEN|\
      0:PREPARE_PROMOTE|0:PROMOTED|0:ROLLBACK_PREPARE_DISCARD|0:ROLLED_BACK|\
      1:UNCHANGED|1:PREPARE_BACKUP|1:BACKED_UP|1:PREPARE_PROMOTE|1:PROMOTED|\
      1:ROLLBACK_PREPARE_DISCARD|1:ROLLBACK_DISCARDED|1:ROLLBACK_PREPARE_RESTORE|1:ROLLED_BACK) ;;
      *) fail "transaction state relation is invalid for $skill" ;;
    esac
    if [[ "$PHASE" == "COMMITTED" ]]; then
      [[ "$(skill_state "$skill")" == "UNCHANGED" || "$(skill_state "$skill")" == "PROMOTED" ]] ||
        fail "committed transaction is incomplete for $skill"
    fi
  done
}

rollback_skill() {
  local skill="$1"
  local old state destination backup_path discard_path
  old="$(skill_old "$skill")"
  state="$(skill_state "$skill")"
  destination="$TARGET/$skill"
  backup_path="$BACKUP/$skill"
  discard_path="$DISCARD/$skill"
  if [[ "$old" == "unknown" ]]; then
    [[ ! -e "$backup_path" && ! -L "$backup_path" && ! -e "$discard_path" && ! -L "$discard_path" ]] ||
      fail "unseen transaction state owns unexpected recovery data for $skill"
    return 0
  fi

  if [[ "$old" == "1" ]]; then
    if [[ -e "$backup_path" || -L "$backup_path" ]]; then
      assert_safe_existing_skill "$backup_path"
      if [[ -e "$destination" || -L "$destination" ]]; then
        assert_safe_existing_skill "$destination"
        [[ ! -e "$discard_path" && ! -L "$discard_path" ]] ||
          fail "rollback discard already exists for $skill"
        set_skill_state "$skill" "ROLLBACK_PREPARE_DISCARD"
        write_journal
        durable_move "$destination" "$discard_path"
        set_skill_state "$skill" "ROLLBACK_DISCARDED"
        write_journal
      fi
      set_skill_state "$skill" "ROLLBACK_PREPARE_RESTORE"
      write_journal
      durable_move "$backup_path" "$destination"
      set_skill_state "$skill" "ROLLED_BACK"
      write_journal
    else
      [[ -d "$destination" && ! -L "$destination" ]] ||
        fail "rollback cannot recover missing original $skill"
      case "$state" in
        UNCHANGED|PREPARE_BACKUP|ROLLBACK_PREPARE_RESTORE|ROLLED_BACK) ;;
        *) fail "rollback backup is missing for $skill in state $state" ;;
      esac
    fi
  else
    [[ ! -e "$backup_path" && ! -L "$backup_path" ]] ||
      fail "rollback found an impossible backup for new skill $skill"
    if [[ -e "$destination" || -L "$destination" ]]; then
      assert_safe_existing_skill "$destination"
      [[ ! -e "$discard_path" && ! -L "$discard_path" ]] ||
        fail "rollback discard already exists for new skill $skill"
      set_skill_state "$skill" "ROLLBACK_PREPARE_DISCARD"
      write_journal
      durable_move "$destination" "$discard_path"
    fi
    set_skill_state "$skill" "ROLLED_BACK"
    write_journal
  fi
}

cleanup_transaction() {
  cleanup_owned_directory "$STAGE"
  cleanup_owned_directory "$BACKUP"
  cleanup_owned_directory "$DISCARD"
  sync_directories "$TARGET"
}

recover_transaction() {
  load_journal
  if [[ "$PHASE" == "ACTIVE" ]]; then
    for skill in eternal-sharingan mangekyo-sharingan design-sharingan; do
      rollback_skill "$skill"
    done
  fi
  cleanup_transaction
  rm -f "$JOURNAL"
  sync_directories "$LOCK"
}

owner_content() {
  local identity now lease_until
  identity="$(process_identity "$$")" || fail "cannot establish installer process identity"
  now="$(date +%s)"
  lease_until=$((now + LOCK_LEASE_SECONDS))
  printf 'version=1\npid=%s\nidentity=%s\nlease_until=%s' "$$" "$identity" "$lease_until"
}

write_owner() {
  durable_write "$OWNER" "$(owner_content)"
}

read_owner() {
  local owner_file="${1:-$OWNER}"
  local keys
  [[ -f "$owner_file" && ! -L "$owner_file" && "$(link_count "$owner_file")" == "1" ]] || return 1
  keys="$(sed 's/=.*//' "$owner_file")"
  [[ "$keys" == $'version\npid\nidentity\nlease_until' ]] || return 1
  [[ "$(journal_value_from "$owner_file" version)" == "1" ]] || return 1
  OWNER_PID="$(journal_value_from "$owner_file" pid)"
  OWNER_IDENTITY="$(journal_value_from "$owner_file" identity)"
  OWNER_LEASE_UNTIL="$(journal_value_from "$owner_file" lease_until)"
  [[ "$OWNER_PID" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$OWNER_IDENTITY" =~ ^[a-f0-9]{64}$ ]] || return 1
  [[ "$OWNER_LEASE_UNTIL" =~ ^[0-9]+$ ]] || return 1
}

journal_value_from() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '$1 == key { count += 1; value = substr($0, length(key) + 2) } END { if (count == 1) print value; else exit 1 }' "$file"
}

lock_owner_is_live() {
  local current_identity
  current_identity="$(process_identity "$OWNER_PID")" || return 1
  [[ "$current_identity" == "$OWNER_IDENTITY" ]]
}

acquire_recovery_claim() {
  local claim="$1"
  local claim_owner="$claim/owner"
  local now claim_mtime entries
  if mkdir "$claim" 2>/dev/null; then
    sync_directories "$LOCK"
    durable_write "$claim_owner" "$(owner_content)"
    return 0
  fi
  [[ -d "$claim" && ! -L "$claim" ]] || fail "recovery claim is not a regular directory"
  if [[ -e "$claim_owner" || -L "$claim_owner" ]]; then
    read_owner "$claim_owner" || fail "recovery claim owner record is invalid"
    lock_owner_is_live && fail "another live installer is recovering the stale install lock"
  else
    now="$(date +%s)"
    claim_mtime="$(directory_mtime "$claim")"
    (( now - claim_mtime >= LOCK_LEASE_SECONDS )) ||
      fail "a recent ownerless recovery claim is still leased"
  fi
  cleanup_atomic_temps "$claim"
  entries="$(find "$claim" -mindepth 1 -maxdepth 1 -print)"
  if [[ -n "$entries" && "$entries" != "$claim_owner" ]]; then
    fail "stale recovery claim contains unexpected state"
  fi
  rm -f "$claim_owner"
  rmdir "$claim"
  sync_directories "$LOCK"
  mkdir "$claim"
  sync_directories "$LOCK"
  durable_write "$claim_owner" "$(owner_content)"
}

release_recovery_claim() {
  local claim="$1"
  rm -f "$claim/owner"
  sync_directories "$claim"
  rmdir "$claim"
  sync_directories "$LOCK"
}

acquire_lock() {
  local now lock_mtime claim
  if mkdir "$LOCK" 2>/dev/null; then
    LOCK_OWNED=1
    write_owner
    test_hook "lock-acquired"
    return 0
  fi
  [[ -d "$LOCK" && ! -L "$LOCK" ]] || fail "install lock is not a regular directory"

  if [[ -e "$OWNER" || -L "$OWNER" ]]; then
    read_owner || fail "install lock owner record is invalid"
    lock_owner_is_live && fail "another live Design Sharingan skill installation is in progress"
  else
    now="$(date +%s)"
    lock_mtime="$(directory_mtime "$LOCK")"
    (( now - lock_mtime >= LOCK_LEASE_SECONDS )) ||
      fail "a recent ownerless Design Sharingan install lock is still leased"
  fi

  claim="$LOCK/recovery-claim"
  acquire_recovery_claim "$claim"
  cleanup_atomic_temps "$LOCK"
  if [[ -e "$OWNER" || -L "$OWNER" ]]; then
    read_owner || fail "install lock owner record changed during recovery"
    if lock_owner_is_live; then
      release_recovery_claim "$claim"
      fail "another live Design Sharingan skill installation is in progress"
    fi
  fi
  if [[ -e "$JOURNAL" || -L "$JOURNAL" ]]; then
    recover_transaction
  fi
  LOCK_OWNED=1
  write_owner
  release_recovery_claim "$claim"
  test_hook "after-stale-recovery"
}

finish() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [[ "$LOCK_OWNED" -eq 1 ]]; then
    if [[ -e "$JOURNAL" || -L "$JOURNAL" ]]; then
      if [[ "$COMPLETED" -eq 1 ]]; then
        load_journal
        cleanup_transaction
        rm -f "$JOURNAL"
        sync_directories "$LOCK"
      else
        recover_transaction
      fi
    fi
    rm -f "$OWNER"
    if [[ -d "$LOCK/recovery-claim" && ! -L "$LOCK/recovery-claim" ]]; then
      rm -f "$LOCK/recovery-claim/owner"
      rmdir "$LOCK/recovery-claim" 2>/dev/null || true
    fi
    sync_directories "$LOCK"
    rmdir "$LOCK" || fail "could not release install lock cleanly"
    sync_directories "$TARGET"
  fi
  exit "$status"
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

SOURCE="$(validated_absolute_path "$SOURCE" "Skill source" 1)"
TARGET="$(validated_absolute_path "$TARGET" "Install target" 0)"
assert_disjoint_paths "$SOURCE" "$TARGET"

# The complete source and every existing path ancestor are verified before the
# installer creates the target or changes any installed skill.
bash "$SCRIPT_DIR/verify-skills.sh" --source "$SOURCE"

if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  [[ -d "$TARGET" && ! -L "$TARGET" ]] || fail "install target is not a regular directory"
else
  mkdir -p "$TARGET"
  sync_directories "$(dirname "$TARGET")"
fi
TARGET="$(validated_absolute_path "$TARGET" "Install target" 1)"
assert_disjoint_paths "$SOURCE" "$TARGET"

LOCK_LEASE_SECONDS="${DESIGN_SHARINGAN_LOCK_LEASE_SECONDS:-30}"
[[ "$LOCK_LEASE_SECONDS" =~ ^[1-9][0-9]*$ && "$LOCK_LEASE_SECONDS" -le 600 ]] ||
  fail "lock lease must be an integer from 1 through 600 seconds"
LOCK="$TARGET/.design-sharingan-install.lock"
OWNER="$LOCK/owner"
JOURNAL="$LOCK/journal"
acquire_lock

TRANSACTION="$(random_transaction_id)"
STAGE="$TARGET/.design-sharingan-stage.$TRANSACTION"
BACKUP="$TARGET/.design-sharingan-backup.$TRANSACTION"
DISCARD="$TARGET/.design-sharingan-discard.$TRANSACTION"
PHASE="ACTIVE"
write_journal
mkdir "$STAGE" "$BACKUP" "$DISCARD"
sync_directories "$TARGET"

for skill in design-sharingan mangekyo-sharingan eternal-sharingan; do
  cp -R "$SOURCE/$skill" "$STAGE/$skill"
done
sync_tree "$STAGE"
bash "$SCRIPT_DIR/verify-skills.sh" --source "$SOURCE" --target "$STAGE"

for skill in design-sharingan mangekyo-sharingan eternal-sharingan; do
  destination="$TARGET/$skill"
  if [[ -e "$destination" || -L "$destination" ]]; then
    assert_safe_existing_skill "$destination"
    if diff -qr "$SOURCE/$skill" "$destination" >/dev/null; then
      set_skill_old "$skill" "1"
      set_skill_state "$skill" "UNCHANGED"
      write_journal
      echo "Already current: $skill"
      continue
    fi
    set_skill_old "$skill" "1"
    set_skill_state "$skill" "PREPARE_BACKUP"
    write_journal
    test_hook "after-prepare-backup:$skill"
    durable_move "$destination" "$BACKUP/$skill"
    test_hook "after-backup-move:$skill"
    set_skill_state "$skill" "BACKED_UP"
    write_journal
    test_hook "after-backed-up:$skill"
  else
    set_skill_old "$skill" "0"
  fi

  set_skill_state "$skill" "PREPARE_PROMOTE"
  write_journal
  test_hook "after-prepare-promote:$skill"
  durable_move "$STAGE/$skill" "$destination"
  test_hook "after-promote-move:$skill"
  set_skill_state "$skill" "PROMOTED"
  write_journal
  test_hook "after-promoted:$skill"
  echo "Installed $skill -> $destination"
done

bash "$SCRIPT_DIR/verify-skills.sh" --source "$SOURCE" --target "$TARGET"
PHASE="COMMITTED"
write_journal
test_hook "after-committed"
COMPLETED=1
echo "All Design Sharingan skills are installed and verified."
