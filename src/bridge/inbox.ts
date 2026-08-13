/**
 * Inbound command router — turns the WeChat ClawBot conversation into a
 * control surface. Messages starting with `/` are commands; everything else
 * passes through (to the relay/hook pending pipeline).
 *
 * Security: when WECLAW_INBOX_ALLOW is set, only those WeChat userIds may run
 * commands — inbound is an external channel, so command execution is gated.
 */

import { listAccountIds, loadAccount, contextTokenAgeSec } from "../store/account.js";
import { listSessions, setActiveSession, getActiveSession } from "../store/sessions.js";

export interface InboundEventLike {
  accountId: string;
  userId: string;
  text: string;
}

export interface RouterContext {
  /** Whitelisted userIds allowed to run commands (empty = allow all). */
  allow?: string[];
  /** Monitor liveness + outbox depth, keyed by accountId. */
  monitorInfo?: (accountId: string) => { running: boolean; lastInboundAt: number | null; outboxPending: number };
}

export interface RouteResult {
  /** true if the message was a command (handled); reply carries any response. */
  handled: boolean;
  reply?: string;
  /** why it was ignored, for logging */
  reason?: string;
}

export function routeInbound(ev: InboundEventLike, ctx: RouterContext): RouteResult {
  const text = ev.text.trim();
  if (!text.startsWith("/")) return { handled: false };

  // Gate command execution behind the allowlist when configured.
  if (ctx.allow && ctx.allow.length > 0 && !ctx.allow.includes(ev.userId)) {
    return { handled: true, reason: `command from non-whitelisted user ${ev.userId} ignored` };
  }

  const [cmd, ...rest] = text.split(/\s+/);
  switch (cmd.toLowerCase()) {
    case "/help":
      return {
        handled: true,
        reply: [
          "可用指令：",
          "/help     显示本帮助",
          "/status   账号 + 监听 + token 新鲜度 + 队列",
          "/accounts 绑定的账号列表",
          "/switch   列出/切换当前活跃 claude 会话",
          "/ping     存活检测（回 pong）",
        ].join("\n"),
      };
    case "/ping":
      return { handled: true, reply: "pong" };
    case "/accounts": {
      const ids = listAccountIds();
      return { handled: true, reply: ids.length ? `已绑定账号：\n${ids.join("\n")}` : "（无绑定账号）" };
    }
    case "/switch": {
      const sessions = listSessions();
      if (sessions.length === 0) {
        return { handled: true, reply: "暂无已注册的 claude 会话（会话在 claude 首次发送后自动登记）。" };
      }
      const arg = rest.join(" ").trim();
      if (!arg) {
        const active = getActiveSession(ev.userId);
        const lines = sessions.map((s) => {
          const mark = s.sessionId === active ? " ← 当前" : "";
          return `[${s.label}] ${s.sessionId.slice(0, 8)}…${mark}`;
        });
        return { handled: true, reply: `会话列表：\n${lines.join("\n")}\n用 /switch <标签> 切换` };
      }
      const target = sessions.find((s) => s.label === arg || s.sessionId.startsWith(arg));
      if (!target) return { handled: true, reply: `没找到标签/前缀为「${arg}」的会话。` };
      setActiveSession(ev.userId, target.sessionId);
      return { handled: true, reply: `已切换到会话 [${target.label}]。\n后续回复将优先路由给它。` };
    }
    case "/status": {
      const lines = listAccountIds().map((id) => {
        const data = loadAccount(id);
        const age = contextTokenAgeSec(id, ev.userId);
        const mon = ctx.monitorInfo?.(id);
        return `• ${id}\n   configured: ${data?.token ? "yes" : "no"}\n   monitor: ${mon?.running ? "alive" : "down"}\n   tokenAge: ${age != null ? `${age}s` : "?"}\n   outbox: ${mon?.outboxPending ?? 0}`;
      });
      return { handled: true, reply: lines.length ? lines.join("\n") : "（无绑定账号）" };
    }
    default:
      return { handled: true, reply: `未知指令：${cmd}\n试试 /help\n（参数：${rest.join(" ") || "无"}）` };
  }
}

/** Parse WECLAW_INBOX_ALLOW into a userId list. */
export function parseAllowList(env: string | undefined): string[] {
  if (!env) return [];
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}
