#!/bin/sh
# Mount the SeaweedFS bucket root, resolving the filer's address at START TIME.
#
# WHY THIS SCRIPT EXISTS. The unit used to carry the filer's address as a
# literal `Environment=AVA_FILER=172.20.0.4:8888`. Container IPs are assigned at
# start, so the machine rebooted on 2026-09-07 and the filer came back as
# 172.20.0.3 — while the unit still asked for .4. `weed mount` does not exit on
# a bad address: it retries forever ("wait for N seconds..."), so systemd
# reported `active (running)` with nothing in /proc/mounts, and every cloud
# sandbox returned `workspace_tree_not_mounted` 503. Active and mounted are
# different claims, and only one of them was true.
#
# The filer publishes NO ports to the host (every entry in .NetworkSettings.Ports
# is null), so its container address is the only route and it cannot be pinned.
# Resolving it here — once per start, with the unit's own Restart=always as the
# retry — is the fix. `AVA_FILER` still overrides, for a deployment where the
# filer is reachable at a fixed address.
set -eu

MOUNT_ROOT="${MOUNT_ROOT:-/mnt/ava}"
FILER_CONTAINER="${AVA_FILER_CONTAINER:-uac2-seaweedfs}"
WEED="${AVA_WEED:-/home/ubuntu/.local/bin/weed}"

if [ -n "${AVA_FILER:-}" ]; then
  filer="$AVA_FILER"
else
  ip="$(docker inspect "$FILER_CONTAINER" \
        --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null || true)"
  if [ -z "$ip" ]; then
    # Exit non-zero rather than mounting nothing: systemd restarts us, and the
    # runtime keeps refusing allocation with a reason. A unit that stays
    # "active" while unmounted is the failure this whole file is about.
    echo "cannot resolve the filer address from container '$FILER_CONTAINER' — is it running?" >&2
    exit 1
  fi
  filer="$ip:8888"
fi

echo "mounting /buckets from filer $filer at $MOUNT_ROOT"
mkdir -p "$MOUNT_ROOT"

# -volumeServerAccess=filerProxy, not `direct`: the master advertises the volume
# server under a name only the compose network resolves, and `direct` fails
# SILENTLY from the host — the mount comes up, writes return 0, and the files
# are 0 bytes.
#
# NO -map.uid HERE — and this is a security property, not an omission.
#
# 2026-09-14 added `-map.uid=1000:0 -map.gid=1000:0` so the sandbox user (uid
# 1000 inside the container) could read files the S3 API wrote as uid 0. On a
# host whose login account is ALSO uid 1000 (this one: `ubuntu`, which runs
# ava-app, ava-sandbox and everything else), that map makes the host account the
# OWNER of every tenant's workspace. Owner bits beat the 0770 tenant-parent fence
# (runtime/apps/sandbox-runtime/src/cube/host-filer-exposure.mjs), so any process
# running as that account could read and write every tenant's files.
# Installed 2026-09-26 14:58 → the live isolation check
# (host-filer-exposure.test.mjs, "no unprivileged process on THIS host …") went
# red in the next verify and blocked the deploy; reverted 15:54 UTC (~56 min).
#
# -map.gid=<AVA_WORKSPACE_GID>:0 — the GROUP, and only the group (2026-09-26,
# UAT B1-D1). The S3 API writes everything as filer uid 0 / gid 0, mode 0660.
# This shows filer gid 0 on the host as a dedicated gid that no host account is
# in, and sandbox-runtime adds that gid to every sandbox container
# (`--group-add`). The sandbox reads and writes S3-written files through its
# group bits; a host account is "other" and gets nothing. Syntax is
# <local_gid>:<filer_gid>, parsed independently of -map.uid (weed 4.41,
# weed/mount/meta_cache/id_mapper.go). The default must equal
# DEFAULT_WORKSPACE_GID in runtime/apps/sandbox-runtime/src/cube/workspace-group.mjs;
# workspace-group.test.mjs runs this script to prove it.
#
# The guard below refuses to map a gid that any host account already has — as a
# member or as its primary group — because that would be today's incident again
# with a group instead of a uid. It then mounts WITHOUT the map rather than not
# at all: uploads are unreadable in the sandbox again (and verify-storage says
# so), but nothing is exposed and cloud sandboxes keep working.
#
# -defaultPermissions=true is weed's default, passed explicitly because the
# design depends on it: with it the KERNEL checks access using the caller's real
# groups, a container's --group-add included. Without it weed checks access
# itself, against THIS host's group database, and the container's group is
# invisible to it (weed/mount/weedfs_file_mkrm.go:339).
WORKSPACE_GID="${AVA_WORKSPACE_GID:-2468}"
gid_map=""
case "$WORKSPACE_GID" in
  ''|*[!0-9]*|0*)
    reason="is not a plain positive integer"
    ;;
  *)
    members="$(getent group "$WORKSPACE_GID" | cut -d: -f4)"
    primary="$(getent passwd | awk -F: -v g="$WORKSPACE_GID" '$4 == g { printf "%s ", $1 }')"
    if [ -n "$members" ]; then
      reason="has members on this host ($members)"
    elif [ -n "$primary" ]; then
      reason="is the primary group of: $primary"
    else
      gid_map="-map.gid=${WORKSPACE_GID}:0"
      reason=""
    fi
    ;;
esac
if [ -z "$gid_map" ]; then
  echo "NOT mapping the workspace group: gid '$WORKSPACE_GID' $reason. Mounting without it —" \
    "files written through S3 stay unreadable to the sandbox, and nothing is exposed." \
    "See docs/ops/ava-workspace-group-access.md" >&2
fi

exec "$WEED" mount \
  -filer="$filer" \
  -filer.path=/buckets \
  -dir="$MOUNT_ROOT" \
  -allowOthers=true \
  -volumeServerAccess=filerProxy \
  -defaultPermissions=true \
  ${gid_map:+"$gid_map"} \
  -dirAutoCreate
