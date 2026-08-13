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
