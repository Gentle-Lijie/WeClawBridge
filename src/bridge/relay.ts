/**
 * Local relay — the bidirectional hub when claude runs locally but the bridge
 * runs on a remote server.
 *
 *   local claude (skill/hooks) ──► 127.0.0.1:relay ──► remote bridge /send ──► WeChat
 *   remote bridge /events (SSE) ──► relay ──► pending/<sid>.jsonl ──► local asyncRewake/cron
 *
 * The relay speaks the SAME /send contract as the bridge, so skill/hooks keep
 * pointing at 127.0.0.1 with zero changes. It also remembers which claude
 * session sent to which WeChat user, so inbound replies can be routed back to
 * the right session's pending file.
 */

import http from "node:http";

import { touchSession, sessionTag, listSessions, setActiveSession, getActiveSession } from "../store/sessions.js";
import { routeAndAppend, consumePending } from "../store/pending.js";
import { loadHooksConfig, defaultHooksConfig } from "../hooks/config.js";
import { readConfigHtml, saveHooksFromJsonBody } from "./configPage.js";
import { Logger } from "../util/log.js";
import { sleep } from "../util/id.js";

export interface RelayOptions {
  /** Upstream bridge URL, e.g. https://bridge.example.com */
  remoteUrl: string;
  /** Bearer token for the upstream. */
  token?: string;
  /** Local listen port (default 4789). */
  port?: number;
  /** Local listen host (default 127.0.0.1). */
  host?: string;
  /** Prefix pushed messages with a short session tag (default true). */
  tag?: boolean;
  logger?: Logger;
}

/** Max cached outbound sends kept while the upstream is down (FIFO; oldest dropped). */
const MAX_OUT_CACHE = 500;

interface InboundEvent {
  type: "inbound";
  accountId: string;
  userId: string;
  text: string;
  timestamp?: number;
  session?: string;
}

export class RelayServer {
  private readonly remoteUrl: string;
  private readonly token?: string;
  private readonly port: number;
  private readonly host: string;
  private readonly tag: boolean;
  private readonly log: Logger;
  private server?: http.Server;
  /** outbound cache when the upstream is unreachable */
  private readonly outCache: { body: string; at: number }[] = [];
  private sseAborted = false;

  constructor(opts: RelayOptions) {
    this.remoteUrl = opts.remoteUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.port = opts.port ?? (Number(process.env.WECLAW_PORT) || 4789);
    this.host = opts.host ?? "127.0.0.1";
    this.tag = opts.tag ?? process.env.WECLAW_SESSION_TAG !== "false";
    this.log = opts.logger ?? new Logger();
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, this.host, () => resolve());
    });
    this.log.info(`relay listening on http://${this.host}:${this.port} → ${this.remoteUrl}`);
    // Fire-and-forget the inbound subscriber; it reconnects forever.
    void this.runSubscriber().catch((e) => this.log.error(`subscriber crashed: ${String(e)}`));
  }

  async stop(): Promise<void> {
    this.sseAborted = true;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  // ── outbound proxy ──────────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (p === "/health" && method === "GET") {
      return this.sendJson(res, 200, { ok: true, relay: true, upstream: this.remoteUrl });
    }

    // Config UI + data MUST be served from the LOCAL hooks.json. In relay mode
    // the local claude/codex hook reads local config, so proxying these to the
    // server would show/save the server's config and break the local hook.
    if (p === "/" && method === "GET") {
      const html = readConfigHtml();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (p === "/config" && method === "GET") {
      const cfg = loadHooksConfig() ?? defaultHooksConfig();
      return this.sendJson(res, 200, cfg);
    }
    if (p === "/config" && method === "POST") {
      const r = saveHooksFromJsonBody(await readBody(req));
      if (!r.ok) return this.sendJson(res, r.status, { error: r.error });
      this.log.info("hooks config updated via /config (local)");
      return this.sendJson(res, 200, { ok: true });
    }

    if (p === "/pending" && method === "GET") {
      // ?session=<sid> → consume (read + clear) pending for that session
      const session = url.searchParams.get("session");
      if (!session) return this.sendJson(res, 400, { error: "?session required" });
      return this.sendJson(res, 200, { session, messages: consumePending(session) });
    }

    if (p === "/routes" && method === "GET") {
      // session registry (multi-session routing)
      return this.sendJson(res, 200, { sessions: listSessions() });
    }

    if (p === "/routes" && method === "POST") {
      // SessionStart registration: { session, accountId?, userId? }
      const body = await readBody(req);
      let parsed: { session?: string; userId?: string; accountId?: string } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        return this.sendJson(res, 400, { error: "invalid JSON body" });
      }
      if (!parsed.session) return this.sendJson(res, 400, { error: "session required" });
      const entry = touchSession(parsed.session, { userId: parsed.userId, accountId: parsed.accountId });
      return this.sendJson(res, 200, { ok: true, label: entry.label });
    }

    // Everything else (notably /send, /status, /accounts) is proxied upstream.
    if (method === "POST" && p === "/send") {
      return this.handleSend(req, res);
    }
    return this.proxy(req, res);
  }

  private async handleSend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: { text?: string; to?: string; account?: string; session?: string } = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      return this.sendJson(res, 400, { error: "invalid JSON body" });
    }
    // Register/refresh the session and tag the message so parallel tasks are
    // distinguishable in WeChat. The tag is added to the body before forwarding.
    let outBody = body;
    if (parsed.session) {
      const entry = touchSession(parsed.session, {
        userId: parsed.to,
        accountId: parsed.account,
      });
      const tag = sessionTag(entry, this.tag);
      if (tag && typeof parsed.text === "string") {
        parsed.text = `${tag}${parsed.text}`;
        outBody = JSON.stringify(parsed);
      }
    }
    const upstream = await this.forward("/send", "POST", outBody);
    res.writeHead(upstream.status, upstream.headers);
    res.end(upstream.body);
  }

  /** Generic pass-through to the upstream bridge. */
  private async proxy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const body = method === "POST" || method === "PUT" ? await readBody(req) : undefined;
    const up = await this.forward(url.pathname, method, body);
    res.writeHead(up.status, up.headers);
    res.end(up.body);
  }

  private async forward(
    pathName: string,
    method: string,
    body?: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    try {
      const resp = await fetch(new URL(pathName, this.remoteUrl + "/").toString(), {
        method,
        headers,
        body,
      });
      const text = await resp.text();
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        // drop hop-by-hop / length headers that re-writing would conflict with
        if (!["content-length", "transfer-encoding", "connection"].includes(k.toLowerCase())) {
          respHeaders[k] = v;
        }
      });
      return { status: resp.status, headers: respHeaders, body: text };
    } catch (err) {
      this.log.warn(`upstream ${method} ${pathName} unreachable: ${String(err)}`);
      if (pathName === "/send" && body) {
        this.outCache.push({ body, at: Date.now() });
        // Bound the cache so a long outage can't exhaust memory; drop oldest.
        while (this.outCache.length > MAX_OUT_CACHE) this.outCache.shift();
        this.log.info(`cached outbound send (${this.outCache.length} pending)`);
      }
      return {
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: `upstream unreachable: ${String(err)}` }),
      };
    }
  }

  // ── inbound subscriber (SSE) ────────────────────────────────────────────────

  /** Subscribe to upstream /events forever, reconnecting with backoff. */
  private async runSubscriber(): Promise<void> {
    const url = new URL("/events", this.remoteUrl + "/").toString();
    let backoff = 1_000;
    while (!this.sseAborted) {
      try {
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (this.token) headers.authorization = `Bearer ${this.token}`;
        const resp = await fetch(url, { headers });
        if (!resp.ok || !resp.body) {
          throw new Error(`/events HTTP ${resp.status}`);
        }
        this.log.info(`subscribed to ${url}`);
        backoff = 1_000;
        // Upstream is reachable again — drain any cached outbound sends that
        // were parked while the link was down (don't wait for an inbound).
        void this.flushCache();
        await this.readSSE(resp.body, (ev) => this.onInbound(ev));
      } catch (err) {
        if (this.sseAborted) return;
        this.log.warn(`SSE disconnected (${String(err)}); reconnecting in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  /** Parse an SSE byte stream, emitting complete `data:` payloads. */
  private async readSSE(
    body: ReadableStream<Uint8Array>,
    onEvent: (ev: InboundEvent) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            const ev = JSON.parse(payload) as InboundEvent;
            if (ev.type === "inbound") onEvent(ev);
          } catch {
            // ignore malformed
          }
        }
      }
    }
  }

  /** Inbound from WeChat (via server /events) → command or pending route. */
  private async onInbound(ev: InboundEvent): Promise<void> {
    this.log.info(`inbound from=${ev.userId}${ev.session ? ` session=${ev.session}` : ""}: ${ev.text.slice(0, 80)}`);
    void this.flushCache();
    // Commands are handled locally (relay is the state source in relay mode).
    if (ev.text.startsWith("/")) {
      const reply = await this.handleCommand(ev);
      if (reply) {
        try {
          await this.forward("/send", "POST", JSON.stringify({ text: reply }));
        } catch (err) {
          this.log.warn(`command reply failed: ${String(err)}`);
        }
      }
      return;
    }
    // Non-command → route to the bound local session's pending.
    const targets = routeAndAppend(ev.accountId, ev.userId, {
      text: ev.text,
      userId: ev.userId,
      timestamp: ev.timestamp,
      session: ev.session,
    });
    this.log.info(`inbound routed to session(s): ${targets.join(", ")}`);
  }

  private async handleCommand(ev: InboundEvent): Promise<string> {
    const [cmd, ...rest] = ev.text.trim().split(/\s+/);
    switch (cmd.toLowerCase()) {
      case "/help":
        return ["可用指令：", "/help     显示本帮助", "/status   账号+监听+token+队列", "/accounts 绑定账号", "/switch   列出/切换会话", "/ping     存活检测"].join("\n");
      case "/ping":
        return "pong";
      case "/switch":
        return this.cmdSwitch(ev, rest);
      case "/status":
        return await this.proxyJson("/status", (data) => {
          const accts = (data.accounts as Record<string, unknown>[] | undefined) ?? [];
          const lines = accts.map((a) =>
            `• ${a.accountId}\n   monitor: ${a.monitorRunning ? "alive" : "down"}  tokenAge: ${a.contextTokenAgeSec ?? "?"}s  outbox: ${a.outboxPending ?? 0}`);
          return lines.length ? lines.join("\n") : "(无账号)";
        });
      case "/accounts":
        return await this.proxyJson("/accounts", (data) => {
          const ids = (data.accounts as string[] | undefined) ?? [];
          return ids.length ? `已绑定账号：\n${ids.join("\n")}` : "(无账号)";
        });
      default:
        return `未知指令：${cmd}\n试试 /help`;
    }
  }

  /** /switch operates on LOCAL sessions (relay is the state source). */
  private cmdSwitch(ev: InboundEvent, rest: string[]): string {
    const sessions = listSessions();
    if (sessions.length === 0) return "暂无已注册的 claude/codex 会话。";
    const arg = rest.join(" ").trim();
    const src = (sid: string) => (sid.startsWith("codex") ? "codex" : "claude");
    if (!arg) {
      const active = getActiveSession(ev.userId);
      const lines = sessions.map((s, i) =>
        `${i + 1}. ${s.label}  (${src(s.sessionId)})${s.sessionId === active ? " ← 当前" : ""}`);
      return `会话列表：\n${lines.join("\n")}\n/switch <序号> 切换`;
    }
    let target: { sessionId: string; label: string } | undefined;
    if (/^\d+$/.test(arg)) target = sessions[Number(arg) - 1];
    else target = sessions.find((s) => s.sessionId.startsWith(arg));
    if (!target) return `没找到「${arg}」。/switch 看列表。`;
    setActiveSession(ev.userId, target.sessionId);
    return `已切换到 ${target.label} (${src(target.sessionId)})。\n后续回复将优先路由给它。`;
  }

  /** Proxy a GET to the upstream and format the JSON via `fmt`. */
  private async proxyJson(path: string, fmt: (data: Record<string, unknown>) => string): Promise<string> {
    const up = await this.forward(path, "GET");
    if (up.status !== 200) return `查询失败（HTTP ${up.status}）`;
    try {
      return fmt(JSON.parse(up.body));
    } catch {
      return "解析失败";
    }
  }

  /** Retry cached outbound sends once the link is back. */
  private async flushCache(): Promise<void> {
    while (this.outCache.length > 0) {
      const item = this.outCache[0];
      const up = await this.forward("/send", "POST", item.body);
      if (up.status >= 500 || up.status === 502) break; // still down
      this.outCache.shift();
      this.log.info(`flushed cached send (${this.outCache.length} left)`);
    }
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
