# docker/sandbox-runtime/Dockerfile — per-session exec + workspace FS service.
#
# sandbox-runtime/src imports ONLY node: built-ins + sibling runtime/packages/*
# (no external npm deps), so this is a thin node image over the runtime/ tree.
#
# Build context = repo root:  docker build -f docker/sandbox-runtime/Dockerfile -t unieai/sandbox-runtime .
#
# ISOLATION MODE (critical):
#   · SANDBOX_MODE=stub   (default) — host-process exec, ZERO isolation. Dev /
#     single trusted user ONLY. With SANDBOX_ENFORCE_OWNERSHIP=1 the service
#     REFUSES to boot in this mode (P0#2 fail-closed assertion).
#   · SANDBOX_MODE=docker — local docker daemon (needs /var/run/docker.sock +
#     elevated caps). Small trusted-user self-host.
#   · SANDBOX_MODE=cube   — production microVM cluster (CubeMaster, external).
#     The ONLY mode safe for untrusted multi-tenant. Set CUBE_API_URL/KEY.
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
RUN apt-get update && apt-get install -y --no-install-recommends tini curl ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && ssh -V

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
# sandbox-runtime has no external deps; install only if a manifest with deps
# exists (no-op otherwise). Kept tolerant so the image builds regardless.
RUN if [ -f package.json ]; then npm install --omit=dev || true; fi

EXPOSE 4020
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD curl -sf http://127.0.0.1:4020/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/sandbox-runtime/src/server.mjs"]
