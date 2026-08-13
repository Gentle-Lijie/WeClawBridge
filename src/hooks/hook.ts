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

import { loadHooksConfig, pushDecision } from "./config.js";
import { consumePending } from "../store/pending.js";
import { sleep } from "../util/id.js";

/** How long an asyncRewake hook waits for a WeChat reply before giving up.
 *  Kept under the 540s hook timeout so there's room to flush. */
const ASYNC_REWAKE_WAIT_SEC = 480;

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

/** Apply quiet-hours + keyword filters before pushing. Returns whether it sent. */
async function maybePush(text: string, cfg: { target: string; token?: string }, sid?: string): Promise<boolean> {
  const decision = pushDecision(text, cfg as never);
  if (!decision.push) {
    process.stderr.write(`weclaw hook: suppressed (${decision.reason})\n`);
    return false;
  }
  await pushToWeChat(cfg.target, cfg.token, text, sid);
  return true;
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
      const summary = payload.last_assistant_message.slice(0, cfg.summaryLength ?? 800);
      await maybePush(`✅ 任务完成：\n${summary}`, cfg, sid);
    }
    if (cfg.asyncRewake && sid) {
      // asyncRewake: the hook runs in the background after Stop. Poll the
      // pending file until a WeChat reply lands (or the wait window elapses),
      // then inject it as a system reminder via exit 2.
      const deadline = Date.now() + ASYNC_REWAKE_WAIT_SEC * 1000;
      process.stderr.write(`weclaw hook: 等待微信回复（最多 ${ASYNC_REWAKE_WAIT_SEC}s）…\n`);
      while (Date.now() < deadline) {
        const pending = consumePending(sid);
        if (pending.length > 0) {
          const body = pending
            .map((m, i) => `${i + 1}. ${m.text}`)
            .join("\n");
          // Receipt: tell the user their reply reached the claude session.
          await maybePush(`✅ 已收到你的回复并送达 claude 会话：\n${body.slice(0, 120)}`, cfg);
          process.stderr.write(`[微信回复，请据此继续]\n${body}\n`);
          process.exit(2); // wake the idle session with the reminder
        }
        await sleep(1500);
      }
      process.stderr.write(`weclaw hook: ${ASYNC_REWAKE_WAIT_SEC}s 内未收到回复，放弃注入。\n`);
    }
    process.exit(0);
  }

  if (event === "Notification" && cfg.notifyNotification) {
    const text = payload.message ?? "Claude 需要你的输入/确认";
    await maybePush(`🔔 ${text}`, cfg, sid);
    process.exit(0);
  }

  if (event === "PostToolUse" && payload.tool_name) {
    const hit = cfg.highRiskTools.find((r) => ruleMatches(r, payload.tool_name!, payload.tool_input ?? {}));
    if (hit) {
      const cmd = String(payload.tool_input?.command ?? payload.tool_input?.cmd ?? payload.tool_name);
      await maybePush(`⚠️ 高危操作已执行：${hit}\n${String(cmd).slice(0, 200)}`, cfg, sid);
    }
    process.exit(0);
  }

  process.exit(0);
}
