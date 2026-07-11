#!/system/bin/sh
umask 077

PATH="/data/adb/ksu/bin:/data/adb/ap/bin:/data/adb/magisk:/system/bin:/system/xbin:/vendor/bin:/product/bin:$PATH"
export PATH

ACTION=${1:-}
[ $# -gt 0 ] && shift

case "$0" in
  */*) _src_dir=${0%/*} ;;
  *) _src_dir=. ;;
esac
SCRIPT_DIR=$(cd "$_src_dir" 2>/dev/null && pwd)
MODULE_DIR=${SCRIPT_DIR%/*}
CONF_FILE="$SCRIPT_DIR/blocked.conf"
CONF_BAK="$SCRIPT_DIR/blocked.conf.bak"
WEB_APPS="$MODULE_DIR/webroot/apps.txt"
LOG_FILE="$MODULE_DIR/webroot/dncs.log"
DEBUG_FLAG="$SCRIPT_DIR/debug.flag"
BOOT_INFO_MARK="$SCRIPT_DIR/boot-info.mark"
LOCK_FILE="$SCRIPT_DIR/.dncs.lock"
TXN_FILE="$SCRIPT_DIR/.dncs.txn"
UPDATE_MODULE_DIR=${DNCS_UPDATE_MODULE_DIR:-/data/adb/modules_update/dncs}
CHAIN_NAME="DNCS_BLOCK"
CONFIG_MAGIC="DNCS_CONFIG_V2"
TIME_FMT='+%m-%d %H:%M:%S.%3N'
LOCK_WAIT_SECONDS=${DNCS_LOCK_WAIT_SECONDS:-30}
LOG_MAX_BYTES=${DNCS_LOG_MAX_BYTES:-524288}
BACKUP_TMP_PATH=
ACTIVE_CHILD_PID=
ACTIVE_CHILD_GATE=
CHILD_GATE_SEQ=0
LOCK_TOKEN=
LOCK_ACQUIRED=0
LOCK_INIT_GRACE_SECONDS=${DNCS_LOCK_INIT_GRACE_SECONDS:-3}
ACTION_LOCK_ACTIVE=0

IPTABLES_CMD=${DNCS_IPTABLES_CMD:-iptables}
IP6TABLES_CMD=${DNCS_IP6TABLES_CMD:-ip6tables}
IPTABLES_RESTORE_CMD=${DNCS_IPTABLES_RESTORE_CMD:-iptables-restore}
IP6TABLES_RESTORE_CMD=${DNCS_IP6TABLES_RESTORE_CMD:-ip6tables-restore}
CMD_PACKAGE_CMD=${DNCS_CMD_PACKAGE_CMD:-cmd}

init_runtime() {
  [ -n "$SCRIPT_DIR" ] || return 1
  [ -d "$SCRIPT_DIR" ] || mkdir -p "$SCRIPT_DIR" 2>/dev/null || return 1
  [ -d "$MODULE_DIR/webroot" ] || mkdir -p "$MODULE_DIR/webroot" 2>/dev/null || return 1
  [ ! -d "$CONF_FILE" ] || return 1
  [ ! -d "$LOG_FILE" ] || return 1
  [ -f "$CONF_FILE" ] || : > "$CONF_FILE" || return 1
  [ -f "$LOG_FILE" ] || : > "$LOG_FILE" || return 1
  chmod 600 "$CONF_FILE" 2>/dev/null || return 1
  chmod 644 "$LOG_FILE" 2>/dev/null || return 1
  return 0
}

now_text() {
  date "$TIME_FMT" 2>/dev/null || date '+%m-%d %H:%M:%S'
}

now_seconds() {
  _s=$(date +%s 2>/dev/null)
  case "$_s" in
    ''|*[!0-9]*) printf '0\n' ;;
    *) printf '%s\n' "$_s" ;;
  esac
}

now_millis() {
  _ms=$(date +%s%3N 2>/dev/null)
  case "$_ms" in
    ''|*[!0-9]*)
      _s=$(now_seconds)
      printf '%s\n' "$((_s * 1000))"
      ;;
    *) printf '%s\n' "$_ms" ;;
  esac
}

config_timestamp() {
  date '+%Y%m%d-%H%M%S' 2>/dev/null || date '+%Y%m%d-%H%M%S'
}

config_created_text() {
  date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date '+%Y%m%d-%H%M%S'
}

elapsed_text() {
  _start=$1
  _end=$2
  _delta=$((_end - _start))
  [ "$_delta" -lt 0 ] && _delta=0
  awk -v d="$_delta" 'BEGIN { printf "%.3f", d / 1000 }'
}

log_msg() {
  _level=$1
  shift
  [ "$_level" = "DEBUG" ] && [ ! -f "$DEBUG_FLAG" ] && return 0
  [ "$ACTION_LOCK_ACTIVE" -eq 1 ] && rotate_log_if_needed
  printf '[%s] [%s] %s\n' "$(now_text)" "$_level" "$*" >> "$LOG_FILE"
}

rotate_log_if_needed() {
  case "$LOG_MAX_BYTES" in
    ''|*[!0-9]*) return 0 ;;
  esac
  [ "$LOG_MAX_BYTES" -gt 0 ] || return 0
  _size=$(wc -c < "$LOG_FILE" 2>/dev/null)
  case "$_size" in
    ''|*[!0-9]*) return 0 ;;
  esac
  [ "$_size" -lt "$LOG_MAX_BYTES" ] && return 0

  if mv -f "$LOG_FILE" "$LOG_FILE.old" 2>/dev/null && : > "$LOG_FILE"; then
    chmod 644 "$LOG_FILE" 2>/dev/null
    return 0
  fi
  return 1
}

# shellcheck disable=SC2329 # Invoked by EXIT/signal trap handlers.
cleanup_tmp() {
  rm -f \
    "$CONF_FILE.$$.tmp" \
    "$CONF_FILE.$$.new" \
    "$SCRIPT_DIR/user.tmp.$$" \
    "$SCRIPT_DIR/user.tmp.$$.all" \
    "$SCRIPT_DIR/users.tmp.$$" \
    "$SCRIPT_DIR/package.tmp.$$" \
    "$SCRIPT_DIR/config_uids.$$" \
    "$SCRIPT_DIR/restore.$$.tmp" \
    "$SCRIPT_DIR/log_diff.$$.tmp" \
    "$SCRIPT_DIR/ipt_err.$$.tmp" \
    "$SCRIPT_DIR/ipt_out.$$.tmp" \
    "$TXN_FILE.$$.tmp" \
    "$WEB_APPS.$$.tmp" \
    "$LOCK_FILE/child.go.$$."* \
    2>/dev/null
  [ -n "$BACKUP_TMP_PATH" ] && rm -f "$BACKUP_TMP_PATH" 2>/dev/null
}

cleanup_stale_tmp() {
  rm -f \
    "$CONF_FILE."*.tmp \
    "$CONF_FILE."*.new \
    "$SCRIPT_DIR/user.tmp."* \
    "$SCRIPT_DIR/users.tmp."* \
    "$SCRIPT_DIR/package.tmp."* \
    "$SCRIPT_DIR/config_uids."* \
    "$SCRIPT_DIR/restore."*.tmp \
    "$SCRIPT_DIR/log_diff."* \
    "$SCRIPT_DIR/ipt_err."* \
    "$SCRIPT_DIR/ipt_out."* \
    "$TXN_FILE."*.tmp \
    "$WEB_APPS."*.tmp \
    2>/dev/null
  rm -rf \
    "$LOCK_FILE.stale."* \
    "$LOCK_FILE.release."* \
    "$SCRIPT_DIR/.preserve.snapshot."* \
    "$CONF_FILE.preserve."* \
    2>/dev/null
}

track_child_owner() {
  _tracked_owner_pid=$1
  [ "$LOCK_ACQUIRED" -eq 1 ] || return 1
  _tracked_owner_start=$(process_start_time "$_tracked_owner_pid") || return 1
  _tracked_owner_tmp="$LOCK_FILE/child.tmp.$$"
  {
    printf 'token=%s\n' "$LOCK_TOKEN"
    printf 'pid=%s\n' "$_tracked_owner_pid"
    printf 'start=%s\n' "$_tracked_owner_start"
    printf 'boot=%s\n' "$(current_boot_id)"
  } > "$_tracked_owner_tmp" 2>/dev/null || { rm -f "$_tracked_owner_tmp"; return 1; }
  chmod 600 "$_tracked_owner_tmp" 2>/dev/null || { rm -f "$_tracked_owner_tmp"; return 1; }
  mv -f "$_tracked_owner_tmp" "$LOCK_FILE/child" 2>/dev/null || { rm -f "$_tracked_owner_tmp"; return 1; }
  return 0
}

clear_tracked_child_owner() {
  _tracked_owner_pid=$1
  [ "$LOCK_ACQUIRED" -eq 1 ] || return 0
  _tracked_owner_file="$LOCK_FILE/child"
  _recorded_child=$(sed -n 's/^pid=//p' "$_tracked_owner_file" 2>/dev/null | head -n 1)
  [ "$_recorded_child" = "$_tracked_owner_pid" ] && rm -f "$_tracked_owner_file" 2>/dev/null
}

run_tracked_command() {
  _tracked_stdin=
  if [ "${1:-}" = "--dncs-stdin" ]; then
    [ $# -ge 3 ] || return 125
    _tracked_stdin=$2
    shift 2
  fi
  CHILD_GATE_SEQ=$((CHILD_GATE_SEQ + 1))
  _tracked_gate="$LOCK_FILE/child.go.$$.$CHILD_GATE_SEQ"
  rm -f "$_tracked_gate" 2>/dev/null
  (
    _gate_wait=0
    while [ ! -f "$_tracked_gate" ] && [ "$_gate_wait" -lt 500 ]; do
      sleep 0.01
      _gate_wait=$((_gate_wait + 1))
    done
    [ -f "$_tracked_gate" ] || exit 125
    rm -f "$_tracked_gate" 2>/dev/null || exit 125
    if [ -n "$_tracked_stdin" ]; then
      exec "$@" < "$_tracked_stdin"
    fi
    exec "$@"
  ) &
  _tracked_command_pid=$!
  ACTIVE_CHILD_PID=$_tracked_command_pid
  ACTIVE_CHILD_GATE=$_tracked_gate

  if ! track_child_owner "$_tracked_command_pid"; then
    terminate_active_child
    rm -f "$_tracked_gate" 2>/dev/null
    return 125
  fi
  if ! : > "$_tracked_gate"; then
    terminate_active_child
    rm -f "$_tracked_gate" 2>/dev/null
    return 125
  fi

  wait "$_tracked_command_pid"
  _tracked_command_rc=$?
  rm -f "$_tracked_gate" 2>/dev/null
  clear_tracked_child_owner "$_tracked_command_pid"
  if [ "$ACTIVE_CHILD_PID" = "$_tracked_command_pid" ]; then
    ACTIVE_CHILD_PID=
    ACTIVE_CHILD_GATE=
  fi
  return "$_tracked_command_rc"
}

# shellcheck disable=SC2329 # Reached through the signal trap handler.
terminate_active_child() {
  _signal_child=$ACTIVE_CHILD_PID
  _signal_gate=$ACTIVE_CHILD_GATE
  ACTIVE_CHILD_PID=
  ACTIVE_CHILD_GATE=
  [ -n "$_signal_gate" ] && rm -f "$_signal_gate" 2>/dev/null
  [ -n "$_signal_child" ] || return 0

  _signal_target=$_signal_child
  kill -TERM "$_signal_target" 2>/dev/null || true
  _signal_wait=0
  while kill -0 "$_signal_target" 2>/dev/null && [ "$_signal_wait" -lt 50 ]; do
    sleep 0.1
    _signal_wait=$((_signal_wait + 1))
  done
  if kill -0 "$_signal_target" 2>/dev/null; then
    kill -KILL "$_signal_target" 2>/dev/null || true
  fi
  wait "$_signal_child" 2>/dev/null || true
  clear_tracked_child_owner "$_signal_child"
}

# shellcheck disable=SC2329 # Registered while waiting for the action lock.
on_lock_wait_signal() {
  _lock_signal_rc=$1
  trap '' HUP INT TERM
  terminate_active_child
  exit "$_lock_signal_rc"
}

process_start_time() {
  _process_pid=$1
  case "$_process_pid" in ''|*[!0-9]*) return 1 ;; esac
  _process_stat=$(cat "/proc/$_process_pid/stat" 2>/dev/null) || return 1
  _process_tail=${_process_stat#*) }
  _process_start=$(printf '%s\n' "$_process_tail" | awk '{ print $20 }')
  case "$_process_start" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$_process_start"
}

lock_identity_alive() {
  _lock_identity=$1
  [ -f "$_lock_identity" ] || return 1
  _lock_pid=$(sed -n 's/^pid=//p' "$_lock_identity" 2>/dev/null | head -n 1)
  _lock_boot=$(sed -n 's/^boot=//p' "$_lock_identity" 2>/dev/null | head -n 1)
  _lock_start=$(sed -n 's/^start=//p' "$_lock_identity" 2>/dev/null | head -n 1)
  [ -n "$_lock_pid" ] && [ -n "$_lock_boot" ] && [ -n "$_lock_start" ] || return 1
  [ "$_lock_boot" = "$(current_boot_id)" ] || return 1
  _live_start=$(process_start_time "$_lock_pid") || return 1
  [ "$_live_start" = "$_lock_start" ]
}

lock_owner_alive() {
  lock_identity_alive "$LOCK_FILE/owner" && return 0
  lock_identity_alive "$LOCK_FILE/child"
}

lock_is_initializing() {
  _lock_mtime=$(stat -c %Y "$LOCK_FILE" 2>/dev/null)
  case "$_lock_mtime" in ''|*[!0-9]*) return 0 ;; esac
  _lock_age=$(( $(now_seconds) - _lock_mtime ))
  [ "$_lock_age" -lt 0 ] && _lock_age=0
  [ "$_lock_age" -lt "$LOCK_INIT_GRACE_SECONDS" ]
}

remove_stale_lock() {
  _stale_lock="$LOCK_FILE.stale.$$.$1"
  rm -rf "$_stale_lock" 2>/dev/null
  if mv "$LOCK_FILE" "$_stale_lock" 2>/dev/null; then
    rm -rf "$_stale_lock" 2>/dev/null
    return 0
  fi
  return 1
}

# shellcheck disable=SC2329 # Reached through EXIT and signal trap handlers.
release_lock() {
  [ "$LOCK_ACQUIRED" -eq 1 ] || return 0
  _release_owner="$LOCK_FILE/owner"
  _release_token=$(sed -n 's/^token=//p' "$_release_owner" 2>/dev/null | head -n 1)
  if [ -n "$LOCK_TOKEN" ] && [ "$_release_token" = "$LOCK_TOKEN" ]; then
    _released_lock="$LOCK_FILE.release.$$"
    rm -rf "$_released_lock" 2>/dev/null
    if mv "$LOCK_FILE" "$_released_lock" 2>/dev/null; then
      rm -rf "$_released_lock" 2>/dev/null
    fi
  fi
  LOCK_ACQUIRED=0
  ACTION_LOCK_ACTIVE=0
}

# shellcheck disable=SC2329 # Registered through trap in acquire_lock().
on_exit() {
  cleanup_tmp
  release_lock
}

# shellcheck disable=SC2329 # Registered through trap in acquire_lock().
on_signal() {
  _signal_rc=$1
  trap '' HUP INT TERM
  terminate_active_child
  if [ -f "$TXN_FILE" ]; then
    log_msg ERROR "Transaction interrupted by signal; restoring persisted config"
    recover_pending_transaction signal >/dev/null 2>&1 || true
  fi
  cleanup_tmp
  release_lock
  trap - EXIT
  exit "$_signal_rc"
}

acquire_lock() {
  _wait=${1:-$LOCK_WAIT_SECONDS}
  [ $# -gt 0 ] && shift
  case "$_wait" in
    ''|*[!0-9]*) _wait=30 ;;
  esac
  case "$LOCK_INIT_GRACE_SECONDS" in ''|*[!0-9]*) LOCK_INIT_GRACE_SECONDS=3 ;; esac
  _waited=0
  _logged=0
  trap 'on_lock_wait_signal 129' HUP
  trap 'on_lock_wait_signal 130' INT
  trap 'on_lock_wait_signal 143' TERM

  while ! mkdir "$LOCK_FILE" 2>/dev/null; do
    if [ -d "$LOCK_FILE" ]; then
      if lock_owner_alive || lock_is_initializing; then
        if [ "$_logged" -eq 0 ]; then
          _pid=$(sed -n 's/^pid=//p' "$LOCK_FILE/owner" 2>/dev/null | head -n 1)
          _act=$(sed -n 's/^action=//p' "$LOCK_FILE/owner" 2>/dev/null | head -n 1)
          log_msg DEBUG "Lock busy: pid=${_pid:-initializing} action=${_act:-unknown}"
          _logged=1
        fi
      else
        remove_stale_lock "$_waited" && continue
      fi
    elif [ -e "$LOCK_FILE" ]; then
      log_msg ERROR "Lock ERROR: incompatible legacy lock path"
      return 1
    fi
    if [ "$_waited" -ge "$_wait" ]; then
      log_msg ERROR "Lock timeout: action=$ACTION wait=${_wait}s"
      return 1
    fi
    sleep 1
    _waited=$((_waited + 1))
  done

  chmod 700 "$LOCK_FILE" 2>/dev/null || { rmdir "$LOCK_FILE" 2>/dev/null; return 1; }
  _owner_start=$(process_start_time "$$") || { rmdir "$LOCK_FILE" 2>/dev/null; return 1; }
  _owner_boot=$(current_boot_id)
  LOCK_TOKEN="$_owner_boot:$$:$_owner_start"
  _owner_tmp="$LOCK_FILE/owner.tmp.$$"
  if ! {
    printf 'token=%s\n' "$LOCK_TOKEN"
    printf 'pid=%s\n' "$$"
    printf 'start=%s\n' "$_owner_start"
    printf 'action=%s\n' "$ACTION"
    printf 'boot=%s\n' "$_owner_boot"
    printf 'stamp=%s\n' "$(now_seconds)"
  } > "$_owner_tmp" 2>/dev/null \
    || ! chmod 600 "$_owner_tmp" 2>/dev/null \
    || ! mv "$_owner_tmp" "$LOCK_FILE/owner" 2>/dev/null; then
    rm -rf "$LOCK_FILE" 2>/dev/null
    return 1
  fi
  LOCK_ACQUIRED=1
  ACTION_LOCK_ACTIVE=1
  trap 'on_exit' EXIT
  trap 'on_signal 129' HUP
  trap 'on_signal 130' INT
  trap 'on_signal 143' TERM
  return 0
}

sync_file() {
  _file=$1
  sync "$_file" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
}

current_boot_id() {
  _boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
  if [ -n "$_boot_id" ]; then
    printf '%s\n' "$_boot_id"
    return 0
  fi
  _boot_time=$(cut -d. -f1 /proc/uptime 2>/dev/null)
  _now=$(now_seconds)
  case "$_boot_time" in
    ''|*[!0-9]*) printf 'unknown\n' ;;
    *) printf '%s\n' "$((_now - _boot_time))" ;;
  esac
}

log_boot_infos_once() {
  _boot_id=$(current_boot_id)
  _last_boot_id=$(cat "$BOOT_INFO_MARK" 2>/dev/null)
  if [ "$_boot_id" = "$_last_boot_id" ]; then
    log_msg DEBUG "Boot Apply INFO skipped: already logged for boot $_boot_id"
    return 0
  fi
  while IFS= read -r _boot_uid; do
    [ -n "$_boot_uid" ] && log_msg INFO "UID:$_boot_uid 开机维持断网 🚫"
  done < "$CONF_FILE"
  printf '%s\n' "$_boot_id" > "$BOOT_INFO_MARK" 2>/dev/null
  chmod 600 "$BOOT_INFO_MARK" 2>/dev/null
  sync_file "$BOOT_INFO_MARK"
}

list_users() {
  _user_output=$("$CMD_PACKAGE_CMD" package list users 2>/dev/null) || return 1
  _users=$(printf '%s\n' "$_user_output" | sed -n 's/.*UserInfo{\([0-9][0-9]*\).*/\1/p')
  [ -n "$_users" ] || return 1
  printf '%s\n' "$_users"
}

capture_package_output() {
  _capture_file=$1
  shift
  _capture_output=$("$CMD_PACKAGE_CMD" "$@" 2>/dev/null)
  _capture_rc=$?
  if [ "$_capture_rc" -ne 0 ]; then
    rm -f "$_capture_file" 2>/dev/null
    return "$_capture_rc"
  fi
  if [ -n "$_capture_output" ]; then
    printf '%s\n' "$_capture_output" > "$_capture_file"
  else
    : > "$_capture_file"
  fi
}

validate_uid_args() {
  for _arg in "$@"; do
    is_valid_uid "$_arg" || return 1
  done
  return 0
}

is_valid_uid() {
  _uid_value=$1
  case "$_uid_value" in
    0) return 0 ;;
    [1-9]*)
      case "$_uid_value" in *[!0-9]*) return 1 ;; esac
      ;;
    *) return 1 ;;
  esac
  _uid_length=${#_uid_value}
  [ "$_uid_length" -le 10 ] || return 1
  [ "$_uid_length" -lt 10 ] && return 0
  awk -v uid="$_uid_value" 'BEGIN { exit !((uid + 0) <= 2147483647) }'
}

sanitize_uids() {
  for _arg in "$@"; do
    printf '%s\n' "$_arg"
  done | awk '!seen[$1]++ { print $1 }'
}

sanitize_conf_file() {
  _file=$1
  awk '/^(0|[1-9][0-9]*)$/ && length($1) <= 10 && ($1 + 0) <= 2147483647 && !seen[$1]++ { print $1 }' "$_file" 2>/dev/null
}

resolve_backup_dir() {
  if [ -n "${DNCS_BACKUP_DIR:-}" ]; then
    mkdir -p "$DNCS_BACKUP_DIR" 2>/dev/null || return 1
    printf '%s\n' "$DNCS_BACKUP_DIR"
    return 0
  fi

  for _dir in /sdcard/Download /storage/emulated/0/Download; do
    mkdir -p "$_dir" 2>/dev/null || continue
    [ -d "$_dir" ] || continue
    printf '%s\n' "$_dir"
    return 0
  done
  return 1
}

backup_config() {
  _uids_file="$SCRIPT_DIR/config_uids.$$"
  _dir=$(resolve_backup_dir) || {
    log_msg ERROR "Backup ERROR: Download directory unavailable"
    printf 'BACKUP_FAILED\n'
    return 1
  }

  sanitize_conf_file "$CONF_FILE" > "$_uids_file" || {
    rm -f "$_uids_file"
    log_msg ERROR "Backup ERROR: failed to read config"
    printf 'BACKUP_FAILED\n'
    return 1
  }

  if [ -s "$_uids_file" ] && ! write_apps_cache; then
    rm -f "$_uids_file"
    log_msg ERROR "Backup ERROR: complete package identity snapshot unavailable"
    printf 'BACKUP_FAILED\n'
    return 1
  fi

  _stamp=$(config_timestamp)
  BACKUP_TMP_PATH="$_dir/.dncs-backup-${_stamp}-$$.tmp"
  _count=$(awk 'NF { c++ } END { print c + 0 }' "$_uids_file")

  {
    printf '%s\n' "$CONFIG_MAGIC"
    printf '# created=%s\n' "$(config_created_text)"
    printf '# uids=%s\n' "$_count"
    if [ "$_count" -eq 0 ]; then
      printf '# unresolved_uids=0\n'
    else
      awk -F '|' '
        NR == FNR {
          uid = $2
          user_id = $5
          pkg = $6
          if (uid !~ /^(0|[1-9][0-9]*)$/ || length(uid) > 10 || (uid + 0) > 2147483647) next
          if (user_id !~ /^(0|[1-9][0-9]*)$/ || length(user_id) > 5 || (user_id + 0) > 21474) next
          if (pkg !~ /^[A-Za-z0-9_]+([.][A-Za-z0-9_]+)*$/) next
          key = uid SUBSEP user_id SUBSEP pkg
          if (!seen_identity[key]++) {
            item_index = ++identity_count[uid]
            identity_user[uid SUBSEP item_index] = user_id
            identity_pkg[uid SUBSEP item_index] = pkg
          }
          next
        }
        NF {
          uid = $1
          printf "uid=%s\n", uid
          if (identity_count[uid] == 0) unresolved++
          for (item_index = 1; item_index <= identity_count[uid]; item_index++) {
            printf "app=%s|%s\n", identity_user[uid SUBSEP item_index], identity_pkg[uid SUBSEP item_index]
          }
        }
        END { printf "# unresolved_uids=%d\n", unresolved + 0 }
      ' "$WEB_APPS" "$_uids_file"
    fi
  } > "$BACKUP_TMP_PATH" || {
    rm -f "$_uids_file"
    rm -f "$BACKUP_TMP_PATH"
    BACKUP_TMP_PATH=
    log_msg ERROR "Backup ERROR: failed to write temp config"
    printf 'BACKUP_FAILED\n'
    return 1
  }

  chmod 644 "$BACKUP_TMP_PATH" 2>/dev/null
  _path=
  _i=0
  while [ "$_i" -lt 100 ]; do
    if [ "$_i" -eq 0 ]; then
      _candidate="$_dir/dncs-${_stamp}.config"
    else
      _candidate="$_dir/dncs-${_stamp}-${_i}.config"
    fi
    if [ ! -e "$_candidate" ]; then
      mv -n "$BACKUP_TMP_PATH" "$_candidate" 2>/dev/null || true
      if [ ! -e "$BACKUP_TMP_PATH" ]; then
        _path=$_candidate
        break
      fi
      [ -e "$_candidate" ] || break
    fi
    _i=$((_i + 1))
  done
  if [ -z "$_path" ]; then
    rm -f "$_uids_file" "$BACKUP_TMP_PATH"
    BACKUP_TMP_PATH=
    log_msg ERROR "Backup ERROR: failed to publish a unique config filename"
    printf 'BACKUP_FAILED\n'
    return 1
  fi
  BACKUP_TMP_PATH=
  chmod 644 "$_path" 2>/dev/null
  sync_file "$_path"
  rm -f "$_uids_file"
  log_msg INFO "配置已备份：$_path（$_count 个 UID）"
  printf 'BACKUP:%s\n' "$_path"
  return 0
}

collect_valid_uids() {
  _out=$1
  _users_file="$SCRIPT_DIR/users.tmp.$$"
  _package_file="$SCRIPT_DIR/package.tmp.$$"
  _scan_ok=1
  : > "$_out"
  list_users > "$_users_file" || { rm -f "$_users_file" "$_package_file"; return 1; }
  while IFS= read -r _u; do
    [ -n "$_u" ] || continue
    if ! capture_package_output "$_package_file" package list packages -U --user "$_u"; then
      _scan_ok=0
      break
    fi
    awk -F 'uid:' 'NF > 1 { sub(/[[:space:]].*/, "", $2); if ($2 ~ /^(0|[1-9][0-9]*)$/ && length($2) <= 10 && ($2 + 0) <= 2147483647 && !seen[$2]++) print $2 }' \
      "$_package_file" >> "$_out" || { _scan_ok=0; break; }
  done < "$_users_file"
  rm -f "$_users_file" "$_package_file"
  [ "$_scan_ok" -eq 1 ] || return 1
  [ -s "$_out" ]
}

wait_option_unsupported() {
  _error_file=$1
  grep -Eiq '(unknown|invalid|illegal|unrecognized).*(-w|--wait)|(-w|--wait).*(unknown|invalid|illegal|unrecognized)' "$_error_file" 2>/dev/null
}

run_ipt_capture() {
  _tool=$1
  _out_file=$2
  _error_file=$3
  shift 3
  run_tracked_command "$_tool" -w 2 "$@" > "$_out_file" 2> "$_error_file"
  _ret=$?
  if [ "$_ret" -ne 0 ] && wait_option_unsupported "$_error_file"; then
    run_tracked_command "$_tool" "$@" > "$_out_file" 2> "$_error_file"
    _ret=$?
  fi
  return "$_ret"
}

run_ipt_quiet() {
  _tool=$1
  shift
  _out_file="$SCRIPT_DIR/ipt_out.$$.tmp"
  _error_file="$SCRIPT_DIR/ipt_err.$$.tmp"
  run_ipt_capture "$_tool" "$_out_file" "$_error_file" "$@"
  _ret=$?
  rm -f "$_out_file" "$_error_file"
  return "$_ret"
}

ensure_chain_one() {
  _tool=$1
  _name=$2
  if ! command -v "$_tool" >/dev/null 2>&1; then
    log_msg ERROR "Firewall ERROR: $_name command not found ($_tool)"
    return 1
  fi
  if ! run_ipt_quiet "$_tool" -nL "$CHAIN_NAME"; then
    if ! run_ipt_quiet "$_tool" -N "$CHAIN_NAME"; then
      log_msg ERROR "Firewall ERROR: $_name create chain failed"
      return 1
    fi
  fi
  if ! run_ipt_quiet "$_tool" -C OUTPUT -j "$CHAIN_NAME"; then
    if ! run_ipt_quiet "$_tool" -I OUTPUT -j "$CHAIN_NAME"; then
      log_msg ERROR "Firewall ERROR: $_name attach OUTPUT failed"
      return 1
    fi
  fi
  return 0
}

remove_chain_one() {
  _tool=$1
  _name=$2
  _out_file="$SCRIPT_DIR/ipt_out.$$.tmp"
  _error_file="$SCRIPT_DIR/ipt_err.$$.tmp"
  _remove_one_status=0
  if ! command -v "$_tool" >/dev/null 2>&1; then
    log_msg ERROR "Rescue ERROR: $_name command not found ($_tool)"
    return 1
  fi

  if ! run_ipt_capture "$_tool" "$_out_file" "$_error_file" -S; then
    _err_msg=$(tr '\n' ' ' < "$_error_file" 2>/dev/null)
    log_msg ERROR "Rescue ERROR: $_name initial rules query failed - $_err_msg"
    rm -f "$_out_file" "$_error_file"
    return 1
  fi

  while run_ipt_quiet "$_tool" -C OUTPUT -j "$CHAIN_NAME"; do
    if ! run_ipt_quiet "$_tool" -D OUTPUT -j "$CHAIN_NAME"; then
      _remove_one_status=1
      break
    fi
  done

  if ! run_ipt_capture "$_tool" "$_out_file" "$_error_file" -S; then
    _err_msg=$(tr '\n' ' ' < "$_error_file" 2>/dev/null)
    log_msg ERROR "Rescue ERROR: $_name rules query failed - $_err_msg"
    rm -f "$_out_file" "$_error_file"
    return 1
  fi
  if grep -Eq "^-A OUTPUT( .*)? -j $CHAIN_NAME( |$)" "$_out_file"; then
    log_msg ERROR "Rescue ERROR: $_name OUTPUT jump still exists"
    _remove_one_status=1
  fi
  if grep -Fqx -- "-N $CHAIN_NAME" "$_out_file"; then
    run_ipt_quiet "$_tool" -F "$CHAIN_NAME" || _remove_one_status=1
    run_ipt_quiet "$_tool" -X "$CHAIN_NAME" || _remove_one_status=1
  fi

  if ! run_ipt_capture "$_tool" "$_out_file" "$_error_file" -S; then
    _err_msg=$(tr '\n' ' ' < "$_error_file" 2>/dev/null)
    log_msg ERROR "Rescue ERROR: $_name final verification failed - $_err_msg"
    _remove_one_status=1
  elif grep -Fqx -- "-N $CHAIN_NAME" "$_out_file" \
    || grep -Eq "^-A OUTPUT( .*)? -j $CHAIN_NAME( |$)" "$_out_file"; then
    log_msg ERROR "Rescue ERROR: $_name chain or OUTPUT jump still exists"
    _remove_one_status=1
  fi
  rm -f "$_out_file" "$_error_file"
  return "$_remove_one_status"
}

preflight_remove_one() {
  _tool=$1
  _name=$2
  _out_file="$SCRIPT_DIR/ipt_out.$$.tmp"
  _error_file="$SCRIPT_DIR/ipt_err.$$.tmp"
  if ! command -v "$_tool" >/dev/null 2>&1; then
    log_msg ERROR "Rescue ERROR: $_name command not found ($_tool)"
    return 1
  fi
  if ! run_ipt_capture "$_tool" "$_out_file" "$_error_file" -S; then
    _err_msg=$(tr '\n' ' ' < "$_error_file" 2>/dev/null)
    log_msg ERROR "Rescue ERROR: $_name preflight query failed - $_err_msg"
    rm -f "$_out_file" "$_error_file"
    return 1
  fi
  rm -f "$_out_file" "$_error_file"
  return 0
}

preflight_remove() {
  preflight_remove_one "$IPTABLES_CMD" IPv4 || return 1
  preflight_remove_one "$IP6TABLES_CMD" IPv6 || return 1
  return 0
}

remove_chain() {
  remove_chain_one "$IPTABLES_CMD" IPv4 || return 1
  remove_chain_one "$IP6TABLES_CMD" IPv6 || return 1
  return 0
}

gen_restore() {
  _uids=$1
  printf '*filter\n'
  printf '%s\n' "-F $CHAIN_NAME"
  for _uid in $_uids; do
    printf '%s\n' "-A $CHAIN_NAME -m owner --uid-owner $_uid -j REJECT"
  done
  printf 'COMMIT\n'
}

run_restore() {
  _tool=$1
  _uids=$2
  _err_log=$3
  if ! command -v "$_tool" >/dev/null 2>&1; then
    printf '%s\n' "command not found: $_tool" > "$_err_log"
    return 127
  fi
  _restore_input="$SCRIPT_DIR/restore.$$.tmp"
  if ! gen_restore "$_uids" > "$_restore_input"; then
    printf '%s\n' "failed to prepare restore input" > "$_err_log"
    rm -f "$_restore_input"
    return 1
  fi
  run_tracked_command --dncs-stdin "$_restore_input" "$_tool" -w 2 --noflush >/dev/null 2>"$_err_log"
  _ret=$?
  if [ "$_ret" -ne 0 ] && wait_option_unsupported "$_err_log"; then
    run_tracked_command --dncs-stdin "$_restore_input" "$_tool" --noflush >/dev/null 2>"$_err_log"
    _ret=$?
  fi
  rm -f "$_restore_input"
  return "$_ret"
}

preflight_restore() {
  _tool=$1
  _uids=$2
  _err_log=$3
  if ! command -v "$_tool" >/dev/null 2>&1; then
    printf '%s\n' "command not found: $_tool" > "$_err_log"
    return 127
  fi
  if ! "$_tool" --help 2>&1 | grep -Eq -- '--test|\[-t\]'; then
    log_msg DEBUG "Firewall preflight skipped: $_tool has no advertised test mode"
    return 0
  fi

  _restore_input="$SCRIPT_DIR/restore.$$.tmp"
  if ! gen_restore "$_uids" > "$_restore_input"; then
    printf '%s\n' "failed to prepare restore input" > "$_err_log"
    rm -f "$_restore_input"
    return 1
  fi
  run_tracked_command --dncs-stdin "$_restore_input" "$_tool" -w 2 --noflush --test >/dev/null 2>"$_err_log"
  _ret=$?
  if [ "$_ret" -ne 0 ] && wait_option_unsupported "$_err_log"; then
    run_tracked_command --dncs-stdin "$_restore_input" "$_tool" --noflush --test >/dev/null 2>"$_err_log"
    _ret=$?
  fi
  rm -f "$_restore_input"
  return "$_ret"
}

prepare_rules_one() {
  _tool=$1
  _restore_tool=$2
  _name=$3
  _uids=$4
  _err_log=$5
  ensure_chain_one "$_tool" "$_name" || return 1
  preflight_restore "$_restore_tool" "$_uids" "$_err_log"
  _prepare_rc=$?
  if [ "$_prepare_rc" -ne 0 ]; then
    _err_msg=$(tr '\n' ' ' < "$_err_log" 2>/dev/null)
    log_msg ERROR "Transaction ERROR: $_name preflight failed (Code $_prepare_rc) - $_err_msg"
    return 1
  fi
  return 0
}

commit_rules_one() {
  _restore_tool=$1
  _name=$2
  _uids=$3
  _err_log=$4
  run_restore "$_restore_tool" "$_uids" "$_err_log"
  _commit_rc=$?
  if [ "$_commit_rc" -ne 0 ]; then
    _err_msg=$(tr '\n' ' ' < "$_err_log" 2>/dev/null)
    log_msg ERROR "Transaction ERROR: $_name Failed (Code $_commit_rc) - $_err_msg"
    return 1
  fi
  return 0
}

apply_rules() {
  _uids=$1
  _count=0
  for _uid in $_uids; do _count=$((_count + 1)); done
  _err_log="$SCRIPT_DIR/ipt_err.$$.tmp"
  log_msg DEBUG "Transaction Start: UID_Count=$_count"
  prepare_rules_one "$IPTABLES_CMD" "$IPTABLES_RESTORE_CMD" IPv4 "$_uids" "$_err_log" \
    || { rm -f "$_err_log"; return 1; }
  prepare_rules_one "$IP6TABLES_CMD" "$IP6TABLES_RESTORE_CMD" IPv6 "$_uids" "$_err_log" \
    || { rm -f "$_err_log"; return 1; }
  commit_rules_one "$IPTABLES_RESTORE_CMD" IPv4 "$_uids" "$_err_log" \
    || { rm -f "$_err_log"; return 1; }
  commit_rules_one "$IP6TABLES_RESTORE_CMD" IPv6 "$_uids" "$_err_log" \
    || { rm -f "$_err_log"; return 1; }
  rm -f "$_err_log"
  log_msg DEBUG "Transaction OK: Dual Stack"
  return 0
}

restore_rules_best_effort() {
  _uids=$1
  _err_log="$SCRIPT_DIR/ipt_err.$$.tmp"
  _restore_status=0

  if prepare_rules_one "$IPTABLES_CMD" "$IPTABLES_RESTORE_CMD" IPv4 "$_uids" "$_err_log"; then
    commit_rules_one "$IPTABLES_RESTORE_CMD" IPv4 "$_uids" "$_err_log" || _restore_status=1
  else
    _restore_status=1
  fi
  if prepare_rules_one "$IP6TABLES_CMD" "$IP6TABLES_RESTORE_CMD" IPv6 "$_uids" "$_err_log"; then
    commit_rules_one "$IP6TABLES_RESTORE_CMD" IPv6 "$_uids" "$_err_log" || _restore_status=1
  else
    _restore_status=1
  fi
  rm -f "$_err_log"
  [ "$_restore_status" -eq 0 ] && log_msg DEBUG "Recovery OK: Dual Stack"
  return "$_restore_status"
}

write_apps_cache() {
  _tmp_all="$SCRIPT_DIR/user.tmp.$$.all"
  _users_file="$SCRIPT_DIR/users.tmp.$$"
  _package_file="$SCRIPT_DIR/package.tmp.$$"
  _apps_tmp="$WEB_APPS.$$.tmp"
  _scan_ok=1
  : > "$_tmp_all" || return 1

  if ! list_users > "$_users_file"; then
    log_msg ERROR "Package scan ERROR: failed to enumerate Android users"
    rm -f "$_tmp_all" "$_users_file" "$_package_file" "$_apps_tmp"
    return 1
  fi
  while IFS= read -r _u; do
    [ -n "$_u" ] || continue
    if ! capture_package_output "$_package_file" package list packages -3 --user "$_u" -U; then
      log_msg ERROR "Package scan ERROR: user $_u third-party query failed"
      _scan_ok=0
      break
    fi
    sed "s/^package:/USER:$_u:/" "$_package_file" >> "$_tmp_all" || {
      _scan_ok=0
      break
    }
    if ! capture_package_output "$_package_file" package list packages -s --user "$_u" -U; then
      log_msg ERROR "Package scan ERROR: user $_u system query failed"
      _scan_ok=0
      break
    fi
    sed "s/^package:/SYS:$_u:/" "$_package_file" >> "$_tmp_all" || {
      _scan_ok=0
      break
    }
  done < "$_users_file"
  rm -f "$_users_file" "$_package_file"
  if [ "$_scan_ok" -ne 1 ]; then
    rm -f "$_tmp_all" "$_apps_tmp"
    return 1
  fi

  if [ ! -s "$_tmp_all" ]; then
    log_msg ERROR "Package scan ERROR: no package data returned by package manager"
    rm -f "$_tmp_all" "$_users_file" "$_package_file" "$_apps_tmp"
    return 1
  fi

  if ! awk -v c_file="$CONF_FILE" '
    BEGIN {
      while ((getline line < c_file) > 0) {
        if (line ~ /^(0|[1-9][0-9]*)$/ && length(line) <= 10 && (line + 0) <= 2147483647) block[line] = 1
      }
      close(c_file)
    }
    {
      split($0, parts, " uid:")
      if (parts[2] !~ /^(0|[1-9][0-9]*)$/ || length(parts[2]) > 10 || (parts[2] + 0) > 2147483647) next
      uid = parts[2]
      split(parts[1], meta, ":")
      type_str = meta[1]
      user_id = meta[2]
      pkg = meta[3]
      if (pkg == "" || user_id == "") next

      if (type_str == "USER") user_app[pkg] = 1
      user_pkg_uid[user_id ":" pkg] = uid
      users[user_id] = 1
      pkgs[pkg] = 1
      if (!uid_pkg_seen[uid ":" pkg]++) uid_pkg_count[uid]++
    }
    END {
      for (pkg in pkgs) {
        for (user_id in users) {
          key = user_id ":" pkg
          if (!(key in user_pkg_uid)) continue
          uid = user_pkg_uid[key]
          app_type = "system"
          if (uid_pkg_count[uid] > 1) app_type = "shared"
          else if (user_app[pkg]) app_type = "user"

          label = pkg
          if (user_id != "0") label = pkg " (分身:" user_id ")"
          printf "%s|%s|%s|%d|%s|%s\n", label, uid, app_type, (block[uid] ? 1 : 0), user_id, pkg
        }
      }
    }
  ' "$_tmp_all" | LC_ALL=C sort -t '|' -k3,3 -k1,1 > "$_apps_tmp"; then
    log_msg ERROR "Package scan ERROR: failed to generate apps cache"
    rm -f "$_tmp_all" "$_apps_tmp"
    return 1
  fi

  chmod 644 "$_apps_tmp" 2>/dev/null
  if ! mv -f "$_apps_tmp" "$WEB_APPS"; then
    log_msg ERROR "Package scan ERROR: failed to publish apps cache"
    rm -f "$_tmp_all" "$_apps_tmp"
    return 1
  fi
  sync_file "$WEB_APPS"
  rm -f "$_tmp_all"
  return 0
}

mark_transaction() {
  _phase=${1:-unknown}
  _txn_tmp="$TXN_FILE.$$.tmp"
  {
    printf 'pid=%s\n' "$$"
    printf 'phase=%s\n' "$_phase"
    printf 'boot=%s\n' "$(current_boot_id)"
    printf 'time=%s\n' "$(now_seconds)"
  } > "$_txn_tmp" || { rm -f "$_txn_tmp"; return 1; }
  chmod 600 "$_txn_tmp" 2>/dev/null || { rm -f "$_txn_tmp"; return 1; }
  run_tracked_command mv -f "$_txn_tmp" "$TXN_FILE" || { rm -f "$_txn_tmp"; return 1; }
  sync "$TXN_FILE" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
  return 0
}

clear_transaction() {
  [ -e "$TXN_FILE" ] || return 0
  run_tracked_command rm -f "$TXN_FILE" 2>/dev/null || return 1
  sync >/dev/null 2>&1 || true
  return 0
}

recover_pending_transaction() {
  _source=${1:-action}
  [ -f "$TXN_FILE" ] || return 0
  log_msg ERROR "Transaction recovery: source=$_source; reconciling persisted config"
  if restore_rules_best_effort "$(cat "$CONF_FILE" 2>/dev/null)"; then
    clear_transaction || log_msg ERROR "Transaction recovery WARN: marker cleanup failed"
    log_msg INFO "未完成事务已按已保存配置恢复"
    return 0
  fi
  log_msg ERROR "Transaction recovery ERROR: persisted config could not be restored"
  return 1
}

format_apply_success() {
  _applied=$1
  _requested=$2
  _uids_csv=$(awk 'BEGIN { sep="" } NF { printf "%s%s", sep, $1; sep="," } END { print "" }' "$CONF_FILE")
  printf 'SUCCESS:%s:%s:%s\n' "$_applied" "$_requested" "$_uids_csv"
}

apply_config() {
  _t_start=$(now_millis)
  _tmp_user="$SCRIPT_DIR/user.tmp.$$"
  _tmp_conf="$CONF_FILE.$$.tmp"
  _new_conf="$CONF_FILE.$$.new"
  _status=FAIL
  _rc=1

  log_msg DEBUG "=== Apply Start ==="
  if ! validate_uid_args "$@"; then
    log_msg ERROR "Apply ERROR: invalid UID argument"
    printf 'INVALID_UID\n'
    return 1
  fi
  sanitize_uids "$@" > "$_tmp_conf" || { log_msg ERROR "Apply ERROR: failed to write temp config"; printf 'FS_ERROR\n'; return 1; }
  _requested=$(awk 'NF { c++ } END { print c + 0 }' "$_tmp_conf")
  if ! collect_valid_uids "$_tmp_user"; then
    log_msg ERROR "PMS ERROR: complete valid UID list unavailable; config unchanged"
    rm -f "$_tmp_conf" "$_tmp_user" "$_new_conf"
    printf 'PMS_ERROR\n'
    return 1
  fi

  if ! awk 'NR == FNR { valid[$1] = 1; next } valid[$1] && !seen[$1]++ { print $1 }' "$_tmp_user" "$_tmp_conf" > "$_new_conf"; then
    log_msg ERROR "Apply ERROR: failed to validate UID list"
    rm -f "$_tmp_conf" "$_tmp_user" "$_new_conf"
    printf 'FS_ERROR\n'
    return 1
  fi
  rm -f "$_tmp_conf" "$_tmp_user"
  chmod 600 "$_new_conf" 2>/dev/null
  _applied=$(awk 'NF { c++ } END { print c + 0 }' "$_new_conf")
  if [ "$_applied" -lt "$_requested" ]; then
    log_msg INFO "Apply skipped $((_requested - _applied)) UID(s) not present in the complete package snapshot"
  fi

  if ! mark_transaction apply; then
    log_msg ERROR "Transaction ERROR: failed to persist transaction marker"
    rm -f "$_new_conf"
    printf 'FS_ERROR\n'
    return 1
  fi

  if apply_rules "$(cat "$_new_conf" 2>/dev/null)"; then
    cp -f "$CONF_FILE" "$CONF_BAK" 2>/dev/null || : > "$CONF_BAK"
    chmod 600 "$CONF_BAK" 2>/dev/null
    if run_tracked_command mv -f "$_new_conf" "$CONF_FILE"; then
      chmod 600 "$CONF_FILE" 2>/dev/null
      sync_file "$CONF_FILE"
      _diff_file="$SCRIPT_DIR/log_diff.$$.tmp"
      if awk '
        FILENAME == ARGV[1] { if (NF) old[$1] = 1; next }
        NF { new[$1] = 1; if (!old[$1]) print "block|" $1 }
        END { for (uid in old) if (!new[uid]) print "restore|" uid }
      ' "$CONF_BAK" "$CONF_FILE" > "$_diff_file"; then
        while IFS='|' read -r _change _change_uid; do
          case "$_change" in
            block) log_msg INFO "UID:$_change_uid 禁用网络 🚫" ;;
            restore) log_msg INFO "UID:$_change_uid 恢复网络 🌐" ;;
          esac
        done < "$_diff_file"
      else
        log_msg ERROR "Apply WARN: failed to generate change log"
      fi
      rm -f "$_diff_file"
      clear_transaction || log_msg ERROR "Transaction WARN: committed but marker cleanup failed"
      _status=SUCCESS
      _rc=0
    else
      log_msg ERROR "Transaction ERROR: FS write failed. Rolling back firewall..."
      if restore_rules_best_effort "$(cat "$CONF_FILE" 2>/dev/null)" >/dev/null 2>&1; then
        clear_transaction || true
      else
        log_msg ERROR "Rollback ERROR: previous firewall restore failed after FS write error"
      fi
      rm -f "$_new_conf"
      _status=FS_ERROR
      _rc=1
    fi
  else
    log_msg ERROR "Transaction ERROR: Dual Stack mismatch or failure. Initiating Rollback..."
    if restore_rules_best_effort "$(cat "$CONF_FILE" 2>/dev/null)" >/dev/null 2>&1; then
      clear_transaction || true
    else
      log_msg ERROR "Rollback ERROR: previous firewall restore failed after transaction failure"
    fi
    rm -f "$_new_conf"
    _status=FAIL
    _rc=1
  fi

  _t_end=$(now_millis)
  _elapsed=$(elapsed_text "$_t_start" "$_t_end")
  log_msg DEBUG "=== Apply End: $_status (Elapsed: ${_elapsed}s) ==="
  if [ "$_status" = SUCCESS ]; then
    format_apply_success "$_applied" "$_requested"
  else
    printf '%s\n' "$_status"
  fi
  return "$_rc"
}

boot_apply() {
  _t_start=$(now_millis)
  _status=FAIL
  _rc=1
  _source=${DNCS_BOOT_SOURCE:-direct}
  log_msg DEBUG "=== Boot Apply Start (source=$_source) ==="

  if ! mark_transaction "boot:$_source"; then
    log_msg ERROR "Boot Apply ERROR: failed to persist transaction marker"
  elif apply_rules "$(cat "$CONF_FILE" 2>/dev/null)"; then
    log_boot_infos_once
    clear_transaction || log_msg ERROR "Boot Apply WARN: marker cleanup failed"
    _status=SUCCESS
    _rc=0
  else
    restore_rules_best_effort "$(cat "$CONF_FILE" 2>/dev/null)" >/dev/null 2>&1 \
      || log_msg ERROR "Boot Apply recovery ERROR: one or more families remain unavailable"
  fi

  _t_end=$(now_millis)
  _elapsed=$(elapsed_text "$_t_start" "$_t_end")
  log_msg DEBUG "=== Boot Apply End: $_status (Elapsed: ${_elapsed}s) ==="
  return "$_rc"
}

rescue_all() {
  if ! preflight_remove; then
    log_msg ERROR "Rescue ERROR: dual-stack preflight failed; firewall unchanged"
    printf 'RESCUE_FAILED\n'
    return 1
  fi
  if ! mark_transaction rescue; then
    log_msg ERROR "Rescue ERROR: failed to persist transaction marker"
    printf 'RESCUE_FAILED\n'
    return 1
  fi

  if remove_chain; then
    _empty_conf="$CONF_FILE.$$.new"
    if : > "$_empty_conf" && chmod 600 "$_empty_conf" 2>/dev/null && run_tracked_command mv -f "$_empty_conf" "$CONF_FILE"; then
      sync_file "$CONF_FILE"
      if ! clear_transaction; then
        log_msg ERROR "Rescue ERROR: network restored but transaction marker cleanup failed"
        printf 'RESCUE_FAILED\n'
        return 1
      fi
      log_msg INFO "安全模式全网放行 🌐"
      printf 'RESCUED\n'
      return 0
    fi
    rm -f "$_empty_conf"
    log_msg ERROR "Rescue ERROR: config clear failed; restoring persisted rules"
    if restore_rules_best_effort "$(cat "$CONF_FILE" 2>/dev/null)" >/dev/null 2>&1; then
      clear_transaction || log_msg ERROR "Rescue rollback WARN: marker cleanup failed"
    else
      log_msg ERROR "Rescue rollback ERROR: persisted rules could not be restored"
    fi
    printf 'RESCUE_FAILED\n'
    return 1
  fi
  log_msg ERROR "Rescue ERROR: firewall cleanup failed; restoring persisted rules"
  if restore_rules_best_effort "$(cat "$CONF_FILE" 2>/dev/null)" >/dev/null 2>&1; then
    clear_transaction || log_msg ERROR "Rescue rollback WARN: marker cleanup failed"
    log_msg INFO "Rescue rollback: persisted dual-stack rules restored"
  else
    log_msg ERROR "Rescue rollback ERROR: persisted rules could not be restored; recovery marker retained"
  fi
  printf 'RESCUE_FAILED\n'
  return 1
}

record_lifecycle_error() {
  case "${1:-}" in
    service-early) _lifecycle_message="service early boot_apply failed after 30 attempts" ;;
    service-timeout) _lifecycle_message="service final boot_apply skipped: boot completion timeout" ;;
    service-final) _lifecycle_message="service final boot_apply failed after 15 attempts" ;;
    boot-completed) _lifecycle_message="boot-completed boot_apply failed" ;;
    *) printf 'INVALID_EVENT\n'; return 1 ;;
  esac
  log_msg ERROR "$_lifecycle_message"
  printf 'LOGGED\n'
  return 0
}

if ! init_runtime; then
  printf 'INIT_FAILED\n'
  exit 1
fi

case "$ACTION" in
  list|apply|backup_config|boot_apply|rescue|toggle_debug|clear_log|lifecycle_error)
    acquire_lock "$LOCK_WAIT_SECONDS" "$@" || { printf 'LOCKED\n'; exit 1; }
    cleanup_stale_tmp
    ;;
esac

case "$ACTION" in
  apply|rescue)
    if [ "${DNCS_ALLOW_UPDATE_PENDING:-0}" != 1 ] && [ -d "$UPDATE_MODULE_DIR" ]; then
      log_msg ERROR "Action rejected: module update is pending; reboot before $ACTION"
      printf 'UPDATE_PENDING\n'
      exit 1
    fi
    ;;
esac

case "$ACTION" in
  list|apply|backup_config)
    if ! recover_pending_transaction "$ACTION"; then
      printf 'RECOVERY_FAILED\n'
      exit 1
    fi
    ;;
esac

case "$ACTION" in
  list)
    log_msg DEBUG "全盘扫描包数据与多用户"
    if write_apps_cache; then
      log_msg DEBUG "扫描完成生成缓存"
      printf 'READY\n'
      exit 0
    fi
    printf 'LIST_FAILED\n'
    exit 1
    ;;
  apply)
    apply_config "$@"
    exit $?
    ;;
  backup_config)
    backup_config
    exit $?
    ;;
  boot_apply)
    boot_apply
    exit $?
    ;;
  rescue)
    rescue_all
    exit $?
    ;;
  lifecycle_error)
    record_lifecycle_error "${1:-}"
    exit $?
    ;;
  toggle_debug)
    if [ -f "$DEBUG_FLAG" ]; then
      if ! rm -f "$DEBUG_FLAG"; then
        log_msg ERROR "Debug toggle ERROR: failed to remove flag"
        printf 'DEBUG_FAILED\n'
        exit 1
      fi
      log_msg INFO "调试关闭"
      printf 'DEBUG_OFF\n'
    else
      if ! : > "$DEBUG_FLAG" || ! chmod 600 "$DEBUG_FLAG" 2>/dev/null; then
        log_msg ERROR "Debug toggle ERROR: failed to create flag"
        printf 'DEBUG_FAILED\n'
        exit 1
      fi
      log_msg INFO "调试开启"
      printf 'DEBUG_ON\n'
    fi
    ;;
  clear_log)
    if ! : > "$LOG_FILE" || ! chmod 644 "$LOG_FILE" 2>/dev/null || ! rm -f "$LOG_FILE.old"; then
      printf 'LOG_CLEAR_FAILED\n'
      exit 1
    fi
    printf 'LOG_CLEARED\n'
    ;;
  *)
    printf 'ERROR\n'
    exit 1
    ;;
esac

exit 0
