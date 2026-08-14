/**
 * Pending reply queue — the single rendezvous point where inbound WeChat
 * messages land so a local claude session's asyncRewake/cron hook can pick them
 * up.
 *
 * This is intentionally shared by BOTH deployment shapes:
 *   • local bridge: monitor writes here directly on inbound
 *   • remote bridge + relay: relay subscribes to /events and writes here
 * The hook side (`weclaw hook` / asyncRewake) only ever reads local files, so
 * both shapes resolve to the same code path.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./account.js";
import { sessionsForUser, getActiveSession, getSession } from "./sessions.js";
import { pidAlive } from "./liveness.js";

export interface PendingMsg {
  text: string;
  userId?: string;
  timestamp?: number;
  session?: string;
  relayedAt?: number;
}

/** Where pending files live (kept under relay/ for back-compat with older hooks). */
export function pendingDir(): string {
  return path.join(resolveStateDir(), "relay", "pending");
}

function fileFor(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._:@-]/g, "_").slice(0, 128) || "unmatched";
  return path.join(pendingDir(), `${safe}.jsonl`);
}

/** Append a message to a session's pending queue. */
export function appendPending(sessionId: string, msg: PendingMsg): void {
  try {
    fs.mkdirSync(pendingDir(), { recursive: true });
    fs.appendFileSync(fileFor(sessionId), JSON.stringify({ relayedAt: Date.now(), ...msg }) + "\n");
  } catch {
    // never break the receive path on a pending-write failure
  }
}

/** Read & clear a session's pending queue. */
export function consumePending(sessionId: string): PendingMsg[] {
  try {
    const file = fileFor(sessionId);
    const raw = fs.readFileSync(file, "utf-8");
    fs.writeFileSync(file, "");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as PendingMsg);
  } catch {
    return [];
  }
}

/**
 * Route an inbound WeChat message to the matching claude session(s) and append.
 * Honors the user's active session (set via /switch) first, else all sessions
 * bound to that user. Returns the session ids that received it.
 */
export function routeAndAppend(
  accountId: string | undefined,
  userId: string,
  msg: PendingMsg,
): string[] {
  // Honor the active session — unless its host process is confirmed gone
  // (an orphan the /switch prune hasn't caught yet); then fall through to
  // normal matching so the reply doesn't vanish into a dead pending file.
  const active = getActiveSession(userId);
  const activeEntry = active ? getSession(active) : undefined;
  const activeUsable = active && (!activeEntry?.pid || pidAlive(activeEntry.pid));
  let targets: string[];
  if (activeUsable) {
    targets = [active!];
  } else {
    const matched = sessionsForUser(accountId, userId);
    targets = [];
    if (msg.session) targets.push(msg.session);
    for (const s of matched) targets.push(s.sessionId);
  }
  const dedup = [...new Set(targets)];
  if (dedup.length === 0) {
    appendPending("unmatched", msg);
    return ["unmatched"];
  }
  for (const sid of dedup) appendPending(sid, msg);
  return dedup;
}
