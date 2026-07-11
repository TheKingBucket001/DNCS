#!/usr/bin/env sh
set -eu

ROOT=$(cd -- "$(dirname -- "$0")/../.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/dncs-core-test.XXXXXX")
MOD=$TMP/module
BIN=$TMP/bin
STATE=$TMP/iptables-state
mkdir -p "$MOD/scripts" "$MOD/webroot" "$BIN" "$STATE"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

STUB_SH=${DNCS_TEST_SH:-/bin/sh}
[ -z "${DNCS_TEST_SH:-}" ] && [ -x /system/bin/sh ] && STUB_SH=/system/bin/sh
cp "$ROOT/module/scripts/core.sh" "$MOD/scripts/core.sh"
chmod +x "$MOD/scripts/core.sh"

printf '#!%s\n' "$STUB_SH" > "$BIN/cmd"
cat >> "$BIN/cmd" <<'STUB'
if [ "${REQUIRE_PIPE_STDOUT:-0}" = 1 ]; then
  stdout_target=$(readlink "/proc/$$/fd/1" 2>/dev/null || printf unknown)
  case "$stdout_target" in
    pipe:*) ;;
    *) exit 43 ;;
  esac
fi
if [ "$1 $2 $3" = "package list users" ]; then
  [ "${FAIL_USERS:-0}" = 1 ] && exit 41
  if [ "${SLOW_USERS:-0}" = 1 ] && [ ! -e "$SLOW_USERS_ONCE" ]; then
    : > "$SLOW_USERS_ONCE"
    : > "$SLOW_USERS_MARKER"
    sleep 3
  fi
  printf 'Users:\n\tUserInfo{0:Owner:13} running\n\tUserInfo{10:Clone:30} running\n'
  exit 0
fi
if [ "$1 $2 $3" = "package list packages" ]; then
  case "$*" in
    *"--user 10"*) [ "${FAIL_USER_10:-0}" = 1 ] && exit 42 ;;
  esac
  case "$*" in
    *"-3 --user 0 -U"*) printf 'package:com.user.alpha uid:10123\npackage:com.user.shared.a uid:10150\npackage:com.user.shared.b uid:10150\n' ;;
    *"-s --user 0 -U"*) printf 'package:android uid:1000\npackage:com.android.phone uid:1001\npackage:com.shared.a uid:1000\npackage:com.shared.b uid:1000\n' ;;
    *"-3 --user 10 -U"*) printf 'package:com.user.alpha uid:110123\n' ;;
    *"-s --user 10 -U"*) printf 'package:android uid:100000\n' ;;
    *"-U --user 0"*) printf 'package:com.user.alpha uid:10123\npackage:com.user.shared.a uid:10150\npackage:com.user.shared.b uid:10150\npackage:android uid:1000\npackage:com.android.phone uid:1001\npackage:com.shared.a uid:1000\npackage:com.shared.b uid:1000\n' ;;
    *"-U --user 10"*) printf 'package:com.user.alpha uid:110123\npackage:android uid:100000\n' ;;
  esac
  exit 0
fi
exit 1
STUB

printf '#!%s\n' "$STUB_SH" > "$BIN/iptables"
cat >> "$BIN/iptables" <<'STUB'
name=${0##*/}
case "$name" in ip6*) family=6 ;; *) family=4 ;; esac
chain="$IPT_STATE_DIR/$family.chain"
jump="$IPT_STATE_DIR/$family.jump"
rules="$IPT_STATE_DIR/$family.rules"
if [ "${KILL_PARENT_ON_START:-0}" = 1 ] && [ ! -e "$KILL_PARENT_ONCE" ]; then
  : > "$KILL_PARENT_ONCE"
  printf '%s\n' "$$" > "$KILL_PARENT_MARKER"
  kill -KILL "$PPID" 2>/dev/null || exit 97
  sleep 3
  : > "$KILL_PARENT_DONE"
  exit 0
fi
if [ "${1:-}" = "-w" ]; then shift 2; fi
case "${1:-}" in
  -S)
    [ "${FAIL_QUERY:-0}" = 1 ] && { echo 'forced rules query failure' >&2; exit 4; }
    printf '%s\n' '-P OUTPUT ACCEPT'
    [ -f "$chain" ] && printf '%s\n' '-N DNCS_BLOCK'
    [ -f "$jump" ] && printf '%s\n' '-A OUTPUT -j DNCS_BLOCK'
    [ -f "$rules" ] && while IFS= read -r uid; do
      [ -n "$uid" ] && printf '%s\n' "-A DNCS_BLOCK -m owner --uid-owner $uid -j REJECT"
    done < "$rules"
    exit 0
    ;;
  -nL) [ -f "$chain" ] ; exit $? ;;
  -N) touch "$chain"; exit 0 ;;
  -C) [ -f "$jump" ]; exit $? ;;
  -I) touch "$chain" "$jump"; exit 0 ;;
  -D)
    if [ -f "$jump" ]; then rm -f "$jump"; exit 0; fi
    exit 1
    ;;
  -F)
    [ "${FAIL_RESCUE:-0}" = 1 ] && exit 5
    [ "$family" = 4 ] && [ "${FAIL_RESCUE4:-0}" = 1 ] && exit 5
    [ "$family" = 6 ] && [ "${FAIL_RESCUE6:-0}" = 1 ] && exit 5
    if [ "$family" = 6 ] && [ "${DELAY_RESCUE6:-0}" = 1 ] && [ ! -e "$DELAY_RESCUE6_ONCE" ]; then
      : > "$DELAY_RESCUE6_ONCE"
      printf '%s\n' "$$" > "$DELAY_RESCUE6_MARKER"
      sleep 3
    fi
    [ -f "$chain" ] || exit 1
    : > "$rules"
    exit 0
    ;;
  -X)
    [ "${FAIL_RESCUE:-0}" = 1 ] && exit 5
    [ "$family" = 4 ] && [ "${FAIL_RESCUE4:-0}" = 1 ] && exit 5
    [ "$family" = 6 ] && [ "${FAIL_RESCUE6:-0}" = 1 ] && exit 5
    [ -f "$chain" ] || exit 1
    [ ! -f "$jump" ] || exit 1
    rm -f "$chain" "$rules"
    exit 0
    ;;
esac
exit 1
STUB
cp "$BIN/iptables" "$BIN/ip6tables"

printf '#!%s\n' "$STUB_SH" > "$BIN/iptables-restore"
cat >> "$BIN/iptables-restore" <<'STUB'
name=${0##*/}
case "$name" in ip6*) family=6 ;; *) family=4 ;; esac
case "${1:-}" in
  --help|-h) printf 'Usage: restore [-t] [--test] [--noflush]\n'; exit 0 ;;
esac
is_test=0
for arg in "$@"; do
  case "$arg" in -t|--test) is_test=1 ;; esac
done
incoming="$IPT_STATE_DIR/$family.incoming"
cat > "$incoming"
if [ "$is_test" = 0 ] && [ -n "${COMMIT_TRACE:-}" ]; then
  trace_uids=$(awk '
    /--uid-owner/ {
      for (i = 1; i <= NF; i++) if ($i == "--uid-owner") {
        printf "%s%s", separator, $(i + 1)
        separator = ","
      }
    }
    END { print "" }
  ' "$incoming")
  printf '%s:%s\n' "$family" "$trace_uids" >> "$COMMIT_TRACE"
fi
if [ "$family" = 4 ] && [ "${FAIL_V4:-0}" = 1 ]; then
  echo 'forced IPv4 restore failure' >&2
  exit 1
fi
if [ "$family" = 4 ] && [ "${FAIL_V4_COMMIT:-0}" = 1 ] && [ "$is_test" = 0 ]; then
  echo 'forced IPv4 commit failure' >&2
  exit 1
fi
if [ "$family" = 6 ] && [ "${FAIL_V6_PREFLIGHT:-0}" = 1 ] && [ "$is_test" = 1 ]; then
  echo 'forced IPv6 preflight failure' >&2
  exit 1
fi
if [ "$family" = 6 ] && [ "${FAIL_V6_COMMIT:-0}" = 1 ] && [ "$is_test" = 0 ]; then
  echo 'forced IPv6 restore failure' >&2
  exit 1
fi
[ "$is_test" = 1 ] && exit 0
if [ "$family" = 4 ] && [ "${DELAY_V4_COMMIT:-0}" = 1 ] && [ ! -e "$DELAY_ONCE_FILE" ]; then
  : > "$DELAY_ONCE_FILE"
  printf '%s\n' "$$" > "$DELAY_MARKER"
  sleep 3
fi
target="$TMP_RESTORE4"
[ "$family" = 6 ] && target="$TMP_RESTORE6"
cp "$incoming" "$target"
awk '/--uid-owner/ { for (i=1; i<=NF; i++) if ($i == "--uid-owner") print $(i+1) }' "$incoming" > "$IPT_STATE_DIR/$family.rules"
touch "$IPT_STATE_DIR/$family.chain" "$IPT_STATE_DIR/$family.jump"
exit 0
STUB
cp "$BIN/iptables-restore" "$BIN/ip6tables-restore"
chmod +x "$BIN"/*

export PATH="$BIN:$PATH"
export IPT_STATE_DIR="$STATE"
export TMP_RESTORE4="$TMP/restore4.txt"
export TMP_RESTORE6="$TMP/restore6.txt"
export DNCS_CMD_PACKAGE_CMD="$BIN/cmd"
export DNCS_IPTABLES_CMD="$BIN/iptables"
export DNCS_IP6TABLES_CMD="$BIN/ip6tables"
export DNCS_IPTABLES_RESTORE_CMD="$BIN/iptables-restore"
export DNCS_IP6TABLES_RESTORE_CMD="$BIN/ip6tables-restore"
export DNCS_BACKUP_DIR="$TMP/Download"
export DELAY_ONCE_FILE="$TMP/delay-once"
export DELAY_MARKER="$TMP/delay-marker"
export SLOW_USERS_ONCE="$TMP/slow-users-once"
export SLOW_USERS_MARKER="$TMP/slow-users-marker"
export DELAY_RESCUE6_ONCE="$TMP/delay-rescue6-once"
export DELAY_RESCUE6_MARKER="$TMP/delay-rescue6-marker"
export COMMIT_TRACE="$TMP/commit-trace"
export KILL_PARENT_ONCE="$TMP/kill-parent-once"
export KILL_PARENT_MARKER="$TMP/kill-parent-marker"
export KILL_PARENT_DONE="$TMP/kill-parent-done"
export REQUIRE_PIPE_STDOUT=1

out=$(sh "$MOD/scripts/core.sh" list)
[ "$out" = READY ]
grep -q 'com.user.alpha|10123|user|0' "$MOD/webroot/apps.txt"
grep -q 'com.user.alpha .*|110123|user|0' "$MOD/webroot/apps.txt"
grep -q 'com.user.alpha|10123|user|0|0|com.user.alpha' "$MOD/webroot/apps.txt"
grep -q 'com.user.alpha .*|110123|user|0|10|com.user.alpha' "$MOD/webroot/apps.txt"
grep -q 'com.shared.a|1000|shared|0' "$MOD/webroot/apps.txt"
grep -q 'com.user.shared.a|10150|shared|0' "$MOD/webroot/apps.txt"
grep -q 'com.user.shared.b|10150|shared|0' "$MOD/webroot/apps.txt"
[ ! -e "$MOD/webroot/apps.txt.tmp" ]

out=$(sh "$MOD/scripts/core.sh" apply 10123 999999 10123)
[ "$out" = 'SUCCESS:1:2:10123' ]
grep -qx '10123' "$MOD/scripts/blocked.conf"
if grep -q '999999' "$MOD/scripts/blocked.conf"; then exit 1; fi
grep -q -- '--uid-owner 10123' "$TMP_RESTORE4"

mkdir -p "$TMP/modules_update/dncs"
set +e
out=$(DNCS_UPDATE_MODULE_DIR="$TMP/modules_update/dncs" sh "$MOD/scripts/core.sh" apply 1000 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = UPDATE_PENDING ]
grep -qx '10123' "$MOD/scripts/blocked.conf"
rm -rf "$TMP/modules_update"

rm -f "$DELAY_ONCE_FILE" "$DELAY_MARKER"
DELAY_V4_COMMIT=1 sh "$MOD/scripts/core.sh" apply 1000 > "$TMP/signal-apply.out" 2>&1 &
SIGNAL_CORE_PID=$!
signal_wait=0
while [ ! -s "$DELAY_MARKER" ] && [ "$signal_wait" -lt 50 ]; do
  sleep 0.1
  signal_wait=$((signal_wait + 1))
done
[ -s "$DELAY_MARKER" ]
kill -TERM "$SIGNAL_CORE_PID"
set +e
wait "$SIGNAL_CORE_PID"
signal_rc=$?
set -e
[ "$signal_rc" -ne 0 ]
sleep 0.2
grep -qx '10123' "$MOD/scripts/blocked.conf"
grep -qx '10123' "$STATE/4.rules"
grep -qx '10123' "$STATE/6.rules"
[ ! -e "$MOD/scripts/.dncs.txn" ]

set +e
out=$(sh "$MOD/scripts/core.sh" apply invalid 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = INVALID_UID ]
grep -qx '10123' "$MOD/scripts/blocked.conf"

set +e
out=$(sh "$MOD/scripts/core.sh" apply 2147483648 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = INVALID_UID ]
grep -qx '10123' "$MOD/scripts/blocked.conf"

out=$(sh "$MOD/scripts/core.sh" backup_config)
case "$out" in
  BACKUP:"$DNCS_BACKUP_DIR"/dncs-*.config) ;;
  *) echo "unexpected backup output: $out" >&2; exit 1 ;;
esac
backup_path=${out#BACKUP:}
[ -f "$backup_path" ]
grep -qx 'DNCS_CONFIG_V2' "$backup_path"
grep -qx 'uid=10123' "$backup_path"
grep -qx 'app=0|com.user.alpha' "$backup_path"
grep -qx '# unresolved_uids=0' "$backup_path"
if ls "$MOD/scripts"/config_uids.* >/dev/null 2>&1; then exit 1; fi
if ls "$DNCS_BACKUP_DIR"/.dncs-backup-*.tmp >/dev/null 2>&1; then exit 1; fi

set +e
out=$(FAIL_USER_10=1 sh "$MOD/scripts/core.sh" backup_config 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = BACKUP_FAILED ]
grep -qx '10123' "$MOD/scripts/blocked.conf"
if ls "$DNCS_BACKUP_DIR"/.dncs-backup-*.tmp >/dev/null 2>&1; then exit 1; fi

printf '999999\n' > "$MOD/scripts/blocked.conf"
out=$(sh "$MOD/scripts/core.sh" backup_config)
unresolved_backup=${out#BACKUP:}
grep -qx 'uid=999999' "$unresolved_backup"
grep -qx '# unresolved_uids=1' "$unresolved_backup"
if grep -q '^app=' "$unresolved_backup"; then exit 1; fi
printf '10123\n' > "$MOD/scripts/blocked.conf"

cp "$MOD/webroot/apps.txt" "$TMP/apps.before"
set +e
out=$(FAIL_USER_10=1 sh "$MOD/scripts/core.sh" list 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = LIST_FAILED ]
cmp "$TMP/apps.before" "$MOD/webroot/apps.txt"

set +e
out=$(FAIL_USER_10=1 sh "$MOD/scripts/core.sh" apply 1000 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = PMS_ERROR ]
grep -qx '10123' "$MOD/scripts/blocked.conf"

set +e
out=$(FAIL_V6_COMMIT=1 sh "$MOD/scripts/core.sh" apply 1000 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = FAIL ]
grep -qx '10123' "$MOD/scripts/blocked.conf"
grep -q 'Transaction ERROR: IPv6 Failed' "$MOD/webroot/dncs.log"
[ -f "$MOD/scripts/.dncs.txn" ]

out=$(sh "$MOD/scripts/core.sh" list)
[ "$out" = READY ]
[ ! -e "$MOD/scripts/.dncs.txn" ]
grep -qx '10123' "$STATE/4.rules"
grep -qx '10123' "$STATE/6.rules"

: > "$COMMIT_TRACE"
set +e
out=$(FAIL_V4_COMMIT=1 sh "$MOD/scripts/core.sh" apply 1000 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = FAIL ]
grep -qx '10123' "$STATE/4.rules"
grep -qx '10123' "$STATE/6.rules"
[ -f "$MOD/scripts/.dncs.txn" ]
if grep -qx '6:1000' "$COMMIT_TRACE"; then exit 1; fi

out=$(sh "$MOD/scripts/core.sh" list)
[ "$out" = READY ]
[ ! -e "$MOD/scripts/.dncs.txn" ]
grep -q -- '--uid-owner 10123' "$TMP_RESTORE4"
grep -q -- '--uid-owner 10123' "$TMP_RESTORE6"

rm -f "$DELAY_ONCE_FILE" "$DELAY_MARKER"
DELAY_V4_COMMIT=1 sh "$MOD/scripts/core.sh" apply 1000 > "$TMP/killed-apply.out" 2>&1 &
KILLED_APPLY_PID=$!
kill_wait=0
while [ ! -s "$DELAY_MARKER" ] && [ "$kill_wait" -lt 50 ]; do
  sleep 0.1
  kill_wait=$((kill_wait + 1))
done
[ -s "$DELAY_MARKER" ]
kill -KILL "$KILLED_APPLY_PID"
set +e
wait "$KILLED_APPLY_PID" 2>/dev/null
killed_apply_rc=$?
set -e
[ "$killed_apply_rc" -ne 0 ]
grep -qx '10123' "$MOD/scripts/blocked.conf"
[ -f "$MOD/scripts/.dncs.txn" ]
[ -d "$MOD/scripts/.dncs.lock" ]
wait_started=$(date +%s)
out=$(DNCS_LOCK_WAIT_SECONDS=8 sh "$MOD/scripts/core.sh" list)
wait_elapsed=$(( $(date +%s) - wait_started ))
[ "$out" = READY ]
[ "$wait_elapsed" -ge 2 ]
[ ! -e "$MOD/scripts/.dncs.txn" ]
[ ! -e "$MOD/scripts/.dncs.lock" ]
grep -qx '10123' "$STATE/4.rules"
grep -qx '10123' "$STATE/6.rules"

rm -f "$KILL_PARENT_ONCE" "$KILL_PARENT_MARKER" "$KILL_PARENT_DONE"
KILL_PARENT_ON_START=1 sh "$MOD/scripts/core.sh" boot_apply > "$TMP/child-start-kill.out" 2>&1 &
CHILD_START_PARENT_PID=$!
kill_wait=0
while [ ! -s "$KILL_PARENT_MARKER" ] && [ "$kill_wait" -lt 50 ]; do
  sleep 0.1
  kill_wait=$((kill_wait + 1))
done
[ -s "$KILL_PARENT_MARKER" ]
set +e
wait "$CHILD_START_PARENT_PID" 2>/dev/null
child_start_parent_rc=$?
set -e
[ "$child_start_parent_rc" -ne 0 ]
active_child_pid=$(cat "$KILL_PARENT_MARKER")
recorded_child_pid=$(sed -n 's/^pid=//p' "$MOD/scripts/.dncs.lock/child" | head -n 1)
[ "$recorded_child_pid" = "$active_child_pid" ]
[ -f "$MOD/scripts/.dncs.txn" ]
[ -d "$MOD/scripts/.dncs.lock" ]
wait_started=$(date +%s)
out=$(DNCS_LOCK_WAIT_SECONDS=8 sh "$MOD/scripts/core.sh" list)
wait_elapsed=$(( $(date +%s) - wait_started ))
[ "$out" = READY ]
[ "$wait_elapsed" -ge 2 ]
[ -e "$KILL_PARENT_DONE" ]
[ ! -e "$MOD/scripts/.dncs.txn" ]
[ ! -e "$MOD/scripts/.dncs.lock" ]
grep -qx '10123' "$STATE/4.rules"
grep -qx '10123' "$STATE/6.rules"

printf '10123\n' > "$MOD/scripts/blocked.conf"
sh "$MOD/scripts/core.sh" boot_apply
set +e
out=$(DNCS_IP6TABLES_CMD="$BIN/ip6tables-missing" sh "$MOD/scripts/core.sh" rescue 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = RESCUE_FAILED ]
grep -qx '10123' "$MOD/scripts/blocked.conf"
[ -f "$STATE/4.jump" ]
[ -f "$STATE/6.jump" ]
grep -qx '10123' "$STATE/4.rules"
grep -qx '10123' "$STATE/6.rules"
[ ! -e "$MOD/scripts/.dncs.txn" ]

set +e
out=$(FAIL_QUERY=1 sh "$MOD/scripts/core.sh" rescue 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = RESCUE_FAILED ]
grep -qx '10123' "$MOD/scripts/blocked.conf"
[ -f "$STATE/4.jump" ]
[ -f "$STATE/6.jump" ]
[ ! -e "$MOD/scripts/.dncs.txn" ]
grep -qx '10123' "$STATE/4.rules"
grep -qx '10123' "$STATE/6.rules"

set +e
out=$(FAIL_RESCUE4=1 sh "$MOD/scripts/core.sh" rescue 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = RESCUE_FAILED ]
grep -qx '10123' "$MOD/scripts/blocked.conf"
[ ! -e "$MOD/scripts/.dncs.txn" ]
[ -f "$STATE/4.jump" ]
[ -f "$STATE/6.jump" ]
grep -qx '10123' "$STATE/4.rules"
grep -qx '10123' "$STATE/6.rules"

set +e
out=$(FAIL_RESCUE6=1 sh "$MOD/scripts/core.sh" rescue 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = RESCUE_FAILED ]
grep -qx '10123' "$MOD/scripts/blocked.conf"
[ ! -e "$MOD/scripts/.dncs.txn" ]
[ -f "$STATE/4.jump" ]
[ -f "$STATE/6.jump" ]
grep -qx '10123' "$STATE/4.rules"
grep -qx '10123' "$STATE/6.rules"

rm -f "$DELAY_RESCUE6_ONCE" "$DELAY_RESCUE6_MARKER"
DELAY_RESCUE6=1 sh "$MOD/scripts/core.sh" rescue > "$TMP/killed-rescue.out" 2>&1 &
KILLED_RESCUE_PID=$!
kill_wait=0
while [ ! -s "$DELAY_RESCUE6_MARKER" ] && [ "$kill_wait" -lt 50 ]; do
  sleep 0.1
  kill_wait=$((kill_wait + 1))
done
[ -s "$DELAY_RESCUE6_MARKER" ]
kill -KILL "$KILLED_RESCUE_PID"
set +e
wait "$KILLED_RESCUE_PID" 2>/dev/null
killed_rescue_rc=$?
set -e
[ "$killed_rescue_rc" -ne 0 ]
grep -qx '10123' "$MOD/scripts/blocked.conf"
[ -f "$MOD/scripts/.dncs.txn" ]
[ -d "$MOD/scripts/.dncs.lock" ]
wait_started=$(date +%s)
out=$(DNCS_LOCK_WAIT_SECONDS=8 sh "$MOD/scripts/core.sh" list)
wait_elapsed=$(( $(date +%s) - wait_started ))
[ "$out" = READY ]
[ "$wait_elapsed" -ge 2 ]
[ ! -e "$MOD/scripts/.dncs.txn" ]
[ ! -e "$MOD/scripts/.dncs.lock" ]
[ -f "$STATE/4.jump" ]
[ -f "$STATE/6.jump" ]
grep -qx '10123' "$STATE/4.rules"
grep -qx '10123' "$STATE/6.rules"

out=$(sh "$MOD/scripts/core.sh" rescue)
[ "$out" = RESCUED ]
[ ! -s "$MOD/scripts/blocked.conf" ]
[ ! -f "$STATE/4.chain" ]
[ ! -f "$STATE/6.chain" ]

rm -f "$SLOW_USERS_ONCE" "$SLOW_USERS_MARKER" "$MOD/webroot/apps.txt"
SLOW_USERS=1 sh "$MOD/scripts/core.sh" list > "$TMP/killed-list.out" 2>&1 &
KILLED_LIST_PID=$!
kill_wait=0
while [ ! -e "$SLOW_USERS_MARKER" ] && [ "$kill_wait" -lt 50 ]; do
  sleep 0.1
  kill_wait=$((kill_wait + 1))
done
[ -e "$SLOW_USERS_MARKER" ]
kill -KILL "$KILLED_LIST_PID"
set +e
wait "$KILLED_LIST_PID" 2>/dev/null
killed_list_rc=$?
set -e
[ "$killed_list_rc" -ne 0 ]
[ ! -e "$MOD/webroot/apps.txt" ]
[ -d "$MOD/scripts/.dncs.lock" ]
wait_started=$(date +%s)
out=$(DNCS_LOCK_WAIT_SECONDS=8 sh "$MOD/scripts/core.sh" list)
wait_elapsed=$(( $(date +%s) - wait_started ))
[ "$out" = READY ]
[ "$wait_elapsed" -ge 2 ]
[ -f "$MOD/webroot/apps.txt" ]
[ ! -e "$MOD/scripts/.dncs.lock" ]

mkdir -p "$MOD/scripts/.dncs.lock" \
  "$MOD/scripts/.dncs.lock.stale.test" \
  "$MOD/scripts/.dncs.lock.release.test" \
  "$MOD/scripts/.preserve.snapshot.test"
cat > "$MOD/scripts/.dncs.lock/owner" <<EOF
token=stale
pid=99999999
start=1
action=list
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf unknown)
stamp=0
EOF
out=$(DNCS_LOCK_INIT_GRACE_SECONDS=0 sh "$MOD/scripts/core.sh" list)
[ "$out" = READY ]
[ ! -e "$MOD/scripts/.dncs.lock" ]
[ ! -e "$MOD/scripts/.dncs.lock.stale.test" ]
[ ! -e "$MOD/scripts/.dncs.lock.release.test" ]
[ ! -e "$MOD/scripts/.preserve.snapshot.test" ]

rm -f "$SLOW_USERS_ONCE" "$SLOW_USERS_MARKER"
SLOW_USERS=1 sh "$MOD/scripts/core.sh" list > "$TMP/slow-list.out" 2>&1 &
LOCK_OWNER_PID=$!
lock_wait=0
while [ ! -e "$SLOW_USERS_MARKER" ] && [ "$lock_wait" -lt 50 ]; do
  sleep 0.1
  lock_wait=$((lock_wait + 1))
done
[ -e "$SLOW_USERS_MARKER" ]
set +e
out=$(DNCS_LOCK_WAIT_SECONDS=1 sh "$MOD/scripts/core.sh" list 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = LOCKED ]
wait "$LOCK_OWNER_PID"

rm -f "$SLOW_USERS_ONCE" "$SLOW_USERS_MARKER"
SLOW_USERS=1 sh "$MOD/scripts/core.sh" list > "$TMP/update-lock-owner.out" 2>&1 &
UPDATE_LOCK_OWNER=$!
update_wait=0
while [ ! -e "$SLOW_USERS_MARKER" ] && [ "$update_wait" -lt 50 ]; do
  sleep 0.1
  update_wait=$((update_wait + 1))
done
[ -e "$SLOW_USERS_MARKER" ]
DNCS_LOCK_WAIT_SECONDS=8 DNCS_UPDATE_MODULE_DIR="$TMP/modules_update/dncs" \
  sh "$MOD/scripts/core.sh" apply 1000 > "$TMP/update-wait.out" 2>&1 &
UPDATE_WAITER=$!
sleep 0.2
mkdir -p "$TMP/modules_update/dncs"
wait "$UPDATE_LOCK_OWNER"
set +e
wait "$UPDATE_WAITER"
update_waiter_rc=$?
set -e
[ "$update_waiter_rc" -ne 0 ]
[ "$(cat "$TMP/update-wait.out")" = UPDATE_PENDING ]
rm -rf "$TMP/modules_update"

printf '%150s' 'x' > "$MOD/webroot/dncs.log"
: > "$MOD/scripts/debug.flag"
out=$(DNCS_LOG_MAX_BYTES=100 sh "$MOD/scripts/core.sh" toggle_debug)
[ "$out" = DEBUG_OFF ]
[ -f "$MOD/webroot/dncs.log.old" ]
grep -q '调试关闭' "$MOD/webroot/dncs.log"
out=$(sh "$MOD/scripts/core.sh" clear_log)
[ "$out" = LOG_CLEARED ]
[ ! -s "$MOD/webroot/dncs.log" ]
[ ! -e "$MOD/webroot/dncs.log.old" ]

OLD_MOD="$TMP/old/dncs"
NEW_MOD="$TMP/new/dncs"
mkdir -p "$OLD_MOD/scripts" "$OLD_MOD/webroot" "$NEW_MOD/scripts" "$NEW_MOD/webroot"
printf '10123\n1000\n' > "$OLD_MOD/scripts/blocked.conf"
printf '1000\n' > "$OLD_MOD/scripts/blocked.conf.bak"
: > "$OLD_MOD/scripts/debug.flag"
printf 'old log\n' > "$OLD_MOD/webroot/dncs.log"
cp "$ROOT/module/scripts/core.sh" "$OLD_MOD/scripts/core.sh"
chmod +x "$OLD_MOD/scripts/core.sh"
: > "$NEW_MOD/scripts/blocked.conf"
mkdir -p "$NEW_MOD/scripts/.preserve.snapshot.stale"
: > "$NEW_MOD/scripts/blocked.conf.preserve.stale"
MODPATH="$NEW_MOD" DNCS_OLD_MODULE_DIR="$OLD_MOD" sh "$ROOT/module/customize.sh"
cmp "$OLD_MOD/scripts/blocked.conf" "$NEW_MOD/scripts/blocked.conf"
cmp "$OLD_MOD/scripts/blocked.conf.bak" "$NEW_MOD/scripts/blocked.conf.bak"
cmp "$OLD_MOD/webroot/dncs.log" "$NEW_MOD/webroot/dncs.log"
[ -f "$NEW_MOD/scripts/debug.flag" ]
[ ! -e "$NEW_MOD/scripts/.preserve.snapshot.stale" ]
[ ! -e "$NEW_MOD/scripts/blocked.conf.preserve.stale" ]

UNINSTALL_MOD="$TMP/uninstall/dncs"
mkdir -p "$UNINSTALL_MOD/scripts"
cp "$ROOT/module/uninstall.sh" "$UNINSTALL_MOD/uninstall.sh"
printf '#!%s\nexit 7\n' "$STUB_SH" > "$UNINSTALL_MOD/scripts/core.sh"
chmod +x "$UNINSTALL_MOD/scripts/core.sh"
set +e
DNCS_UNINSTALL_FAIL_LOG="$TMP/uninstall-error.log" sh "$UNINSTALL_MOD/uninstall.sh" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ]

rm -f "$UNINSTALL_MOD/scripts/core.sh"
set +e
DNCS_UNINSTALL_FAIL_LOG="$TMP/uninstall-error.log" sh "$UNINSTALL_MOD/uninstall.sh" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ]
grep -q 'core is missing' "$TMP/uninstall-error.log"

SERVICE_MOD="$TMP/service/dncs"
mkdir -p "$SERVICE_MOD/scripts" "$SERVICE_MOD/webroot"
cp "$ROOT/module/service.sh" "$SERVICE_MOD/service.sh"
printf '10123\n' > "$SERVICE_MOD/scripts/blocked.conf"
: > "$SERVICE_MOD/webroot/dncs.log"
cat > "$SERVICE_MOD/scripts/core.sh" <<STUB
#!$STUB_SH
count=0
[ -f "$TMP/service-count" ] && count=\$(cat "$TMP/service-count")
count=\$((count + 1))
printf '%s\n' "\$count" > "$TMP/service-count"
if [ "\$count" -ge 3 ]; then
  : > "\$SERVICE_RULE_FILE"
  exit 0
fi
exit 1
STUB
chmod +x "$SERVICE_MOD/scripts/core.sh"
cat > "$BIN/getprop-test" <<'STUB'
#!/system/bin/sh
[ ! -e "$SERVICE_WIPE_MARKER" ] && {
  rm -f "$SERVICE_RULE_FILE"
  : > "$SERVICE_WIPE_MARKER"
}
[ "$1" = sys.boot_completed ] && printf '1\n'
STUB
chmod +x "$BIN/getprop-test"
SERVICE_RULE_FILE="$TMP/service-rule" \
SERVICE_WIPE_MARKER="$TMP/service-wipe-marker" \
DNCS_GETPROP_CMD="$BIN/getprop-test" \
  sh "$SERVICE_MOD/service.sh"
tries=0
while [ "${tries}" -lt 80 ]; do
  [ "$(cat "$TMP/service-count" 2>/dev/null || printf 0)" -ge 4 ] && break
  tries=$((tries + 1))
  sleep 0.1
done
[ "$(cat "$TMP/service-count")" -eq 4 ]
[ -f "$TMP/service-rule" ]

out=$(sh "$MOD/scripts/core.sh" lifecycle_error service-final)
[ "$out" = LOGGED ]
grep -q 'service final boot_apply failed after 15 attempts' "$MOD/webroot/dncs.log"
set +e
out=$(sh "$MOD/scripts/core.sh" lifecycle_error invalid 2>/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$out" = INVALID_EVENT ]

printf 'core stub tests passed\n'
