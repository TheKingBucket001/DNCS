#!/system/bin/sh
MODDIR=${0%/*}
CORE_SCRIPT="$MODDIR/scripts/core.sh"
FAIL_LOG=${DNCS_UNINSTALL_FAIL_LOG:-/data/adb/dncs-uninstall-error.log}

if [ ! -f "$CORE_SCRIPT" ]; then
  printf '[%s] DNCS uninstall core is missing; firewall cleanup could not be verified. Reboot is required.\n' \
    "$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null)" > "$FAIL_LOG" 2>/dev/null
  exit 1
fi
if DNCS_LOCK_WAIT_SECONDS=30 sh "$CORE_SCRIPT" rescue >/dev/null 2>&1; then
  rm -f "$FAIL_LOG" 2>/dev/null
  exit 0
fi

printf '[%s] DNCS uninstall could not remove firewall rules; reboot is required.\n' \
  "$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null)" > "$FAIL_LOG" 2>/dev/null
exit 1
