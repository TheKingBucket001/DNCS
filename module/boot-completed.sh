#!/system/bin/sh
MODDIR=${0%/*}
CONF_FILE="$MODDIR/scripts/blocked.conf"

[ -s "$CONF_FILE" ] || exit 0
if ! DNCS_BOOT_SOURCE=boot-completed sh "$MODDIR/scripts/core.sh" boot_apply >/dev/null 2>&1; then
  DNCS_LOCK_WAIT_SECONDS=5 sh "$MODDIR/scripts/core.sh" lifecycle_error boot-completed >/dev/null 2>&1 || true
fi
exit 0
