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
#   · a non-root USER — sandboxes run with no capabilities. With the s3 mount
#     driver the runtime starts the container as `--user 2468:2468`
#     (SANDBOX_HOST_MOUNT_S3_UID : SANDBOX_WORKSPACE_GID), because rclone shows
#     every file as one owner and only the owner may chmod (git does, on every
#     config write). This image gives that uid a name and a home so the shell,
#     pip --user and git's global config behave. 2468, not node's 1000: uid
#     1000 is the login account on a stock Ubuntu host, and the owner of a
#     tenant's files must be no host account.
#
#   docker build -f docker/sandbox-template/Dockerfile -t cac-sandbox:local .
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git python3 python3-pip python3-venv procps util-linux less \
    && rm -rf /var/lib/apt/lists/* \
    && command -v mountpoint && command -v python3

# node:22's `node` (1000) becomes `user` at 2468:2468 — see the header.
RUN groupmod -n user -g 2468 node \
    && usermod -l user -u 2468 -g 2468 -d /home/user -m node \
    && [ "$(id -u user):$(id -g user)" = "2468:2468" ]

USER user
WORKDIR /workspace
CMD ["sleep", "infinity"]
