#!/usr/bin/env bash
# s3-mount-it.sh — run cube/host-mount-s3.integration.test.mjs for real:
# a throwaway MinIO and a throwaway runner container (root, /dev/fuse, rclone,
# fusermount3). Builds NO image. Leaves nothing behind.
#
#   scripts/s3-mount-it.sh <runner-image> <rclone-binary>
#
# <runner-image> needs node >= 22.15 and apt (the sandbox-runtime image works).
set -euo pipefail
IMAGE="${1:?runner image}"; RCLONE="$(realpath "${2:?rclone binary}")"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ID="cac-s3it-$$"
cleanup() { docker rm -f "$ID-minio" "$ID-run" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# No network of its own: this host has no free docker address pool ("all
# predefined address pools have been fully subnetted"), and the runner only
# needs MinIO, so it joins MinIO's namespace (default bridge: apt still works) and dials 127.0.0.1.
# STORE=minio (default) or STORE=seaweedfs — the bundle's own store, through its
# S3 gateway with authentication ON (no identities = anonymous = proves nothing).
case "${STORE:-minio}" in
  minio)
    PORT=9000
    docker run -d --name "$ID-minio" --memory 512m \
      -e MINIO_ROOT_USER=cacit -e MINIO_ROOT_PASSWORD=cacit-secret-1 minio/minio:latest server /data >/dev/null ;;
  seaweedfs)
    PORT=8333
    docker run -d --name "$ID-minio" --memory 768m --entrypoint sh chrislusf/seaweedfs:4.41 -c '
      printf "%s" "{\"identities\":[{\"name\":\"cac\",\"credentials\":[{\"accessKey\":\"cacit\",\"secretKey\":\"cacit-secret-1\"}],\"actions\":[\"Admin\",\"Read\",\"Write\",\"List\",\"Tagging\"]}]}" > /tmp/s3.json
      exec weed server -dir=/data -s3 -s3.config=/tmp/s3.json -master.volumeSizeLimitMB=64 -volume.max=4' >/dev/null ;;
  *) echo "STORE must be minio or seaweedfs" >&2; exit 2 ;;
esac
docker run --rm --name "$ID-run" --network "container:$ID-minio" --memory 1g \
  --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor=unconfined \
  -v "$REPO:/repo:ro" -v "$RCLONE:/usr/local/bin/rclone:ro" \
  -e CAC_S3_IT=1 -e S3_ENDPOINT="http://127.0.0.1:$PORT" -e S3_BUCKET=cac-it \
  -e S3_ACCESS_KEY=cacit -e S3_SECRET_KEY=cacit-secret-1 -e S3_REGION=us-east-1 \
  --entrypoint sh "$IMAGE" -c '
    set -e
    (apt-get update -qq && apt-get install -y -qq --no-install-recommends fuse3 git) >/dev/null 2>&1
    # Any HTTP answer means the gateway is up (MinIO 403s an unsigned GET too).
    for i in $(seq 1 60); do node -e "fetch(process.env.S3_ENDPOINT).then(()=>process.exit(0),()=>process.exit(1))" && break; sleep 1; done
    RCLONE_CONFIG=/dev/null RCLONE_S3_PROVIDER=Other RCLONE_S3_ENDPOINT=$S3_ENDPOINT RCLONE_S3_ACCESS_KEY_ID=$S3_ACCESS_KEY RCLONE_S3_SECRET_ACCESS_KEY=$S3_SECRET_KEY rclone mkdir :s3:$S3_BUCKET
    cd /repo/runtime
    D=apps/sandbox-runtime/src/doctor/storage-doctor.mjs
    export SANDBOX_WORKSPACE_MOUNT=host SANDBOX_HOST_MOUNT_DRIVER=s3
    echo "== doctor: good store"; node $D
    echo "== doctor: missing bucket"; if S3_BUCKET=no-such-bucket node $D; then echo "DOCTOR PASSED A MISSING BUCKET"; exit 1; fi
    echo "== doctor: wrong key"; if S3_ACCESS_KEY=wrong node $D; then echo "DOCTOR PASSED A WRONG KEY"; exit 1; fi
    unset SANDBOX_WORKSPACE_MOUNT SANDBOX_HOST_MOUNT_DRIVER
    # A skip is a failure here: this container exists to provide what every
    # skip reason names, so a skip means the run proved nothing.
    cd /repo && node --test --test-timeout=60000 runtime/apps/sandbox-runtime/src/cube/host-mount-s3.integration.test.mjs | tee /tmp/it.out
    # (sh has no pipefail: the pipe exits with tee'"'"'s status, so check fail too.)
    grep -q "^# fail 0$" /tmp/it.out || { echo "INTEGRATION TESTS FAILED"; exit 1; }
    grep -q "^# skipped 0$" /tmp/it.out || { echo "INTEGRATION TESTS SKIPPED: $(grep -m1 "# SKIP" /tmp/it.out)"; exit 1; }'
