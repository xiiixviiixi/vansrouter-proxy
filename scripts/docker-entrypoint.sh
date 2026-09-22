#!/bin/sh
# VansRouter + Headroom supervisor entrypoint.
#
# Runs the VansRouter Node server and the local Headroom proxy concurrently in
# one container. Headroom is optional: if it is missing or exits, VansRouter
# keeps serving requests and compression fails open upstream.
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
HEADROOM_ENABLED="${HEADROOM_ENABLED:-1}"
HEADROOM_HOST="${HEADROOM_HOST:-127.0.0.1}"
HEADROOM_PORT="${HEADROOM_PORT:-8787}"
HEADROOM_DIR="$DATA_DIR/headroom"
HEADROOM_PID_FILE="$HEADROOM_DIR/proxy.pid"
HEADROOM_LOG_FILE="$HEADROOM_DIR/proxy.log"
HEADROOM_DISABLED_FILE="$HEADROOM_DIR/supervisor.disabled"

log() {
  printf '%s [%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" "$2"
}

sanitize_int() {
  value="$1"
  default_value="$2"
  min_value="$3"
  max_value="$4"
  case "$value" in
    ''|*[!0-9]*)
      printf '%s' "$default_value"
      return 0
      ;;
  esac
  if [ "$value" -lt "$min_value" ]; then value="$min_value"; fi
  if [ "$value" -gt "$max_value" ]; then value="$max_value"; fi
  printf '%s' "$value"
}

HEADROOM_MAX_RESTARTS=$(sanitize_int "${HEADROOM_MAX_RESTARTS:-5}" 5 0 20)
HEADROOM_RESTART_DELAY=$(sanitize_int "${HEADROOM_RESTART_DELAY:-2}" 2 0 30)

case "$HEADROOM_PORT" in
  ''|*[!0-9]*)
    HEADROOM_PORT=8787
    ;;
  *)
    if [ "$HEADROOM_PORT" -lt 1 ] || [ "$HEADROOM_PORT" -gt 65535 ]; then
      HEADROOM_PORT=8787
    fi
    ;;
esac

# Never bind the managed proxy to a non-loopback interface from this entrypoint.
case "$HEADROOM_HOST" in
  127.0.0.1|localhost|::1)
    ;;
  *)
    log headroom "refusing non-loopback HEADROOM_HOST=$HEADROOM_HOST; using 127.0.0.1"
    HEADROOM_HOST=127.0.0.1
    ;;
esac

copy_missing() {
  source_dir=$1
  target_dir=$2
  entry=
  name=
  destination=
  mkdir -p "$target_dir"
  for entry in "$source_dir"/* "$source_dir"/.[!.]* "$source_dir"/..?*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    destination="$target_dir/$name"
    if [ -d "$entry" ]; then
      copy_missing "$entry" "$destination"
    elif [ ! -e "$destination" ]; then
      cp -a "$entry" "$destination"
    fi
  done
}

migrate_legacy_volume() {
  if [ ! -f /app/data/db/.legacy-volume-migrated ] && [ ! -e /app/data/db/data.sqlite ] && [ -d /migration-data ]; then
    copy_missing /migration-data /app/data
    mkdir -p /app/data/db
    touch /app/data/db/.legacy-volume-migrated
  fi
}

is_pid() {
  case "${1:-}" in
    ''|*[!0-9]*)
      return 1
      ;;
  esac
  return 0
}

proc_state() {
  pid=$1
  stat_file="/proc/$pid/stat"
  stat_text=
  rest=
  state=
  if [ ! -r "$stat_file" ]; then return 1; fi
  stat_text=$(cat "$stat_file" 2>/dev/null) || return 1
  # Command names may contain spaces/parentheses; split after the last ") ".
  rest=${stat_text##*) }
  state=${rest%% *}
  if [ -z "$state" ]; then return 1; fi
  printf '%s' "$state"
}

pid_is_headroom() {
  pid=$1
  if ! is_pid "$pid"; then return 1; fi
  if [ ! -r "/proc/$pid/cmdline" ]; then return 1; fi
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qai headroom
}

pid_is_healthy_headroom() {
  pid=$1
  state=
  if ! pid_is_headroom "$pid"; then return 1; fi
  state=$(proc_state "$pid") || return 1
  case "$state" in
    Z|X|x)
      return 1
      ;;
  esac
  return 0
}

read_pid_file() {
  pid=
  if [ ! -f "$HEADROOM_PID_FILE" ]; then return 1; fi
  pid=$(cat "$HEADROOM_PID_FILE" 2>/dev/null) || return 1
  if ! is_pid "$pid"; then
    rm -f "$HEADROOM_PID_FILE"
    return 1
  fi
  printf '%s' "$pid"
}

start_headroom_child() {
  if [ "$HEADROOM_ENABLED" != "1" ]; then return 1; fi
  if [ -f "$HEADROOM_DISABLED_FILE" ]; then return 1; fi
  if ! command -v headroom >/dev/null 2>&1; then
    log headroom "headroom CLI not found; continuing without compression"
    HEADROOM_ENABLED=0
    return 1
  fi
  log headroom "starting proxy on ${HEADROOM_HOST}:${HEADROOM_PORT}"
  # Low-memory local profile: no telemetry, no disk state, no semantic cache,
  # no rate limiter, no subscription polling, no CCR markers, no Kompress model.
  gosu node headroom proxy \
    --host "$HEADROOM_HOST" \
    --port "$HEADROOM_PORT" \
    --no-telemetry \
    --stateless \
    --no-ccr \
    --no-cache \
    --no-rate-limit \
    --no-subscription-tracking \
    --disable-kompress \
    --disable-kompress-fallback \
    --workers 1 \
    --limit-concurrency "${HEADROOM_LIMIT_CONCURRENCY:-8}" \
    --max-connections "${HEADROOM_MAX_CONNECTIONS:-16}" \
    --max-keepalive "${HEADROOM_MAX_KEEPALIVE:-4}" \
    --keepalive-expiry "${HEADROOM_KEEPALIVE_EXPIRY:-10}" \
    --compression-max-workers "${HEADROOM_COMPRESSION_MAX_WORKERS:-1}" \
    --anthropic-pre-upstream-concurrency "${HEADROOM_ANTHROPIC_PRE_UPSTREAM_CONCURRENCY:-2}" \
    >>"$HEADROOM_LOG_FILE" 2>&1 &
  headroom_child_pid=$!
  printf '%s' "$headroom_child_pid" > "$HEADROOM_PID_FILE"
  chown node:node "$HEADROOM_PID_FILE" "$HEADROOM_LOG_FILE" 2>/dev/null || true
  headroom_started_at=$(date +%s)
  if [ "$headroom_restarts" -eq 0 ]; then headroom_first_failure="$headroom_started_at"; fi
  headroom_restarts=$((headroom_restarts + 1))
  log headroom "started pid=${headroom_child_pid} restart=${headroom_restarts}"
}

supervise_headroom() {
  headroom_child_pid=""
  headroom_restarts=0
  headroom_first_failure=0
  headroom_started_at=0
  pid=""
  now=0

  while :; do
    if [ "$HEADROOM_ENABLED" = "1" ] && [ ! -f "$HEADROOM_DISABLED_FILE" ]; then
      pid=$(read_pid_file || true)
      if [ -n "$pid" ] && pid_is_healthy_headroom "$pid"; then
        # Adopt proxies started through the dashboard; only the supervisor's
        # own child can be reaped directly.
        if [ "$headroom_child_pid" != "$pid" ]; then headroom_child_pid=""; fi
        now=$(date +%s)
        if [ "$headroom_restarts" -gt 0 ] && [ "$headroom_started_at" -gt 0 ] && [ $((now - headroom_started_at)) -ge 60 ]; then
          headroom_restarts=0
        fi
        sleep 2
        continue
      fi
      if [ -n "$headroom_child_pid" ]; then
        wait "$headroom_child_pid" 2>/dev/null || true
        headroom_child_pid=""
      fi
      rm -f "$HEADROOM_PID_FILE"
      now=$(date +%s)
      if [ "$headroom_restarts" -ge "$HEADROOM_MAX_RESTARTS" ] && [ $((now - headroom_first_failure)) -lt 300 ]; then
        log headroom "restart backoff active; VansRouter continues without compression"
        sleep 5
        continue
      fi
      if [ "$headroom_restarts" -ge "$HEADROOM_MAX_RESTARTS" ]; then headroom_restarts=0; fi
      sleep "$HEADROOM_RESTART_DELAY"
      if [ "$HEADROOM_ENABLED" = "1" ] && [ ! -f "$HEADROOM_DISABLED_FILE" ]; then
        start_headroom_child || sleep "$HEADROOM_RESTART_DELAY"
      fi
    else
      # Manual stop/disabled: reap the supervisor's own child if it exited and
      # drop stale PID files so status stays accurate. Never restart here.
      pid=$(read_pid_file || true)
      if [ -n "$pid" ] && ! pid_is_healthy_headroom "$pid"; then
        if [ -z "$headroom_child_pid" ] || [ "$pid" = "$headroom_child_pid" ]; then
          rm -f "$HEADROOM_PID_FILE"
        fi
      fi
      if [ -n "$headroom_child_pid" ] && ! pid_is_healthy_headroom "$headroom_child_pid"; then
        wait "$headroom_child_pid" 2>/dev/null || true
        headroom_child_pid=""
      fi
      sleep 2
    fi
  done
}

kill_pidfile_headroom() {
  pid=$(read_pid_file || true)
  if [ -z "$pid" ]; then return 0; fi
  if pid_is_healthy_headroom "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    i=0
    while pid_is_healthy_headroom "$pid" && [ "$i" -lt 50 ]; do
      sleep 0.1 2>/dev/null || sleep 1
      i=$((i + 1))
    done
    if pid_is_healthy_headroom "$pid"; then kill -KILL "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$HEADROOM_PID_FILE"
}

shutdown() {
  trap - TERM INT
  log vansrouter "received shutdown signal"
  if [ -n "${supervisor_pid:-}" ]; then kill -TERM "$supervisor_pid" 2>/dev/null || true; fi
  if [ -n "${node_pid:-}" ]; then kill -TERM "$node_pid" 2>/dev/null || true; fi
  kill_pidfile_headroom
  i=0
  while [ -n "${node_pid:-}" ] && kill -0 "$node_pid" 2>/dev/null && [ "$i" -lt 10 ]; do
    sleep 1
    i=$((i + 1))
  done
  if [ -n "${node_pid:-}" ] && kill -0 "$node_pid" 2>/dev/null; then kill -KILL "$node_pid" 2>/dev/null || true; fi
  if [ -n "${node_pid:-}" ]; then wait "$node_pid" 2>/dev/null || true; fi
  if [ -n "${supervisor_pid:-}" ]; then wait "$supervisor_pid" 2>/dev/null || true; fi
  exit 143
}

trap shutdown TERM INT

migrate_legacy_volume
mkdir -p /app/data /app/data-home "$HEADROOM_DIR"
chown -R node:node /app/data /app/data-home 2>/dev/null || true
rm -f "$HEADROOM_PID_FILE" "$HEADROOM_DISABLED_FILE"

export HEADROOM_SUPERVISED=1

supervise_headroom &
supervisor_pid=$!

if [ "$#" -eq 0 ]; then
  log vansrouter "no command supplied to entrypoint"
  kill -TERM "$supervisor_pid" 2>/dev/null || true
  exit 1
fi

log vansrouter "starting $*"
gosu node "$@" &
node_pid=$!

wait "$node_pid"
node_status=$?

kill -TERM "$supervisor_pid" 2>/dev/null || true
wait "$supervisor_pid" 2>/dev/null || true
kill_pidfile_headroom
exit "$node_status"
