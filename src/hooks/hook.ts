/**
 * Hook dispatcher — the single command every registered hook runs.
 *
 * Reads the Claude Code hook payload from stdin and the persisted HooksConfig,
 * then for each event:
 *
 *   Stop          → (a) optionally push last_assistant_message to WeChat,
 *                   (b) check local pending for a WeChat reply; if present,
 *                       inject it as a system reminder via asyncRewake (exit 2).
 *   Notification  → push the notification text (permission/idle/needs-input).
 *   PostToolUse   → push an alert if the tool matched a high-risk rule.
 *   SessionStart  → register the session with the relay (route learning).
 *
 * Outbound pushes go to the configured target (local relay or remote bridge),
 * keeping skill/hooks pointed at one place.
 */

import fs from "node:fs";
import path from "node:path";

import { loadHooksConfig } from "./config.js";
import { resolveStateDir } from "../store/account.js";

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  /** Stop / SubagentStop carry the last assistant message. */
  last_assistant_message?: string;
  /** Notification carries a message string. */
  message?: string;
  /** Tool events. */
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface PendingMsg {
  text: string;
  userId?: string;
  timestamp?: number;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // Safety: if stdin is a TTY (no payload), resolve empty.
    if (process.stdin.isTTY) resolve("");
  });
}

function pendingFile(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._:@-]/g, "_").slice(0, 128) || "unmatched";
  return path.join(resolveStateDir(), "relay", "pending", `${safe}.jsonl`);
}

/** Read & clear the pending queue for a session. */
function consumePending(sessionId: string): PendingMsg[] {
  const file = pendingFile(sessionId);
  try {
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

async function pushToWeChat(target: string, token: string | undefined, text: string, session?: string): Promise<void> {
  const body: Record<string, unknown> = { text };
  if (session) body.session = session;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    await fetch(new URL("/send", target + "/").toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    process.stderr.write(`weclaw hook: push failed (${String(err)})\n`);
  }
}

function ruleMatches(rule: string, toolName: string, toolInput: Record<string, unknown>): boolean {
  // Minimal permission-rule match: "Bash(git push *)" etc.
  const m = /^([A-Za-z_]+)\((.*)\)$/.exec(rule);
  if (!m) return rule === toolName;
  const [, tool, pat] = m;
  if (tool !== toolName) return false;
  const cmd = String(toolInput.command ?? toolInput.cmd ?? "");
  const re = new RegExp("^" + pat.replace(/\*/g, ".*").replace(/\?/g, "."));
  return re.test(cmd);
}

export async function runHook(): Promise<void> {
  const cfg = loadHooksConfig();
  if (!cfg) {
    // No config = hooks not installed; exit cleanly.
    process.exit(0);
  }
  const raw = await readStdin();
  let payload: HookPayload = {};
  try {
    payload = raw ? (JSON.parse(raw) as HookPayload) : {};
  } catch {
    // malformed payload — nothing to do
  }
  const event = payload.hook_event_name ?? "";
  const sid = payload.session_id;

  // SessionStart: tell the relay about this session so replies route back.
  if (event === "SessionStart" && sid) {
    try {
      await fetch(new URL("/routes", cfg.target + "/").toString(), {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
        body: JSON.stringify({ session: sid, registeredAt: Date.now() }),
      }).catch(() => {});
    } catch {
      // non-fatal
    }
    process.exit(0);
  }

  if (event === "Stop") {
    if (cfg.notifyStop && payload.last_assistant_message) {
      const summary = payload.last_assistant_message.slice(0, 800);
      await pushToWeChat(cfg.target, cfg.token, `✅ 任务完成：\n${summary}`, sid);
    }
    if (cfg.asyncRewake && sid) {
      const pending = consumePending(sid);
      if (pending.length > 0) {
        // asyncRewake: stderr becomes a system reminder injected into Claude.
        const body = pending
          .map((m, i) => `${i + 1}. ${m.text}`)
          .join("\n");
        process.stderr.write(`[微信回复，请据此继续]\n${body}\n`);
        process.exit(2); // wake the idle session with the reminder
      }
    }
    process.exit(0);
  }

  if (event === "Notification" && cfg.notifyNotification) {
    const text = payload.message ?? "Claude 需要你的输入/确认";
    await pushToWeChat(cfg.target, cfg.token, `🔔 ${text}`, sid);
    process.exit(0);
  }

  if (event === "PostToolUse" && payload.tool_name) {
    const hit = cfg.highRiskTools.find((r) => ruleMatches(r, payload.tool_name!, payload.tool_input ?? {}));
    if (hit) {
      const cmd = String(payload.tool_input?.command ?? payload.tool_input?.cmd ?? payload.tool_name);
      await pushToWeChat(cfg.target, cfg.token, `⚠️ 高危操作已执行：${hit}\n${String(cmd).slice(0, 200)}`, sid);
    }
    process.exit(0);
  }

  process.exit(0);
}
