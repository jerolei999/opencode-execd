#!/usr/bin/env bash
set -euo pipefail

: "${EXECD_ACCESS_TOKEN:?EXECD_ACCESS_TOKEN is required}"

env -i \
  HOME=/tmp \
  LANG="${LANG:-C.UTF-8}" \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  /usr/local/bin/execd \
  --port="${OPENSANDBOX_EXECD_PORT:-44772}" \
  --access-token="${EXECD_ACCESS_TOKEN}" &
execd_pid=$!
bun run src/index.ts &
worker_pid=$!

shutdown() {
  kill -TERM "${worker_pid}" "${execd_pid}" 2>/dev/null || true
  wait "${worker_pid}" 2>/dev/null || true
  wait "${execd_pid}" 2>/dev/null || true
}

trap shutdown EXIT INT TERM
wait -n "${worker_pid}" "${execd_pid}"
