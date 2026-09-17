#!/usr/bin/env bash
# Common-scenario matrix for both backends (worker pool vs OpenSandbox-server sandboxes),
# driven through the plugin's /execute contract, workspace on CubeFS.
set -uo pipefail
WS=${WS:-/private/tmp/workspace}
U1=$WS/users/user01
U2=$WS/users/user02
pass=0; fail=0; declare -a RESULTS=()

sh_in_ws() { docker run --rm -v "$WS:$WS" alpine:3.20 sh -lc "$1"; }

raw_json() { # base token session root cwd command [extra-json] -> raw response
  local body
  body=$(python3 - "$3" "$4" "$5" "$6" "${7:-}" <<'PY'
import json,sys
body={"sessionID":sys.argv[1],"workspaceID":"w","root":sys.argv[2],"cwd":sys.argv[3],"command":sys.argv[4],"shell":"/bin/bash","timeoutMs":60000}
if sys.argv[5]: body.update(json.loads(sys.argv[5]))
print(json.dumps(body))
PY
)
  curl -s -m 90 -X POST "$1/execute" -H "Authorization: Bearer $2" -H 'content-type: application/json' --data "$body"
}

fmt() { python3 -c '
import json,sys
raw=sys.stdin.read()
try: d=json.loads(raw)
except Exception:
    print("ERR|"+raw[:140]); raise SystemExit
print("ERR|"+str(d["error"])[:140] if "error" in d else str(d["exitCode"])+"|"+d["output"].replace("\n","\\n")[:200])'; }

ex() { raw_json "$@" | fmt; }
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1].replace('D','d.get')))" "$1"; }

check() { local name=$1 want=$2 got=$3 status
  if [[ "$got" == *"$want"* ]]; then status=PASS; pass=$((pass+1)); else status=FAIL; fail=$((fail+1)); fi
  RESULTS+=("$status|$name|$(echo "$got" | head -c 100)")
  printf "  %-4s %-50s %s\n" "$status" "$name" "$(echo "$got" | head -c 62)"; }

capacity_of() { curl -s -m 10 "$1/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("capacity",0))'; }

run_backend() {
  local L=$1 B=$2 T=$3 SEQ="$1-seq"
  echo; echo "### backend: $L ($B)"
  check "default cwd = project dir" "$U1" "$(ex "$B" "$T" "$SEQ" "$U1" "$U1" 'pwd')"
  check "workdir = existing subdir" "$U1/sub" "$(ex "$B" "$T" "$SEQ" "$U1" "$U1/sub" 'pwd')"
  check "absolute workdir inside root" "$U2" "$(ex "$B" "$T" "$SEQ" "$U2" "$U2" 'pwd')"
  check "exit 0" "0|" "$(ex "$B" "$T" "$SEQ" "$U1" "$U1" 'true')"
  check "exit 1 is a result, not an error" "1|" "$(ex "$B" "$T" "$SEQ" "$U1" "$U1" 'exit 1')"
  check "exit 7 keeps stderr" "7|boom" "$(ex "$B" "$T" "$SEQ" "$U1" "$U1" 'printf boom >&2; exit 7')"
  check "exit 127 for missing binary" "127|" "$(ex "$B" "$T" "$SEQ" "$U1" "$U1" 'definitely-not-a-binary')"
  check "multi-line output preserved" 'a\nb\nc' "$(ex "$B" "$T" "$SEQ" "$U1" "$U1" "printf 'a\nb\nc\n'")"
  check "unicode preserved" '中文' "$(ex "$B" "$T" "$SEQ" "$U1" "$U1" "printf '中文 ok\n'")"
  check "secrets invisible to commands" "leak:none" \
    "$(ex "$B" "$T" "$SEQ" "$U1" "$U1" 'printf "leak:%s" "$(env | grep -cE "EXECD_ACCESS_TOKEN|OPENCODE_EXECD_WORKER_ACCESS_TOKEN")"' | sed 's/leak:0/leak:none/')"
  check "root outside workspace rejected" "outside" "$(ex "$B" "$T" "$SEQ" "/etc" "/etc" 'pwd')"
  check "cwd outside own root rejected" "outside" "$(ex "$B" "$T" "$SEQ" "$U1" "$U2" 'cat who.txt')"
  check "cubeFS read: container-written file" "written-by-container" "$(ex "$B" "$T" "$SEQ" "$U1" "$U1" 'cat from-container.txt')"
  ex "$B" "$T" "$SEQ" "$U1" "$U1" 'printf sandbox-wrote > from-sandbox.txt' >/dev/null
  check "cubeFS write: visible to another container" "sandbox-wrote" "$(sh_in_ws "cat $U1/from-sandbox.txt")"
  check "large output flagged truncated" "True|1048576" \
    "$(raw_json "$B" "$T" "$SEQ-trunc" "$U1" "$U1" "head -c 3145728 /dev/zero | tr '\\0' a" '{"maxOutputBytes":1048576}' \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print(str(d.get("outputTruncated"))+"|"+str(len(d.get("output",""))))')"
  check "timeout kills a long command" "True" \
    "$(raw_json "$B" "$T" "$SEQ-to" "$U1" "$U1" "sleep 30; echo SHOULD-NOT-APPEAR" '{"timeoutMs":3000}' \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print("True" if "SHOULD-NOT-APPEAR" not in d.get("output","") else "False")')"
  local busy="$L-busy"
  ( ex "$B" "$T" "$busy" "$U1" "$U1" 'sleep 5; echo first-done' > /tmp/busy1.out ) &
  sleep 1.5
  check "same session: second command rejected" "already executing" "$(ex "$B" "$T" "$busy" "$U1" "$U1" 'echo second')"
  wait
  check "first command still completed" "first-done" "$(cat /tmp/busy1.out)"
  local cap n errs; cap=$(capacity_of "$B"); n=$((cap+1)); rm -f /tmp/cap-*.out
  for i in $(seq 1 "$n"); do ( ex "$B" "$T" "$L-cap-$i" "$U1" "$U1" 'sleep 5' > /tmp/cap-$i.out ) & done
  sleep 2.5
  errs=$(grep -l "capacit\|exhausted" /tmp/cap-*.out 2>/dev/null | wc -l | tr -d ' ')
  check "beyond capacity=$cap rejected" "yes" "$([ "$errs" -ge 1 ] && echo yes || echo "no($errs)")"
  wait 2>/dev/null
  for i in $(seq 1 "$n"); do curl -s -X POST "$B/release" -H "Authorization: Bearer $T" -H 'content-type: application/json' --data '{"sessionID":"'"$L"'-cap-'"$i"'"}' >/dev/null; done
  for s in "$SEQ" "$SEQ-trunc" "$SEQ-to" "$busy" "$L-busy"; do curl -s -X POST "$B/release" -H "Authorization: Bearer $T" -H 'content-type: application/json' --data '{"sessionID":"'"$s"'"}' >/dev/null; done
}

sh_in_ws "mkdir -p $U1/sub; printf 'who=user01\n' > $U1/who.txt; printf 'who=user02\n' > $U2/who.txt; printf 'written-by-container\n' > $U1/from-container.txt"
echo "seeded CubeFS: $U1/sub, who.txt, from-container.txt"
run_backend "worker"  "${WORKER:-http://127.0.0.1:19040}" "${WORKER_TOKEN:-cfs-secret}"
run_backend "adapter" "${ADAPTER:-http://127.0.0.1:19050}" "${ADAPTER_TOKEN:-cfs-secret}"

echo; echo "### release semantics"
S=worker-release
curl -s -X POST "${WORKER:-http://127.0.0.1:19040}/execute" -H "Authorization: Bearer ${WORKER_TOKEN:-cfs-secret}" -H 'content-type: application/json' \
  --data '{"sessionID":"'"$S"'","workspaceID":"w","root":"'"$U1"'","cwd":"'"$U1"'","command":"true","shell":"/bin/bash"}' >/dev/null
dir="/tmp/opencode-sessions/$(python3 -c "import hashlib;print(hashlib.sha256(b'$S').hexdigest()[:32])")"
curl -s -X POST "${WORKER:-http://127.0.0.1:19040}/release" -H "Authorization: Bearer ${WORKER_TOKEN:-cfs-secret}" -H 'content-type: application/json' --data '{"sessionID":"'"$S"'"}' >/dev/null
check "worker /release removes its session home dir" "missing" "$(ex "${WORKER:-http://127.0.0.1:19040}" "${WORKER_TOKEN:-cfs-secret}" probe1 "$U1" "$U1" "test -d $dir && echo present || echo missing")"
before=$(docker ps --format '{{.Names}}' | grep -cE '^sandbox-' || true)
AS=adapter-release
ex "${ADAPTER:-http://127.0.0.1:19050}" "${ADAPTER_TOKEN:-cfs-secret}" "$AS" "$U1" "$U1" 'echo warm' >/dev/null
mid=$(docker ps --format '{{.Names}}' | grep -cE '^sandbox-' || true)
curl -s -X POST "${ADAPTER:-http://127.0.0.1:19050}/release" -H "Authorization: Bearer ${ADAPTER_TOKEN:-cfs-secret}" -H 'content-type: application/json' --data '{"sessionID":"'"$AS"'"}' >/dev/null
sleep 3; post=$(docker ps --format '{{.Names}}' | grep -cE '^sandbox-' || true)
check "adapter /release deletes the sandbox" "yes" "$([ "$mid" -gt "$before" ] && [ "$post" -lt "$mid" ] && echo yes || echo "no($before->$mid->$post)")"

echo; echo "TOTAL: $pass passed, $fail failed"
printf '%s\n' "${RESULTS[@]}" > /tmp/matrix-results.txt
