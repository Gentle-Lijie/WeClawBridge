/**
 * Message archive — append-only JSONL log of every inbound and outbound
 * message, so the WeChat conversation is searchable and replayable without a
 * database dependency. Rotated by size (best-effort).
 */

import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./account.js";

export type Direction = "in" | "out";

export interface ArchiveEntry {
  ts: number;
  dir: Direction;
  accountId: string;
  userId?: string;
  text: string;
  /** outcome: delivered / queued / failed (outbound), or raw (inbound) */
  status?: string;
}

const MAX_BYTES = 5 * 1024 * 1024; // rotate at ~5MB

function archivePath(): string {
  return path.join(resolveStateDir(), "archive.jsonl");
}

function rotatedPath(): string {
  return path.join(resolveStateDir(), "archive.prev.jsonl");
}

/** Append an entry; rotate when the file grows past MAX_BYTES. */
export function archive(entry: Omit<ArchiveEntry, "ts"> & { ts?: number }): void {
  const rec: ArchiveEntry = { ts: entry.ts ?? Date.now(), ...entry };
  const file = archivePath();
  try {
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_BYTES) {
        try { fs.renameSync(file, rotatedPath()); } catch { /* ignore */ }
      }
    } catch {
      // file doesn't exist yet
    }
    fs.mkdirSync(resolveStateDir(), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf-8");
  } catch {
    // archiving must never break the send/receive path
  }
}

/** Search archived messages (most recent first). */
export function searchArchive(query: string, limit = 50): ArchiveEntry[] {
  const results: ArchiveEntry[] = [];
  const q = query.toLowerCase();
  for (const file of [archivePath(), rotatedPath()]) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n").reverse()) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as ArchiveEntry;
        if (entry.text.toLowerCase().includes(q)) {
          results.push(entry);
          if (results.length >= limit) return results;
        }
      } catch {
        // skip malformed
      }
    }
  }
  return results;
}
