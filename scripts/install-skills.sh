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
  node -e 'process.stdout.write(require("node:fs").lstatSync(process.argv[1], { bigint: true }).nlink.toString())' "$1"
}

directory_identity() {
  node -e 'const value = require("node:fs").lstatSync(process.argv[1], { bigint: true }); process.stdout.write(`${value.dev}:${value.ino}`)' "$1"
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
  node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$started"
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
  node - "$root" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
function reject(message) {
  process.stderr.write(`Skill installation FAILED: ${message}\n`);
  process.exit(1);
}
function visit(entryPath) {
  let entry;
  try { entry = fs.lstatSync(entryPath, { bigint: true }); }
  catch { reject(`installed skill cannot be inspected safely: ${entryPath}`); }
  if (entry.isSymbolicLink()) reject(`installed skill contains a symbolic link: ${entryPath}`);
  if (entry.isFile()) {
    if (entry.nlink !== 1n) reject(`installed skill contains a hard link: ${entryPath}`);
    return;
  }
  if (!entry.isDirectory()) reject(`installed skill contains a non-regular entry: ${entryPath}`);
  for (const child of fs.readdirSync(entryPath)) visit(path.join(entryPath, child));
}
visit(root);
NODE
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
LOCK_TOKEN=""
LOCK_IDENTITY=""
CLAIM=""
CLAIM_OWNED=0
CLAIM_TOKEN=""
CLAIM_IDENTITY=""
CLAIM_CANDIDATE=""
LOCK_CANDIDATE=""
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
  local kind="$1"
  local token="$2"
  local identity now lease_until
  identity="$(process_identity "$$")" || fail "cannot establish installer process identity"
  now="$(date +%s)"
  lease_until=$((now + LOCK_LEASE_SECONDS))
  printf 'version=2\nkind=%s\ntoken=%s\npid=%s\nidentity=%s\nlease_until=%s' \
    "$kind" "$token" "$$" "$identity" "$lease_until"
}

prepare_owner_directory() {
  local kind="$1"
  local prefix="$2"
  PREPARED_TOKEN="$(random_transaction_id)"
  PREPARED_DIRECTORY="$TARGET/$prefix.$PREPARED_TOKEN"
  mkdir "$PREPARED_DIRECTORY"
  sync_directories "$TARGET"
  durable_write "$PREPARED_DIRECTORY/owner" "$(owner_content "$kind" "$PREPARED_TOKEN")"
  sync_directories "$PREPARED_DIRECTORY"
  PREPARED_IDENTITY="$(directory_identity "$PREPARED_DIRECTORY")"
}

read_owner_directory() {
  local owner_directory="$1"
  local expected_kind="$2"
  local owner_file="$owner_directory/owner"
  local keys
  [[ -d "$owner_directory" && ! -L "$owner_directory" ]] || return 1
  [[ -f "$owner_file" && ! -L "$owner_file" && "$(link_count "$owner_file")" == "1" ]] || return 1
  keys="$(sed 's/=.*//' "$owner_file")"
  [[ "$keys" == $'version\nkind\ntoken\npid\nidentity\nlease_until' ]] || return 1
  [[ "$(journal_value_from "$owner_file" version)" == "2" ]] || return 1
  OWNER_KIND="$(journal_value_from "$owner_file" kind)"
  OWNER_TOKEN="$(journal_value_from "$owner_file" token)"
  OWNER_PID="$(journal_value_from "$owner_file" pid)"
  OWNER_IDENTITY="$(journal_value_from "$owner_file" identity)"
  OWNER_LEASE_UNTIL="$(journal_value_from "$owner_file" lease_until)"
  OWNER_DIRECTORY_IDENTITY="$(directory_identity "$owner_directory")"
  [[ "$OWNER_KIND" == "$expected_kind" ]] || return 1
  [[ "$OWNER_TOKEN" =~ ^[a-f0-9]{32}$ ]] || return 1
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

verify_owner_directory() {
  local directory="$1"
  local kind="$2"
  local token="$3"
  local identity="$4"
  read_owner_directory "$directory" "$kind" ||
    fail "$kind owner directory is not fully authenticated"
  [[ "$OWNER_TOKEN" == "$token" && "$OWNER_DIRECTORY_IDENTITY" == "$identity" ]] ||
    fail "$kind owner directory identity changed"
}

publish_owner_directory() {
  local prepared="$1"
  local published="$2"
  local kind="$3"
  local token="$4"
  local identity="$5"
  node - "$prepared" "$published" "$identity" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [prepared, published, expectedIdentity] = process.argv.slice(2);
function identity(entryPath) {
  const value = fs.lstatSync(entryPath, { bigint: true });
  return `${value.dev}:${value.ino}`;
}
if (identity(prepared) !== expectedIdentity) {
  process.stderr.write("prepared owner directory identity changed\n");
  process.exit(18);
}
try {
  fs.renameSync(prepared, published);
} catch (error) {
  if (error && ["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(error.code)) process.exit(17);
  throw error;
}
if (identity(published) !== expectedIdentity) {
  process.stderr.write("published owner directory identity changed\n");
  process.exit(18);
}
const descriptor = fs.openSync(path.dirname(published), "r");
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
  local status=$?
  if [[ "$status" -eq 0 ]]; then
    verify_owner_directory "$published" "$kind" "$token" "$identity"
  fi
  return "$status"
}

quarantine_owner_directory() {
  local published="$1"
  local quarantine="$2"
  local kind="$3"
  local token="$4"
  local identity="$5"
  verify_owner_directory "$published" "$kind" "$token" "$identity"
  [[ ! -e "$quarantine" && ! -L "$quarantine" ]] ||
    fail "$kind recovery quarantine already exists"
  node - "$published" "$quarantine" "$identity" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [published, quarantine, expectedIdentity] = process.argv.slice(2);
function identity(entryPath) {
  const value = fs.lstatSync(entryPath, { bigint: true });
  return `${value.dev}:${value.ino}`;
}
if (identity(published) !== expectedIdentity) process.exit(18);
fs.renameSync(published, quarantine);
if (identity(quarantine) !== expectedIdentity) process.exit(18);
const descriptor = fs.openSync(path.dirname(published), "r");
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
  verify_owner_directory "$quarantine" "$kind" "$token" "$identity"
}

owner_is_reclaimable() {
  local now
  lock_owner_is_live && return 1
  now="$(date +%s)"
  (( now >= OWNER_LEASE_UNTIL ))
}

cleanup_candidate() {
  local candidate="$1"
  [[ -n "$candidate" ]] || return 0
  cleanup_owned_directory "$candidate"
}

release_owned_directory() {
  local published="$1"
  local kind="$2"
  local token="$3"
  local identity="$4"
  local quarantine="$TARGET/.design-sharingan-${kind}-release.$token"
  quarantine_owner_directory "$published" "$quarantine" "$kind" "$token" "$identity"
  cleanup_owned_directory "$quarantine"
  sync_directories "$TARGET"
}

acquire_recovery_claim() {
  local status existing_token existing_identity quarantine
  prepare_owner_directory "claim" ".design-sharingan-claim-candidate"
  CLAIM_CANDIDATE="$PREPARED_DIRECTORY"
  local candidate_token="$PREPARED_TOKEN"
  local candidate_identity="$PREPARED_IDENTITY"
  test_hook "before-claim-publish"
  if publish_owner_directory "$CLAIM_CANDIDATE" "$CLAIM" "claim" "$candidate_token" "$candidate_identity"; then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -eq 0 ]]; then
    CLAIM_OWNED=1
    CLAIM_TOKEN="$candidate_token"
    CLAIM_IDENTITY="$candidate_identity"
    CLAIM_CANDIDATE=""
  fi
  test_hook "after-claim-publish-attempt"
  if [[ "$status" -eq 0 ]]; then
    verify_owner_directory "$CLAIM" "claim" "$CLAIM_TOKEN" "$CLAIM_IDENTITY"
    return 0
  fi
  [[ "$status" -eq 17 ]] || fail "could not publish recovery claim safely"

  read_owner_directory "$CLAIM" "claim" || fail "recovery claim owner record is invalid"
  existing_token="$OWNER_TOKEN"
  existing_identity="$OWNER_DIRECTORY_IDENTITY"
  if ! owner_is_reclaimable; then
    cleanup_candidate "$CLAIM_CANDIDATE"
    CLAIM_CANDIDATE=""
    if lock_owner_is_live; then
      fail "another live installer owns the recovery claim"
    fi
    fail "a changed recovery-claim owner remains leased"
  fi
  quarantine="$TARGET/.design-sharingan-claim-stale.$existing_token"
  quarantine_owner_directory "$CLAIM" "$quarantine" "claim" "$existing_token" "$existing_identity"
  if ! publish_owner_directory "$CLAIM_CANDIDATE" "$CLAIM" "claim" "$candidate_token" "$candidate_identity"; then
    cleanup_candidate "$CLAIM_CANDIDATE"
    CLAIM_CANDIDATE=""
    fail "another installer won recovery-claim publication"
  fi
  CLAIM_OWNED=1
  CLAIM_TOKEN="$candidate_token"
  CLAIM_IDENTITY="$candidate_identity"
  CLAIM_CANDIDATE=""
  cleanup_owned_directory "$quarantine"
  verify_owner_directory "$CLAIM" "claim" "$CLAIM_TOKEN" "$CLAIM_IDENTITY"
}

release_recovery_claim() {
  [[ "$CLAIM_OWNED" -eq 1 ]] || return 0
  release_owned_directory "$CLAIM" "claim" "$CLAIM_TOKEN" "$CLAIM_IDENTITY"
  CLAIM_OWNED=0
  CLAIM_TOKEN=""
  CLAIM_IDENTITY=""
}

recover_stale_lock() {
  local stale_lock="$1"
  LOCK="$stale_lock"
  OWNER="$LOCK/owner"
  JOURNAL="$LOCK/journal"
  cleanup_atomic_temps "$LOCK"
  if [[ -e "$JOURNAL" || -L "$JOURNAL" ]]; then
    recover_transaction
  fi
  cleanup_owned_directory "$LOCK"
}

cleanup_orphan_owner_directories() {
  local entry name kind now modified entries
  now="$(date +%s)"
  while IFS= read -r -d '' entry; do
    name="$(basename "$entry")"
    case "$name" in
      .design-sharingan-claim-candidate.*|.design-sharingan-claim-release.*|.design-sharingan-claim-stale.*)
        kind="claim"
        ;;
      .design-sharingan-lock-candidate.*|.design-sharingan-lock-release.*)
        kind="lock"
        ;;
      *) continue ;;
    esac
    [[ -d "$entry" && ! -L "$entry" ]] || fail "orphan owner path is not a regular directory"
    if [[ -e "$entry/owner" || -L "$entry/owner" ]]; then
      read_owner_directory "$entry" "$kind" || fail "orphan owner record is invalid"
      lock_owner_is_live && continue
      (( now >= OWNER_LEASE_UNTIL )) || continue
    else
      modified="$(directory_mtime "$entry")"
      (( now - modified >= LOCK_LEASE_SECONDS )) || continue
      cleanup_atomic_temps "$entry"
      entries="$(find "$entry" -mindepth 1 -maxdepth 1 -print)"
      [[ -z "$entries" ]] || fail "ownerless orphan directory contains unexpected state"
    fi
    cleanup_owned_directory "$entry"
  done < <(find "$TARGET" -mindepth 1 -maxdepth 1 -type d -name '.design-sharingan-*' -print0)
  sync_directories "$TARGET"
}

recover_orphaned_stale_lock() {
  local entry count=0
  while IFS= read -r -d '' entry; do
    count=$((count + 1))
    [[ "$count" -eq 1 ]] || fail "multiple stale install-lock transactions require manual recovery"
    read_owner_directory "$entry" "lock" || fail "stale install-lock owner record is invalid"
    recover_stale_lock "$entry"
  done < <(find "$TARGET" -mindepth 1 -maxdepth 1 -type d -name '.design-sharingan-lock-stale.*' -print0)
}

acquire_lock() {
  local recovered=0 existing_token existing_identity quarantine status
  acquire_recovery_claim
  cleanup_orphan_owner_directories
  recover_orphaned_stale_lock

  if [[ -e "$LOCK" || -L "$LOCK" ]]; then
    read_owner_directory "$LOCK" "lock" || fail "install lock owner record is invalid"
    existing_token="$OWNER_TOKEN"
    existing_identity="$OWNER_DIRECTORY_IDENTITY"
    if ! owner_is_reclaimable; then
      release_recovery_claim
      if lock_owner_is_live; then
        fail "another live Design Sharingan skill installation is in progress"
      fi
      fail "a changed install-lock owner remains leased"
    fi
    quarantine="$TARGET/.design-sharingan-lock-stale.$existing_token"
    quarantine_owner_directory "$LOCK" "$quarantine" "lock" "$existing_token" "$existing_identity"
    recover_stale_lock "$quarantine"
    recovered=1
  fi

  LOCK="$TARGET/.design-sharingan-install.lock"
  prepare_owner_directory "lock" ".design-sharingan-lock-candidate"
  LOCK_CANDIDATE="$PREPARED_DIRECTORY"
  LOCK_TOKEN="$PREPARED_TOKEN"
  LOCK_IDENTITY="$PREPARED_IDENTITY"
  test_hook "before-lock-publish"
  if publish_owner_directory "$LOCK_CANDIDATE" "$LOCK" "lock" "$LOCK_TOKEN" "$LOCK_IDENTITY"; then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -ne 0 ]]; then
    if [[ "$status" -eq 17 ]]; then
      read_owner_directory "$LOCK" "lock" || fail "competing install lock is not fully authenticated"
    fi
    cleanup_candidate "$LOCK_CANDIDATE"
    LOCK_CANDIDATE=""
    release_recovery_claim
    fail "another installer won install-lock publication"
  fi
  LOCK_OWNED=1
  LOCK_CANDIDATE=""
  OWNER="$LOCK/owner"
  JOURNAL="$LOCK/journal"
  test_hook "after-lock-publish-attempt"
  verify_owner_directory "$LOCK" "lock" "$LOCK_TOKEN" "$LOCK_IDENTITY"
  release_recovery_claim
  [[ "$recovered" -eq 0 ]] || test_hook "after-stale-recovery"
  test_hook "lock-acquired"
}

finish() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [[ "$LOCK_OWNED" -eq 1 ]]; then
    verify_owner_directory "$LOCK" "lock" "$LOCK_TOKEN" "$LOCK_IDENTITY"
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
    release_owned_directory "$LOCK" "lock" "$LOCK_TOKEN" "$LOCK_IDENTITY"
    LOCK_OWNED=0
  fi
  release_recovery_claim
  cleanup_candidate "$LOCK_CANDIDATE"
  cleanup_candidate "$CLAIM_CANDIDATE"
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
CLAIM="$TARGET/.design-sharingan-install.claim"
OWNER="$LOCK/owner"
JOURNAL="$LOCK/journal"
acquire_lock

TRANSACTION="$(random_transaction_id)"
STAGE="$TARGET/.design-sharingan-stage.$TRANSACTION"
BACKUP="$TARGET/.design-sharingan-backup.$TRANSACTION"
DISCARD="$TARGET/.design-sharingan-discard.$TRANSACTION"
PHASE="ACTIVE"
write_journal
test_hook "after-journal-created"
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
