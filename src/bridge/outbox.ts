/**
 * Outbound retry outbox.
 *
 * When a send fails because the context_token is missing/stale (prepare_failed)
 * or the bot token expired (stale_token), the message is parked here instead of
 * being dropped. As soon as the monitor re-captures a fresh token for that user
 * (or the bot is re-bound), the outbox flushes pending messages in order.
 *
 * The outbox is per-account, keyed by recipient userId. Each entry holds the
 * original send params so it can be retried verbatim.
 */

import { IlinkClient } from "../ilink/client.js";
import { sendText, SendError } from "./send.js";
import type { SendTextParams } from "./send.js";
import {
  onContextTokenRefresh,
  getContextToken,
  markContextTokenStale,
} from "../store/account.js";
import { Logger } from "../util/log.js";

export interface OutboxEntry extends SendTextParams {
  id: string;
  accountId: string;
  enqueuedAt: number;
  attempts: number;
  /** cap retries to avoid looping forever on permanent failures */
  maxAttempts: number;
}

interface OutboxOptions {
  logger?: Logger;
  /** Build a client for the given account on demand (token may rotate). */
  clientFor: (accountId: string) => IlinkClient | null;
}

const MAX_ATTEMPTS_DEFAULT = 5;
const FLUSH_BACKOFF_MS = 2_000;

export class Outbox {
  private readonly queues = new Map<string, OutboxEntry[]>(); // `${accountId}::${userId}` → entries
  private readonly log: Logger;
  private readonly clientFor: (accountId: string) => IlinkClient | null;
  private flushing = new Set<string>();

  constructor(opts: OutboxOptions) {
    this.log = opts.logger ?? new Logger();
    this.clientFor = opts.clientFor;
    // Retry the moment a fresh context_token lands for any user.
    onContextTokenRefresh((accountId, userId) => {
      void this.flush(accountId, userId).catch((e) =>
        this.log.warn(`outbox flush on refresh failed: ${String(e)}`),
      );
    });
  }

  /** Park a failed send for later retry. Returns the entry id. */
  enqueue(accountId: string, params: SendTextParams, reason: string): string {
    const id = `ob:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: OutboxEntry = {
      id,
      accountId,
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS_DEFAULT,
      ...params,
    };
    const key = this.key(accountId, params.to);
    let q = this.queues.get(key);
    if (!q) {
      q = [];
      this.queues.set(key, q);
    }
    q.push(entry);
    this.log.warn(
      `outbox enqueued ${id} (account=${accountId} to=${params.to} reason=${reason}); pending=${q.length}`,
    );
    return id;
  }

  /** Number of pending entries for an account+user (or all if userId omitted). */
  pending(accountId: string, userId?: string): number {
    if (userId) return this.queues.get(this.key(accountId, userId))?.length ?? 0;
    let n = 0;
    for (const [k, q] of this.queues) if (k.startsWith(`${accountId}::`)) n += q.length;
    return n;
  }

  snapshot(): OutboxEntry[] {
    return [...this.queues.values()].flat();
  }

  /** Attempt to deliver everything queued for (accountId, userId). */
  async flush(accountId: string, userId: string): Promise<void> {
    const key = this.key(accountId, userId);
    if (this.flushing.has(key)) return;
    const q = this.queues.get(key);
    if (!q || q.length === 0) return;
    this.flushing.add(key);
    try {
      while (q.length > 0) {
        const token = getContextToken(accountId, userId);
        if (!token) break; // nothing to retry with yet
        const entry = q[0];
        const client = this.clientFor(accountId);
        if (!client) break;
        entry.attempts += 1;
        try {
          await sendText(client, { ...entry, contextToken: token });
          q.shift();
          this.log.info(`outbox delivered ${entry.id} (attempt ${entry.attempts})`);
        } catch (err) {
          if (err instanceof SendError && (err.kind === "prepare_failed" || err.kind === "stale_token")) {
            markContextTokenStale(accountId, userId, true);
            this.log.warn(
              `outbox retry ${entry.id} still failing (${err.kind}); will wait for re-capture`,
            );
            break; // stop; wait for the next refresh
          }
          // transient/network/rejected → drop or keep?
          if (entry.attempts >= entry.maxAttempts) {
            q.shift();
            this.log.error(`outbox dropping ${entry.id} after ${entry.attempts} attempts: ${String(err)}`);
          } else {
            this.log.warn(`outbox retry ${entry.id} failed (attempt ${entry.attempts}): ${String(err)}`);
            setTimeout(() => void this.flush(accountId, userId).catch(() => {}), FLUSH_BACKOFF_MS);
            break;
          }
        }
      }
      if (q.length === 0) this.queues.delete(key);
    } finally {
      this.flushing.delete(key);
    }
  }

  private key(accountId: string, userId: string): string {
    return `${accountId}::${userId}`;
  }
}
