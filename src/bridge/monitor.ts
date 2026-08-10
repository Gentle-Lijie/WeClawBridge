/**
 * Inbound monitor — the getUpdates long-poll loop.
 *
 * Keeps the bot session alive, captures inbound messages, and persists the
 * `context_token` for every sender so the webhook server can reply / push.
 *
 * Optionally mirrors inbound messages to a configured webhook (so external
 * agents receive messages FROM WeChat, not just push TO it).
 */

import { IlinkClient, STALE_TOKEN_ERRCODE } from "../ilink/client.js";
import type { WeixinMessage } from "../ilink/types.js";
import { MessageItemType } from "../ilink/types.js";
import {
  getContextToken,
  loadSyncBuf,
  saveSyncBuf,
  setContextToken,
} from "../store/account.js";
import { sleep } from "../util/id.js";
import { Logger } from "../util/log.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const STALE_PAUSE_MS = 5 * 60_000;

export interface InboundEvent {
  accountId: string;
  userId: string;
  text: string;
  contextToken?: string;
  timestamp?: number;
  raw: WeixinMessage;
}

export interface MonitorOptions {
  client: IlinkClient;
  accountId: string;
  /** External abort signal (e.g. process shutdown). */
  abortSignal?: AbortSignal;
  /** Override long-poll timeout. */
  longPollTimeoutMs?: number;
  /** Called for each inbound user message. */
  onInbound?: (event: InboundEvent) => void | Promise<void>;
  /** Optional logger. */
  logger?: Logger;
}

/** Extract plain text from an inbound message's item_list. */
export function extractText(msg: WeixinMessage): string {
  if (!msg.item_list?.length) return "";
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return String(item.voice_item.text);
    }
  }
  return "";
}

/** Read the context token for (account, user). */
export function lookupContextToken(accountId: string, userId: string): string | undefined {
  return getContextToken(accountId, userId);
}

/**
 * Run the long-poll loop until aborted. Resolves when the abort signal fires.
 */
export async function runMonitor(opts: MonitorOptions): Promise<void> {
  const { client, accountId, abortSignal } = opts;
  const log = opts.logger ?? new Logger({ account: accountId });

  let getUpdatesBuf = loadSyncBuf(accountId);
  if (getUpdatesBuf) {
    log.info(`resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
  }

  let nextTimeoutMs = opts.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let failures = 0;

  try {
    await client.notifyStart().catch((err) => log.warn(`notifyStart failed (ignored): ${String(err)}`));
  } catch {
    // ignore
  }
  log.info(`monitor started (${client.baseUrl})`);

  while (!abortSignal?.aborted) {
    try {
      const resp = await client.getUpdates(getUpdatesBuf, nextTimeoutMs);
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isStale = resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE;
        if (isStale) {
          log.error(`token appears stale (errcode=${resp.errcode}); pausing ${STALE_PAUSE_MS / 1000}s`);
          failures = 0;
          await sleep(STALE_PAUSE_MS, abortSignal);
          continue;
        }
        failures += 1;
        log.warn(
          `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${failures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          failures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      failures = 0;
      if (resp.get_updates_buf && resp.get_updates_buf !== "") {
        saveSyncBuf(accountId, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      for (const msg of resp.msgs ?? []) {
        const userId = msg.from_user_id ?? "";
        if (msg.context_token && userId) {
          setContextToken(accountId, userId, msg.context_token);
        }
        const text = extractText(msg);
        if (!userId || !text) continue;
        log.info(`inbound from=${userId}: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);
        try {
          await opts.onInbound?.({
            accountId,
            userId,
            text,
            contextToken: msg.context_token,
            timestamp: msg.create_time_ms,
            raw: msg,
          });
        } catch (err) {
          log.warn(`onInbound handler threw: ${String(err)}`);
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        log.info("monitor stopped (aborted)");
        return;
      }
      failures += 1;
      log.warn(
        `getUpdates error (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`,
      );
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        failures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }

  try {
    await client.notifyStop().catch(() => {});
  } catch {
    // ignore
  }
  log.info("monitor ended");
}
