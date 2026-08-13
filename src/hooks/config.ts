/**
 * Hooks configuration — written by `weclaw hooks install`, read by the
 * `weclaw hook` dispatcher on every hook firing.
 *
 * Every Claude Code hook we register just runs `weclaw hook`; the dispatcher
 * reads the event payload from stdin and THIS config to decide what to do
 * (push a notification to WeChat, check for a reply to inject, etc.). That
 * keeps settings.json stable while behavior stays tunable without re-installing
 * hooks.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../store/account.js";

export interface HooksConfig {
  /** Where to send: local relay (127.0.0.1:4789) or a remote bridge URL. */
  target: string;
  /** Bearer token for the target /send. */
  token?: string;
  /** Push last_assistant_message to WeChat when claude stops. */
  notifyStop: boolean;
  /** Push Notification events (permission/idle/needs-input) to WeChat. */
  notifyNotification: boolean;
  /** Push an alert when claude runs a high-risk tool (permission-rule syntax). */
  highRiskTools: string[];
  /** On Stop, check for a WeChat reply and inject it via asyncRewake (exit 2). */
  asyncRewake: boolean;
  /** Max chars of the Stop summary to push. */
  summaryLength?: number;
  /** Notification matcher subset to forward (empty = all). */
  notificationMatchers?: string[];
  /** Keyword filters: include = only push if matched; exclude = never push if matched. */
  filters?: { includeKeywords?: string[]; excludeKeywords?: string[] };
  /** Suppress all pushes during a daily window (local time). */
  quietHours?: { enabled: boolean; start: string; end: string };
}

const CONFIG_NAME = "hooks.json";

export function hooksConfigPath(): string {
  return path.join(resolveStateDir(), CONFIG_NAME);
}

export function defaultHooksConfig(): HooksConfig {
  return {
    target: process.env.WECLAW_HOOK_TARGET ?? "http://127.0.0.1:4789",
    token: process.env.WECLAW_HOOK_TOKEN ?? process.env.WECLAW_API_TOKEN,
    notifyStop: false,
    notifyNotification: true,
    highRiskTools: [],
    asyncRewake: true,
    summaryLength: 800,
    notificationMatchers: [],
    filters: { includeKeywords: [], excludeKeywords: [] },
    quietHours: { enabled: false, start: "23:00", end: "07:00" },
  };
}

export function loadHooksConfig(): HooksConfig | null {
  try {
    const raw = fs.readFileSync(hooksConfigPath(), "utf-8");
    return { ...defaultHooksConfig(), ...(JSON.parse(raw) as Partial<HooksConfig>) };
  } catch {
    return null;
  }
}

export function saveHooksConfig(cfg: HooksConfig): void {
  fs.mkdirSync(resolveStateDir(), { recursive: true });
  const file = hooksConfigPath();
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
}

/** True if the given Date falls inside the configured quiet window. */
export function inQuietHours(cfg: HooksConfig, now: Date = new Date()): boolean {
  const q = cfg.quietHours;
  if (!q?.enabled || !q.start || !q.end) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  const parse = (s: string) => {
    const [h, m] = s.split(":").map((n) => Number(n) || 0);
    return h * 60 + m;
  };
  const start = parse(q.start);
  const end = parse(q.end);
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end;
}

/** Decide whether a message should be pushed, and why it might be suppressed. */
export function pushDecision(text: string, cfg: HooksConfig): { push: boolean; reason?: string } {
  if (inQuietHours(cfg)) {
    return { push: false, reason: "quiet hours" };
  }
  const inc = cfg.filters?.includeKeywords?.filter(Boolean) ?? [];
  const exc = cfg.filters?.excludeKeywords?.filter(Boolean) ?? [];
  const low = text.toLowerCase();
  if (exc.length > 0 && exc.some((k) => low.includes(k.toLowerCase()))) {
    return { push: false, reason: `exclude keyword` };
  }
  if (inc.length > 0 && !inc.some((k) => low.includes(k.toLowerCase()))) {
    return { push: false, reason: "no include keyword" };
  }
  return { push: true };
}
