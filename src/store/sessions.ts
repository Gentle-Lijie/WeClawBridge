/**
 * Session registry — maps a Claude Code `session_id` to the WeChat
 * (account, userId) it's conversing with, plus a short label shown in WeChat so
 * the user can tell parallel tasks apart.
 *
 * Used by the relay to route inbound replies back to the right session's
 * pending file, and by the outbound path to tag pushed messages.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./account.js";
import { probeHosts, type Liveness } from "./liveness.js";

export interface SessionEntry {
  /** Claude Code session id. */
  sessionId: string;
  /** Short human label (derived from the session id). */
  label: string;
  accountId?: string;
  userId?: string;
  /** Host claude/codex process recorded by the hook (liveness anchor). */
  pid?: number;
  /** Opaque `ps lstart` fingerprint of the host pid (pid-recycle guard). */
  hostStartedAt?: string;
  /** Host executable name, e.g. "node" / "codex" (display only). */
  host?: string;
  registeredAt: number;
  lastActive: number;
}

function sessionsPath(): string {
  return path.join(resolveStateDir(), "sessions.json");
}

function activePath(): string {
  return path.join(resolveStateDir(), "active-session.json");
}

/** Map of WeChat userId → the claude session_id currently "active" for replies. */
function loadActive(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(activePath(), "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveActive(map: Record<string, string>): void {
  fs.mkdirSync(resolveStateDir(), { recursive: true });
  fs.writeFileSync(activePath(), JSON.stringify(map, null, 2), "utf-8");
}

/** Set the active claude session for a WeChat user (used by /switch). */
export function setActiveSession(userId: string, sessionId: string): void {
  const map = loadActive();
  map[userId] = sessionId;
  saveActive(map);
}

/** Drop a user's active pointer if it names the given session (used on prune). */
export function clearActiveSession(sessionId: string): void {
  const map = loadActive();
  let changed = false;
  for (const [u, sid] of Object.entries(map)) {
    if (sid === sessionId) {
      delete map[u];
      changed = true;
    }
  }
  if (changed) saveActive(map);
}

/** Get the active claude session for a WeChat user, if any. */
export function getActiveSession(userId: string): string | undefined {
  return loadActive()[userId];
}

function shortLabel(sessionId: string): string {
  // session_ids are UUIDs; take the first hex run for a compact tag.
  const m = /[0-9a-f]{4}/i.exec(sessionId);
  return (m?.[0] ?? sessionId.slice(0, 4)).toLowerCase();
}

type SessionMap = Record<string, SessionEntry>;

function loadAll(): SessionMap {
  try {
    return JSON.parse(fs.readFileSync(sessionsPath(), "utf-8")) as SessionMap;
  } catch {
    return {};
  }
}

function saveAll(map: SessionMap): void {
  fs.mkdirSync(resolveStateDir(), { recursive: true });
  fs.writeFileSync(sessionsPath(), JSON.stringify(map, null, 2), "utf-8");
}

/** Register or refresh a session. Returns the entry (with label). */
export function touchSession(
  sessionId: string,
  patch: Partial<
    Pick<SessionEntry, "accountId" | "userId" | "pid" | "hostStartedAt" | "host">
  > = {},
): SessionEntry {
  if (!sessionId) throw new Error("sessionId required");
  const map = loadAll();
  const now = Date.now();
  const existing = map[sessionId];
  const entry: SessionEntry = {
    sessionId,
    label: existing?.label ?? shortLabel(sessionId),
    accountId: patch.accountId ?? existing?.accountId,
    userId: patch.userId ?? existing?.userId,
    pid: patch.pid ?? existing?.pid,
    hostStartedAt: patch.hostStartedAt ?? existing?.hostStartedAt,
    host: patch.host ?? existing?.host,
    registeredAt: existing?.registeredAt ?? now,
    lastActive: now,
  };
  map[sessionId] = entry;
  saveAll(map);
  return entry;
}

export function getSession(sessionId: string): SessionEntry | undefined {
  return loadAll()[sessionId];
}

/** Set a human-friendly label (e.g. the renamed title read from a transcript). */
export function setSessionLabel(sessionId: string, label: string): boolean {
  const map = loadAll();
  if (!map[sessionId]) return false;
  const clean = label.trim().slice(0, 48);
  if (!clean) return false;
  map[sessionId].label = clean;
  saveAll(map);
  return true;
}

export function listSessions(): SessionEntry[] {
  return Object.values(loadAll()).sort((a, b) => b.lastActive - a.lastActive);
}

/** Find sessions bound to a given WeChat userId (for inbound routing).
 *  A session with no recorded accountId matches any account (it was registered
 *  without one, e.g. via a hook /send that omitted `account`). */
export function sessionsForUser(accountId: string | undefined, userId: string): SessionEntry[] {
  return listSessions().filter(
    (s) => s.userId === userId && (!accountId || !s.accountId || s.accountId === accountId),
  );
}

export function forgetSession(sessionId: string): void {
  const map = loadAll();
  if (map[sessionId]) {
    delete map[sessionId];
    saveAll(map);
  }
  clearActiveSession(sessionId);
}

/** Remove every session record (bulk /clear all). Returns how many went. */
export function clearAllSessions(): number {
  const map = loadAll();
  const n = Object.keys(map).length;
  if (n > 0) {
    saveAll({});
    saveActive({});
  }
  return n;
}

/** No-pid legacy entries (pre-liveness) expire from the registry after a week. */
const LEGACY_EXPIRE_MS = 7 * 24 * 3600 * 1000;

export interface ProbeResult {
  /** Sessions that survived the prune, still sorted by lastActive. */
  remaining: SessionEntry[];
  /** Surviving sessionId → liveness ("dead" entries are pruned, not mapped). */
  status: Map<string, Liveness>;
  /** Entries removed this round (host confirmed dead, or legacy+expired). */
  pruned: SessionEntry[];
}

/**
 * Probe every session's recorded host pid against the live process table and
 * drop confirmed-dead ones (clearing any active pointer that named them).
 * This is the /switch-time orphan cleanup: a claude/codex killed without
 * firing SessionEnd still gets reaped here.
 */
export function probeAndPruneSessions(): ProbeResult {
  const sessions = listSessions();
  // One verdict per session, index-aligned with `sessions`.
  const verdicts = probeHosts(sessions.map((s) => ({ pid: s.pid ?? 0, startedAt: s.hostStartedAt })));
  const now = Date.now();
  const remaining: SessionEntry[] = [];
  const status = new Map<string, Liveness>();
  const pruned: SessionEntry[] = [];
  sessions.forEach((s, i) => {
    let v: Liveness;
    if (Number.isInteger(s.pid)) {
      v = verdicts[i];
    } else {
      // No pid recorded (pre-upgrade or synthetic entry): unknown unless long cold.
      v = now - s.lastActive > LEGACY_EXPIRE_MS ? "dead" : "unknown";
    }
    if (v === "dead") {
      pruned.push(s);
      return;
    }
    remaining.push(s);
    status.set(s.sessionId, v);
  });
  if (pruned.length > 0) {
    const map = loadAll();
    for (const s of pruned) {
      delete map[s.sessionId];
      clearActiveSession(s.sessionId);
    }
    saveAll(map);
  }
  return { remaining, status, pruned };
}

/** Render the tag prefix shown in WeChat, e.g. `[a1b2]`. Empty if disabled. */
export function sessionTag(entry: SessionEntry | undefined, enabled: boolean): string {
  if (!enabled || !entry) return "";
  return `[${entry.label}] `;
}
