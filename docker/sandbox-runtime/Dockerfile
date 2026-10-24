# docker/sandbox-runtime/Dockerfile — per-session exec + workspace FS service.
#
# sandbox-runtime/src imports ONLY node: built-ins + sibling runtime/packages/*
# (no external npm deps), so this is a thin node image over the runtime/ tree.
#
# Build context = repo root:  docker build -f docker/sandbox-runtime/Dockerfile -t unieai/sandbox-runtime .
#
# BACKENDS (SANDBOX_MODE): `docker` (default) runs one container per sandbox on
# the daemon behind /var/run/docker.sock; `cube` drives a CubeMaster microVM
# cluster. The old zero-isolation `stub` mode no longer exists.
#
# OBJECT STORE: any S3 API (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY).
# With SANDBOX_WORKSPACE_MOUNT=host + SANDBOX_HOST_MOUNT_DRIVER=s3 this process
# mounts each workspace with rclone (needs --device /dev/fuse and CAP_SYS_ADMIN);
# the storage doctor (apps/sandbox-runtime/src/doctor/storage-doctor.mjs) says
# what is missing. See deploy/compose/ for a single-host bundle.
#
# This container itself is STATEFUL within a process (in-memory sandbox pool keyed
# by session/user in pool/manager.mjs), so it does NOT scale by naive replicas —
# either run a single replica, or front it with session-affinity routing. The
# durable workspace lives in S3 (AGENT_WORKSPACE_S3), not the pod.
FROM node:22-slim

# tini for correct PID-1 signal handling (graceful SIGTERM → drain sandboxes).
# ca-certificates: node:22-slim ships none, so the docker-CLI https download
# below (and any curl TLS) fails with exit 77 without it.
# openssh-client: the SSH execution backend (cube/ssh.mjs) runs commands on the
#   user's own machine with `spawn("ssh", …)`, and cube/ssh-ca.mjs mints the
#   15-minute certificates with `ssh-keygen`. node:22-slim ships NEITHER, so
#   without this line every bound machine fails with a bare ENOENT — which
#   surfaces to the user as「連線失敗」with nothing to act on. sftp is the file
#   path (read/write/stat/list) and ships in the same package.
# fuse3: fusermount3, which rclone needs to mount (the S3 driver). Measured: this
#   image had none, and a host's fusermount3 cannot be borrowed (glibc mismatch).
# unzip: unpacks the rclone release below.
RUN apt-get update && apt-get install -y --no-install-recommends tini curl ca-certificates openssh-client fuse3 unzip \
    && rm -rf /var/lib/apt/lists/* \
    && ssh -V && fusermount3 -V

# rclone — the mounter for SANDBOX_HOST_MOUNT_DRIVER=s3 (any S3 API). Pinned and
# checksum-verified: it holds the store's keys while it runs.
ARG RCLONE_VERSION=1.68.2
ARG RCLONE_SHA256_AMD64=0e6fa18051e67fc600d803a2dcb10ddedb092247fc6eee61be97f64ec080a13c
ARG RCLONE_SHA256_ARM64=c6e9d4cf9c88b279f6ad80cd5675daebc068e404890fa7e191412c1bc7a4ac5f
RUN case "$(uname -m)" in \
      x86_64) arch=amd64; sum="$RCLONE_SHA256_AMD64" ;; \
      aarch64) arch=arm64; sum="$RCLONE_SHA256_ARM64" ;; \
      *) echo "no pinned rclone for $(uname -m)" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${arch}.zip" -o /tmp/rclone.zip \
    && echo "${sum}  /tmp/rclone.zip" | sha256sum -c - \
    && unzip -q -j /tmp/rclone.zip "rclone-v${RCLONE_VERSION}-linux-${arch}/rclone" -d /usr/local/bin \
    && rm /tmp/rclone.zip && chmod 0755 /usr/local/bin/rclone && rclone version | head -1

# docker CLI (client only) — SANDBOX_MODE=docker spawns per-session
# cm-agent-sandbox containers via `spawn("docker", …)` against the mounted host
# /var/run/docker.sock (docker-OUT-of-docker; sibling containers on the host
# daemon, NOT a nested dockerd). Without the client binary the spawn ENOENTs and
# every exec hangs. Static binary → no daemon, no apt repo wiring.
ARG DOCKER_CLI_VERSION=27.3.1
RUN arch="$(uname -m)" \
    && curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz \
    && tar -xzf /tmp/docker.tgz -C /tmp docker/docker \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && rm -rf /tmp/docker.tgz /tmp/docker \
    && docker --version

WORKDIR /app/runtime
COPY runtime/ ./
# Exactly the lockfile, or no image. This used to be `npm install || true`: a
# failed install still produced an image, which then died on its first S3 call
# (@aws-sdk/client-s3 is the storage engine). node_modules never comes from the
# host (.dockerignore).
RUN npm ci --omit=dev --no-audit --no-fund \
    && node -e "import('@aws-sdk/client-s3').then(() => console.log('deps ok'))"

ARG CAC_VERSION=dev
ARG CAC_REVISION=unknown
LABEL org.opencontainers.image.title="UnieAI Cloud Agent Computer" \
      org.opencontainers.image.source="https://github.com/UnieAI/UnieAI-Cloud-Agent-Computer" \
      org.opencontainers.image.version="${CAC_VERSION}" \
      org.opencontainers.image.revision="${CAC_REVISION}"

EXPOSE 4020
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD curl -sf http://127.0.0.1:4020/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/sandbox-runtime/src/server.mjs"]
