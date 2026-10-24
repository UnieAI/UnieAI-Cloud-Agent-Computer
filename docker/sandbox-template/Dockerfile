# docker/sandbox-template/Dockerfile — a generic sandbox image for the bundle.
#
# The template image belongs to the CALLER (copilot-v2 ships its own,
# cm-agent-sandbox, with its agent harness inside). This one exists so a
# self-hosted CAC works out of the box: a shell, git, python, node, and nothing
# that mounts anything — /workspace arrives as a bind mount from the host.
#
# What CAC requires of ANY template (checked by the runtime, not assumed):
#   · /bin/sh and `sleep` — the host-mount boot command (cube/docker.mjs)
#   · `mountpoint` (util-linux) — the readiness probe polls `mountpoint -q /workspace`
#   · python3 or bash — the filer-exposure probe opens a TCP socket with them
#   · a non-root USER — sandboxes run with no capabilities; uid 1000 joins the
#     workspace group (SANDBOX_WORKSPACE_GID) to read and write /workspace
#
#   docker build -f docker/sandbox-template/Dockerfile -t cac-sandbox:local .
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git python3 python3-pip python3-venv procps util-linux less \
    && rm -rf /var/lib/apt/lists/* \
    && command -v mountpoint && command -v python3

# node:22 already owns uid 1000 as `node`; rename it to the conventional `user`.
RUN usermod -l user -d /home/user -m node && groupmod -n user node

USER user
WORKDIR /workspace
CMD ["sleep", "infinity"]
