/**
 * Host-process liveness — tells live claude/codex sessions apart from orphans
 * left behind by processes that died without firing SessionEnd (kill -9,
 * crash, terminal closed).
 *
 * How it works: every hook firing records its HOST process — the claude/codex
 * CLI the hook hangs under, i.e. the first ancestor that isn't a shell — as
 * `pid` plus a start-time fingerprint (`ps lstart`, kept as an opaque string:
 * pids get recycled, lstart doesn't). Later probes re-run `ps` and compare.
 *
 * Sync by design: callers are one-shot hooks and rare user commands (/switch),
 * where a ~50ms `ps` beat is cheaper than an async ripple through the router.
 */

import { execFileSync } from "node:child_process";

export interface HostProcess {
  pid: number;
  /** Opaque `ps -o lstart=` fingerprint — guards against pid recycling. */
  startedAt: string;
  /** Short executable name, e.g. "node" / "codex" (display only). */
  comm: string;
}

export type Liveness = "alive" | "dead" | "unknown";

/** Ancestors to walk through when looking for the host CLI. */
const SKIP = new Set([
  "sh", "bash", "zsh", "dash", "fish", "env", "sudo",
  "login", "launchd", "launchdoverseer",
]);

interface PsRow {
  pid: number;
  ppid: number;
  comm: string;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function psSync(args: string[]): string {
  if (process.platform === "win32") return "";
  try {
    return execFileSync("ps", args, { encoding: "utf-8", timeout: 5000 });
  } catch {
    return "";
  }
}

/** Parse `ps -axo pid=,ppid=,comm=` (comm = remaining tail, spaces allowed). */
function parsePidPpidComm(out: string): Map<number, PsRow> {
  const map = new Map<number, PsRow>();
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    map.set(pid, { pid, ppid, comm: parts.slice(2).join(" ") });
  }
  return map;
}

/**
 * Whitespace-free lstart fingerprint. Column padding differs between
 * `ps -o lstart= -p X` and the `ps -axo` listing, so strip all whitespace —
 * the remaining text ("五8/1414:22:022026" / "ThuAug1414:22:022026") is still
 * a unique per-process-start token on a given machine.
 */
function fingerprint(lstart: string): string {
  return lstart.replace(/\s+/g, "");
}

/** Parse `ps -axo pid=,lstart=` → Map<pid, lstart fingerprint>. */
function parsePidLstart(out: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) map.set(Number(m[1]), fingerprint(m[2]));
  }
  return map;
}

/**
 * Find the host CLI process above this hook: walk ancestors, skip shells and
 * launch plumbing, take the first "real" process. That is the claude/codex the
 * hook belongs to — when it exits, the whole subtree (hook included) goes too.
 * Null when the chain can't be resolved (weird parentage, no `ps`, Windows).
 */
export function findHostProcess(): HostProcess | null {
  const rows = parsePidPpidComm(psSync(["-axo", "pid=,ppid=,comm="]));
  if (rows.size === 0) return null;
  let cur = process.ppid;
  for (let depth = 0; depth < 12 && cur > 1; depth++) {
    const row = rows.get(cur);
    if (!row) return null;
    const base = basename(row.comm).toLowerCase();
    if (!SKIP.has(base)) {
      const startedAt = fingerprint(psSync(["-o", "lstart=", "-p", String(cur)]).trim());
      return { pid: cur, startedAt, comm: base };
    }
    cur = row.ppid;
  }
  return null;
}

/** Cheap sync check (no `ps`): ESRCH = gone, EPERM = exists but not ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Host-process fields as carried on hook /send + /routes bodies. */
export interface HostFields {
  pid?: number;
  hostStartedAt?: string;
  host?: string;
}

/** Keep only well-formed host fields (guards against junk JSON). */
export function hostPatch(b: HostFields): HostFields {
  const out: HostFields = {};
  if (Number.isInteger(b.pid) && (b.pid as number) > 1) out.pid = b.pid;
  if (typeof b.hostStartedAt === "string" && b.hostStartedAt) out.hostStartedAt = b.hostStartedAt;
  if (typeof b.host === "string" && b.host) out.host = b.host;
  return out;
}

/**
 * Probe recorded host pids against the live process table. A pid absent from
 * the table, or present with a different lstart (recycled), is dead.
 * Returns one verdict per entry (index-aligned) — two sessions CAN share a
 * host pid (e.g. re-sent anchors), so a pid-keyed map would conflate them.
 */
export function probeHosts(hosts: { pid: number; startedAt?: string }[]): Liveness[] {
  const table = parsePidLstart(psSync(["-axo", "pid=,lstart="]));
  return hosts.map(({ pid, startedAt }) => {
    if (!Number.isInteger(pid) || pid <= 1) return "unknown";
    if (table.size === 0) return "unknown";
    const live = table.get(pid);
    if (live === undefined) return "dead";
    if (startedAt && live !== startedAt) return "dead"; // pid recycled
    return "alive";
  });
}
