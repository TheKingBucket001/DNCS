#!/system/bin/sh
MODDIR=${0%/*}
CORE_SCRIPT="$MODDIR/scripts/core.sh"
CONF_FILE="$MODDIR/scripts/blocked.conf"
GETPROP_CMD=${DNCS_GETPROP_CMD:-getprop}

PATH="/data/adb/ksu/bin:/data/adb/ap/bin:/data/adb/magisk:/system/bin:/system/xbin:/vendor/bin:/product/bin:$PATH"
export PATH

SERVICE_CHILD_PID=

record_service_error() {
  DNCS_LOCK_WAIT_SECONDS=5 sh "$CORE_SCRIPT" lifecycle_error "$1" >/dev/null 2>&1
}

# shellcheck disable=SC2329 # Reached through service signal traps.
stop_service() {
  _signal_rc=$1
  trap '' HUP INT TERM
  if [ -n "$SERVICE_CHILD_PID" ]; then
    kill -TERM "$SERVICE_CHILD_PID" 2>/dev/null || true
    wait "$SERVICE_CHILD_PID" 2>/dev/null || true
  fi
  exit "$_signal_rc"
}

trap 'stop_service 129' HUP
trap 'stop_service 130' INT
trap 'stop_service 143' TERM

[ -s "$CONF_FILE" ] || exit 0
apply_with_retries() {
  _source=$1
  _limit=$2
  _tries=0
  while [ "$_tries" -lt "$_limit" ]; do
    DNCS_LOCK_WAIT_SECONDS=2 DNCS_BOOT_SOURCE="$_source" \
      sh "$CORE_SCRIPT" boot_apply >/dev/null 2>&1 &
    SERVICE_CHILD_PID=$!
    wait "$SERVICE_CHILD_PID"
    _apply_rc=$?
    SERVICE_CHILD_PID=
    [ "$_apply_rc" -eq 0 ] && return 0
    _tries=$((_tries + 1))
    sleep 2
  done
  return 1
}

if ! apply_with_retries service-early 30; then
  record_service_error service-early || true
fi

_boot_wait=0
while [ "$($GETPROP_CMD sys.boot_completed 2>/dev/null)" != 1 ] && [ "$_boot_wait" -lt 180 ]; do
  sleep 2
  _boot_wait=$((_boot_wait + 2))
done
if [ "$($GETPROP_CMD sys.boot_completed 2>/dev/null)" != 1 ]; then
  record_service_error service-timeout || true
  exit 1
fi

if ! apply_with_retries service-final 15; then
  record_service_error service-final || true
  exit 1
fi

exit 0
