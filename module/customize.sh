#!/system/bin/sh
# KernelSU/APatch/Magisk-compatible install-time state migration and permissions.
umask 077

MODULE_ID=dncs
OLD_MODULE_DIR=${DNCS_OLD_MODULE_DIR:-/data/adb/modules/$MODULE_ID}
MODPATH=${MODPATH:-}

print_install_error() {
  _message=$1
  if command -v abort >/dev/null 2>&1; then
    abort "! DNCS install failed: $_message"
  fi
  command -v ui_print >/dev/null 2>&1 && ui_print "! DNCS install failed: $_message"
  return 1
}

if [ -z "$MODPATH" ]; then
  print_install_error "MODPATH is empty"
  # shellcheck disable=SC2317 # customize.sh is sourced by managers but executed by standalone tests.
  return 1 2>/dev/null || exit 1
fi

preserve_runtime_file() {
  _relative=$1
  _mode=$2
  _src="$OLD_MODULE_DIR/$_relative"
  _dst="$MODPATH/$_relative"
  _dst_dir=${_dst%/*}
  _tmp="$_dst.preserve.$$"

  [ "$OLD_MODULE_DIR" != "$MODPATH" ] || return 0
  [ -f "$_src" ] || return 0
  [ -d "$_dst_dir" ] || mkdir -p "$_dst_dir" 2>/dev/null || return 1

  rm -f "$_tmp" 2>/dev/null
  if ! cp -p "$_src" "$_tmp" 2>/dev/null && ! cp "$_src" "$_tmp" 2>/dev/null; then
    rm -f "$_tmp" 2>/dev/null
    return 1
  fi
  chmod "$_mode" "$_tmp" 2>/dev/null || { rm -f "$_tmp"; return 1; }
  mv -f "$_tmp" "$_dst" 2>/dev/null || { rm -f "$_tmp"; return 1; }
  sync "$_dst" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
  command -v ui_print >/dev/null 2>&1 && ui_print "- Preserved $_relative"
  return 0
}

preserve_blocked_config() (
  _old_core="$OLD_MODULE_DIR/scripts/core.sh"
  _snapshot_dir="$MODPATH/scripts/.preserve.snapshot.$$"
  _dst="$MODPATH/scripts/blocked.conf"
  _tmp="$_dst.preserve.$$"

  # shellcheck disable=SC2329 # Reached through the subshell EXIT trap.
  cleanup_preserve_snapshot() {
    rm -rf "$_snapshot_dir" "$_tmp" 2>/dev/null
  }
  trap cleanup_preserve_snapshot EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  rm -rf "$MODPATH/scripts/.preserve.snapshot."* "$MODPATH/scripts/blocked.conf.preserve."* 2>/dev/null

  if [ "$OLD_MODULE_DIR" != "$MODPATH" ] && [ -f "$_old_core" ]; then
    rm -rf "$_snapshot_dir" 2>/dev/null
    if mkdir -p "$_snapshot_dir" 2>/dev/null; then
      _result=$(DNCS_BACKUP_DIR="$_snapshot_dir" sh "$_old_core" backup_config 2>/dev/null)
      case "$_result" in
        BACKUP:*) _snapshot=${_result#BACKUP:} ;;
        *) _snapshot= ;;
      esac
      if [ -f "${_snapshot:-}" ] && grep -Eq '^DNCS_CONFIG_V[0-9]+$' "$_snapshot" 2>/dev/null; then
        awk -F= '/^uid=[0-9]+$/ { print $2 }' "$_snapshot" > "$_tmp" || {
          rm -rf "$_snapshot_dir" "$_tmp" 2>/dev/null
          return 1
        }
        chmod 600 "$_tmp" 2>/dev/null || { rm -rf "$_snapshot_dir" "$_tmp"; return 1; }
        mv -f "$_tmp" "$_dst" 2>/dev/null || { rm -rf "$_snapshot_dir" "$_tmp"; return 1; }
        sync "$_dst" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
        command -v ui_print >/dev/null 2>&1 && ui_print "- Preserved scripts/blocked.conf (locked snapshot)"
        return 0
      fi
    fi
    rm -rf "$_snapshot_dir" "$_tmp" 2>/dev/null
  fi

  preserve_runtime_file scripts/blocked.conf 600
)

if ! preserve_blocked_config; then
  print_install_error "blocked.conf could not be preserved"
  # shellcheck disable=SC2317 # Keep sourced-installer and standalone execution behavior aligned.
  return 1 2>/dev/null || exit 1
fi
for _runtime_spec in \
  'scripts/blocked.conf.bak:600' \
  'scripts/debug.flag:600' \
  'webroot/dncs.log:644'; do
  _runtime_path=${_runtime_spec%:*}
  _runtime_mode=${_runtime_spec##*:}
  if ! preserve_runtime_file "$_runtime_path" "$_runtime_mode"; then
    print_install_error "$_runtime_path could not be preserved"
    # shellcheck disable=SC2317 # Keep sourced-installer and standalone execution behavior aligned.
    return 1 2>/dev/null || exit 1
  fi
done

if command -v set_perm >/dev/null 2>&1; then
  set_perm "$MODPATH/boot-completed.sh" 0 0 0755
  set_perm "$MODPATH/service.sh" 0 0 0755
  set_perm "$MODPATH/customize.sh" 0 0 0755
  set_perm "$MODPATH/uninstall.sh" 0 0 0755
  set_perm "$MODPATH/scripts/core.sh" 0 0 0755
else
  chmod 0755 "$MODPATH/boot-completed.sh" "$MODPATH/service.sh" "$MODPATH/customize.sh" "$MODPATH/uninstall.sh" "$MODPATH/scripts/core.sh" 2>/dev/null || true
fi

:
