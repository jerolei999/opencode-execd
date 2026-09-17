#!/usr/bin/env bash
# Edge matrix v2: byte-level output fidelity, argument bounds, process leakage, egress,
# memory. One reused session per backend + explicit release, so adapter capacity noise is gone.
set -uo pipefail
WS=${WS:-/private/tmp/workspace}
U1=$WS/users/user01
pass=0; fail=0; declare -a RESULTS=()

sh_in_ws() { docker run --rm -v "$WS:$WS" alpine:3.20 sh -lc "$1"; }

raw() { # base token session root cwd command [extra]
  local body
  body=$(python3 - "$3" "$4" "$5" "$6" "${7:-}" <<'PY'
import json,sys
b={"sessionID":sys.argv[1],"workspaceID":"w","root":sys.argv[2],"cwd":sys.argv[3],"command":sys.argv[4],"shell":"/bin/bash","timeoutMs":60000}
if sys.argv[5]: b.update(json.loads(sys.argv[5]))
print(json.dumps(b))
PY
)
  curl -s -m 120 -X POST "$1/execute" -H "Authorization: Bearer $2" -H 'content-type: application/json' --data "$body"
}

# byte-level probe: prints "exit|len|b64(out)" so nothing is lost in the terminal
bytes_of() { python3 -c '
import base64,json,sys
raw=sys.stdin.read()
try: d=json.loads(raw)
except Exception: print("ERR|"+raw[:120]); raise SystemExit
if "error" in d: print("ERR|"+str(d["error"])[:120]); raise SystemExit
out=d["output"].encode()
print(f"{d[chr(34)+chr(34)] if False else d[chr(101)+chr(120)+chr(105)+chr(116)+chr(67)+chr(111)+chr(100)+chr(101)]}|{len(out)}|{base64.b64encode(out).decode()}")'; }
check() { local n=$1 w=$2 g=$3 s; if [[ "$g" == *"$w"* ]]; then s=PASS; pass=$((pass+1)); else s=FAIL; fail=$((fail+1)); fi
  RESULTS+=("$s|$n|$(echo "$g" | head -c 120)"); printf "  %-4s %-52s %s\n" "$s" "$n" "$(echo "$g" | head -c 58)"; }

run_backend() {
  local L=$1 B=$2 T=$3
  local S="${L}-edge2"
  echo; echo "### backend: $L"
  # output fidelity (compare raw bytes via base64)
  check "ANSI escape bytes intact"         "$(printf '\033[31mRED\033[0m\n' | base64)" "$(raw "$B" "$T" "$S" "$U1" "$U1" "printf '\033[31mRED\033[0m\n'" | bytes_of | cut -d'|' -f3)"
  check "CRLF bytes intact"                "$(printf 'x\r\n' | base64)"              "$(raw "$B" "$T" "$S" "$U1" "$U1" "printf 'x\r\n'" | bytes_of | cut -d'|' -f3)"
  check "NUL byte intact + length 4"       "$(printf 'a\0b\n' | base64)"             "$(raw "$B" "$T" "$S" "$U1" "$U1" "printf 'a\0b\n'" | bytes_of | cut -d'|' -f3)"
  check "no-trailing-newline is re-terminated (1 byte -> 2)" "2|" "$(raw "$B" "$T" "$S" "$U1" "$U1" "printf z" | bytes_of | cut -d'|' -f1,2)"
  check "invalid UTF-8 bytes are not dropped" "3|" "$(raw "$B" "$T" "$S" "$U1" "$U1" "printf '\xff\xfe\xfd'" | bytes_of | cut -d'|' -f1,2)"
  # argument bounds
  check "100KB command runs (comment after printf)" "0|ok-100k" "$(raw "$B" "$T" "$S" "$U1" "$U1" "printf 'ok-100k\n' # $(python3 -c 'print("a"*100000)')" | bytes_of >/dev/null; raw "$B" "$T" "$S" "$U1" "$U1" "printf 'ok-100k\n' # $(python3 -c 'print("a"*100000)')" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(str(d.get("exitCode"))+"|"+d.get("output",""))' | sed 's/$//' | tr -d '\n')"
  check "timeoutMs=-1 rejected with a clear error" "ERR|" "$(raw "$B" "$T" "$S" "$U1" "$U1" "echo done" '{"timeoutMs":-1}' | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ERR|"+str(d["error"])[:80] if "error" in d else "0|"+d.get("output",""))')"
  check "maxOutputBytes=1 returns exactly 1 byte" "1|" "$(raw "$B" "$T" "$S" "$U1" "$U1" "printf abcdef" '{"maxOutputBytes":1}' | bytes_of | cut -d'|' -f1,2)"
  # process / resource
  check "detached background process survives the call" "0|started" "$(raw "$B" "$T" "$S" "$U1" "$U1" 'setsid sleep 300 >/dev/null 2>&1 & printf "started\n"' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(str(d.get("exitCode"))+"|"+d.get("output","").strip())')"
  local container; container=$(docker ps --format '{{.Names}}' | grep -m1 -E '^sandbox-|^opencode-execd-cfs')
  check "leaked sleep visible in the container" "LEAK" "$(docker exec "$container" sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < $p/cmdline 2>/dev/null | grep -q "sleep 300" && echo LEAK && break; done' 2>/dev/null | tr -d '\n' | sed 's/^$/none/')"
  check "egress: sandbox can reach the npm mirror" "200" "$(raw "$B" "$T" "$S" "$U1" "$U1" 'bun -e "console.log(await (await fetch(\"https://registry.npmmirror.com\",{signal:AbortSignal.timeout(8000)})).status)" 2>/dev/null || echo FAIL' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("output","FAIL").strip() or "FAIL")')"
  check "memory spike contained (1.4GB alloc)" "0|" "$(raw "$B" "$T" "$S" "$U1" "$U1" 'bun -e "const a=new Uint8Array(1400*1024*1024); a[0]=1; console.log(a.length)"' | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ERR|"+str(d["error"])[:60] if "error" in d else str(d.get("exitCode"))+"|"+d.get("output","").strip())')"
  curl -s -X POST "$B/release" -H "Authorization: Bearer $T" -H 'content-type: application/json' --data '{"sessionID":"'"$S"'"}' >/dev/null
  check "leak after release (worker keeps it, sandbox dies with container)" "none" "$(docker exec "$container" sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < $p/cmdline 2>/dev/null | grep -q "sleep 300" && echo LEAK && break; done' 2>/dev/null | tr -d '\n' | sed 's/^$/none/')"
  local second; second=$(curl -s -X POST "$B/release" -H "Authorization: Bearer $T" -H 'content-type: application/json' --data '{"sessionID":"'"$S"'"}' | python3 -c 'import json,sys; print(str(json.load(sys.stdin).get("released")).lower())')
  check "release is idempotent" "false" "$second"
  # empty command: worker validates, record adapter difference explicitly
  check "empty command -> $( [[ $L == worker ]] && echo 'rejected' || echo 'accepted by execd' )" "$( [[ $L == worker ]] && echo 'ERR|' || echo '0|' )" "$(raw "$B" "$T" "$S" "$U1" "$U1" "" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ERR|"+str(d["error"])[:60] if "error" in d else "0|"+d.get("output",""))')"
}

run_backend "worker"  "${WORKER:-http://127.0.0.1:19040}" "${WORKER_TOKEN:-cfs-secret}"
run_backend "adapter" "${ADAPTER:-http://127.0.0.1:19050}" "${ADAPTER_TOKEN:-cfs-secret}"
echo; echo "TOTAL: $pass passed, $fail failed"
printf '%s\n' "${RESULTS[@]}" > /tmp/edge2-results.txt
