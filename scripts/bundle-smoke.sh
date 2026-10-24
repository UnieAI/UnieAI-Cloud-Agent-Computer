#!/usr/bin/env bash
# bundle-smoke.sh — the P2 gate: "one command up, and it works", end to end.
#
# Brings the bundle up (deploy/compose, bundled SeaweedFS) in its own project,
# then drives it as a namespaced caller would:
#   1. allocate a sandbox with a user workspace
#   2. write a file through the API        → the sandbox's shell reads it at once
#   3. write a file from the sandbox       → the API (the file panel) reads it
#   4. git init + commit inside /workspace (every file is uid 0 on the mount)
#   5. the sandbox's files are 0660, it cannot see the store, it holds no S3 key
#   6. release
# and tears everything down, volumes and the sandbox network included.
#
# It builds NOTHING. The images must exist (ask before building them):
#   docker build -f docker/sandbox-runtime/Dockerfile -t cac/runtime:local .
#   docker build -f docker/sandbox-template/Dockerfile -t cac-sandbox:local .
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_DIR="$REPO/deploy/compose"
PROJECT="cac-smoke-$$"
PORT="${CAC_SMOKE_PORT:-14020}"
WORK="$(mktemp -d)"
ENV_FILE="$COMPOSE_DIR/.env"
[ -e "$ENV_FILE" ] && { echo "refusing: $ENV_FILE exists (a real deployment's config?). Move it aside first." >&2; exit 2; }

for img in "${CAC_IMAGE:-cac/runtime:local}" "${SANDBOX_DOCKER_IMAGE:-cac-sandbox:local}" chrislusf/seaweedfs:4.41; do
  docker image inspect "$img" >/dev/null 2>&1 || { echo "missing image $img — build it first (see the header)" >&2; exit 2; }
done

KEY="$(openssl rand -hex 32)"
cat > "$ENV_FILE" <<EOF
S3_ENDPOINT=http://seaweedfs:8333
S3_BUCKET=cac-smoke
S3_ACCESS_KEY=$(openssl rand -hex 12)
S3_SECRET_KEY=$(openssl rand -hex 24)
S3_REGION=us-east-1
CAC_CALLERS=[{"id":"smoke","namespace":"smoke","key_sha256":"$(printf %s "$KEY" | sha256sum | cut -d' ' -f1)"}]
SANDBOX_DOCKER_IMAGE=${SANDBOX_DOCKER_IMAGE:-cac-sandbox:local}
SANDBOX_POOL_TOTAL_MAX=2
SANDBOX_POOL_WARM_MIN=0
EOF
export CAC_PROJECT="$PROJECT" CAC_PORT="$PORT" CAC_MOUNT_ROOT="/var/lib/$PROJECT/mnt"
export CAC_STORE_SUBNET="${CAC_SMOKE_STORE_SUBNET:-10.89.250.0/24}" CAC_SANDBOX_SUBNET="${CAC_SMOKE_SANDBOX_SUBNET:-10.89.251.0/24}"
compose() { docker compose -f "$COMPOSE_DIR/docker-compose.yml" --env-file "$ENV_FILE" --profile bundled-s3 "$@"; }

cleanup() {
  local code=$?
  if [ $code -ne 0 ]; then echo "--- cac logs (tail)"; compose logs --no-color --tail 60 cac 2>/dev/null | grep -v '"level":"debug"' | tail -60 || true; fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  # `down` stops cac, whose shutdown removes its sandboxes. Any still here is a
  # failure (the first run left one, unnoticed: this line filtered on a label
  # that does not exist). Removed by its instance label, never by guesswork.
  LEFT="$(docker ps -aq --filter label=unieai.sandbox=1 --filter "label=unieai.instance=$PROJECT")"
  if [ -n "$LEFT" ]; then
    echo "FAIL: sandboxes left running after compose down: $LEFT"; echo "$LEFT" | xargs -r docker rm -f >/dev/null 2>&1 || true
    code=1
  fi
  docker network rm "$PROJECT-sandbox" >/dev/null 2>&1 || true
  # The mounts propagate to the host. After `down` there must be none left.
  if grep -q " $CAC_MOUNT_ROOT" /proc/mounts; then
    echo "FAIL: mounts left on the host after compose down:"; grep " $CAC_MOUNT_ROOT" /proc/mounts | cut -d' ' -f2
    docker run --rm --privileged --pid host "${CAC_IMAGE:-cac/runtime:local}" \
      nsenter -t 1 -m -- sh -c "grep ' $CAC_MOUNT_ROOT' /proc/mounts | cut -d' ' -f2 | sort -r | xargs -r -n1 umount -l" || true
    code=1
  fi
  # The mount root was created by dockerd (root); remove it the same way.
  docker run --rm -v /var/lib:/host-var-lib "${CAC_IMAGE:-cac/runtime:local}" rm -rf "/host-var-lib/$PROJECT" >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"; rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT

echo "== up ($PROJECT, port $PORT)"
compose up -d --no-build >/dev/null
BASE="http://127.0.0.1:$PORT"
for i in $(seq 1 90); do curl -sf "$BASE/healthz" >/dev/null && break; sleep 1; done
curl -sf "$BASE/healthz" >/dev/null || { echo "FAIL: cac never became healthy"; exit 1; }
echo "ok  healthz (the storage doctor passed, or the server would not have started)"

H=(-H "authorization: Bearer $KEY" -H "x-sandbox-user-id: u1")
fail() { echo "FAIL: $*"; exit 1; }

# Run a bash command in the sandbox; print its stdout; exit code in $RC.
run() {
  local id; id="$(curl -sf "${H[@]}" -H 'content-type: application/json' -X POST "$BASE/v1/sandboxes/$SBX/exec" \
    -d "$(node -e 'process.stdout.write(JSON.stringify({kind:"bash",payload:{command:process.argv[1]},timeout_ms:60000}))' "$1")" \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).exec_id))')"
  curl -sfN --max-time 90 "${H[@]}" "$BASE/v1/sandboxes/$SBX/exec/$id/stream" > "$WORK/stream"
  node -e '
    const lines=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(l=>l.startsWith("data:"));
    let out="",code=null;
    for (const l of lines){const e=JSON.parse(l.slice(5)); if(e.type==="stdout")out+=e.data; if(e.type==="exit")code=e.exit_code;}
    require("fs").writeFileSync(process.argv[1]+".rc",String(code)); process.stdout.write(out);' "$WORK/stream"
  RC="$(cat "$WORK/stream.rc")"
}

echo "== allocate"
SBX="$(curl -sf "${H[@]}" -H 'content-type: application/json' -X POST "$BASE/v1/sandboxes" \
  -d '{"user_id":"u1","session_id":"smoke-1","workspace_mode":"user"}' \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).sandbox_id))')" || fail "allocate"
[ -n "$SBX" ] || fail "allocate returned no sandbox_id"
echo "ok  sandbox $SBX"

echo "== API write → sandbox read"
curl -sf "${H[@]}" -H 'content-type: text/plain' -X POST "$BASE/v1/users/u1/workspace/file?path=docs%2Fhello.txt" --data-binary 'from the panel' >/dev/null || fail "API write"
OUT="$(run 'cat /workspace/docs/hello.txt')"
[ "$OUT" = "from the panel" ] || fail "sandbox read '$OUT' (rc=$RC), expected 'from the panel'"
echo "ok  the shell sees the API's file immediately"

echo "== sandbox write → API read"
run 'echo -n "from the agent" > /workspace/agent.txt' >/dev/null
[ "$RC" = 0 ] || fail "sandbox write rc=$RC"
GOT=""
for i in $(seq 1 30); do GOT="$(curl -sf "${H[@]}" "$BASE/v1/users/u1/workspace/file?path=agent.txt" || true)"; [ "$GOT" = "from the agent" ] && break; sleep 1; done
[ "$GOT" = "from the agent" ] || fail "API read '$GOT' after 30 s"
echo "ok  the file panel reads what the agent wrote (after ${i}s)"

echo "== git in /workspace"
OUT="$(run 'cd /workspace && git init -q repo && cd repo && echo x > f && git add f && git -c user.email=s@s -c user.name=s commit -qm first && git log --oneline | wc -l')"
[ "$RC" = 0 ] && [ "$OUT" = "1" ] || fail "git commit (rc=$RC, out=$OUT)"
echo "ok  git commits on the mount"

echo "== the sandbox's view"
OUT="$(run 'stat -c %a /workspace/agent.txt; id -u; env | grep -c "^S3_SECRET_KEY=\|^S3_ACCESS_KEY=" || true')"
set -- $OUT
[ "${1:-}" = 660 ] || fail "file mode ${1:-?}, expected 660"
[ "${2:-}" = 2468 ] || fail "the sandbox runs as uid ${2:-?}, expected 2468 (the mount's owner; root or a host account would be worse)"
[ "${3:-}" = 0 ] || fail "the sandbox holds S3 keys"
run 'python3 -c "import socket,sys;s=socket.socket();s.settimeout(3);sys.exit(0 if s.connect_ex((\"seaweedfs\",8888))==0 else 1)" 2>/dev/null; echo $?' > "$WORK/filer"
[ "$(cat "$WORK/filer")" != 0 ] || fail "the sandbox can reach the store's filer"
echo "ok  0660, non-root, no S3 key, no route to the store"

echo "== the runtime's own view"
# Warnings that each meant a real defect the first time (2026-10-24): the
# per-turn /snapshots git could not init, and an invalidation hit the mount root.
BAD="$(compose logs --no-color cac 2>/dev/null | grep -E '"event":"(pool\.baseline_snapshot_failed|host_mount\.invalidate_failed|host_mount\.reconciled)"' | grep -v '"adopted":0' || true)"
[ -z "$BAD" ] || fail "runtime warned: $BAD"
echo "ok  no snapshot, invalidation or reconcile warnings"

echo "== release"
curl -sf "${H[@]}" -X DELETE "$BASE/v1/sandboxes/$SBX" >/dev/null || fail "release"
echo "ok  released"

echo "== a sandbox left for shutdown"
# Not released: compose down must remove it (checked in cleanup).
curl -sf "${H[@]}" -H 'content-type: application/json' -X POST "$BASE/v1/sandboxes" \
  -d '{"user_id":"u1","session_id":"smoke-2","workspace_mode":"user"}' >/dev/null || fail "second allocate"
[ -n "$(docker ps -q --filter label=unieai.sandbox=1 --filter "label=unieai.instance=$PROJECT")" ] || fail "the sandbox does not carry this deployment's instance label"
echo "ok  allocated, labelled unieai.instance=$PROJECT"
echo
echo "bundle smoke: PASS"
