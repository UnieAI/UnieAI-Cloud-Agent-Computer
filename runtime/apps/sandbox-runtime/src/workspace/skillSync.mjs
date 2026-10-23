/**
 * workspace/skillSync.mjs — Reverse-sync agent SKILL writes to copilot-v2.
 *
 * Durable skills live in copilot-v2's `user_agent_skills` DB (the 外掛程式 → 技能
 * UI reads it). When the agent authors/edits a skill FOLDER in its workspace
 * under `.opencode/skills/<name>/` (SKILL.md + optional aux files), that lands in
 * S3 here — but the DB wouldn't know. This fires a best-effort callback to
 * copilot-v2 with just the skill NAME; copilot-v2 re-reads the whole folder from
 * S3 and reconciles one skill row (parse SKILL.md → upsert; folder gone →
 * delete). The mirror of memory's reverse-sync, but skill = a folder, so we
 * notify per-name (not per-file) and let the app assemble.
 *
 * Fire-and-forget: a callback failure NEVER affects the write that triggered it.
 * Configured via AGENT_SKILL_SYNC_URL (copilot-v2's /api/agent-next/skill/
 * callback) + a bearer token (AGENT_SKILL_SYNC_TOKEN, defaults to the shared
 * SANDBOX_INTERNAL_TOKEN). Disabled (no-op) when the URL is unset.
 */

import { config } from "../config.mjs";
import { log } from "../shared/log.mjs";

const SKILL_PREFIX = ".opencode/skills/";

/** Map a workspace-relative path to its skill FOLDER NAME, or null if not a
 *  skill file. `.opencode/skills/my-skill/SKILL.md` → `my-skill`. */
export function skillNameOf(relPath) {
  if (!relPath || typeof relPath !== "string") return null;
  if (!relPath.startsWith(SKILL_PREFIX)) return null;
  const rest = relPath.slice(SKILL_PREFIX.length).replace(/^\/+/, "");
  const name = rest.split("/")[0];
  return name || null;
}

/**
 * Notify copilot-v2 that a skill folder changed (created / edited / deleted).
 * Sends only the name — the app re-reads `.opencode/skills/<name>/` from S3 and
 * decides upsert vs delete. No-op when unconfigured or on any error.
 */
export function notifySkillChange(userId, skillName, owner) {
  try {
    if (!skillName || !userId) return;
    const url = config.skillSync?.url;
    if (!url) return;

    const payload = { userId, skillName };
    if (typeof owner === "string" && (owner.startsWith("group:") || owner.startsWith("org:"))) {
      payload.owner = owner;
    }
    const headers = { "content-type": "application/json" };
    if (config.skillSync?.token) headers.authorization = `Bearer ${config.skillSync.token}`;

    void fetch(url, { method: "POST", headers, body: JSON.stringify(payload) })
      .then((res) => {
        if (!res.ok) log("warn", "skill_sync.rejected", { userId, skillName, status: res.status });
      })
      .catch((err) =>
        log("warn", "skill_sync.post_failed", { userId, skillName, message: err?.message || String(err) }),
      );
  } catch (err) {
    log("warn", "skill_sync.failed", { message: err?.message || String(err) });
  }
}

/** Startup health probe — verify the token is accepted (mirrors memory). */
export async function probeSkillSync() {
  const url = config.skillSync?.url;
  if (!url) return; // feature off

  const headers = { "content-type": "application/json" };
  if (config.skillSync?.token) headers.authorization = `Bearer ${config.skillSync.token}`;

  const attempt = async () => {
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ probe: true }) });
      if (res.ok) return { kind: "ok" };
      if (res.status === 401) return { kind: "auth", status: 401 };
      return { kind: "transient", status: res.status };
    } catch (err) {
      return { kind: "transient", message: err?.message || String(err) };
    }
  };

  let r = await attempt();
  if (r.kind === "transient") {
    await new Promise((res) => setTimeout(res, 3000));
    r = await attempt();
  }

  if (r.kind === "ok") {
    log("info", "skill_sync.probe_ok", { url });
  } else if (r.kind === "auth") {
    log("error", "skill_sync.probe_failed", {
      url,
      status: 401,
      hint: "AGENT_SKILL_SYNC_TOKEN / SANDBOX_INTERNAL_TOKEN mismatch — agent-authored skills won't reach the DB",
    });
  } else {
    log("error", "skill_sync.probe_failed", { url, status: r.status, message: r.message });
  }
}
