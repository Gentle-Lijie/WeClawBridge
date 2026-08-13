/**
 * HTTP webhook server.
 *
 * Runs the inbound monitor(s) for every bound account and exposes a small REST
 * surface for pushing instructions (text) to WeChat users.
 *
 *   GET  /health
 *   GET  /status                 → accounts + monitor liveness
 *   GET  /accounts               → list bound accountIds
 *   POST /send                   → forward { text, to?, account? } to WeChat
 *   POST /login/start            → begin QR login, returns { qrcodeUrl, sessionKey }
 *   POST /login/wait             → poll a started login to completion
 *
 * Built on `node:http` for cross-runtime portability (Node / Bun / Deno).
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import { IlinkClient, DEFAULT_BASE_URL } from "../ilink/client.js";
import { sendText, SendError } from "./send.js";
import { runMonitor } from "./monitor.js";
import { Outbox } from "./outbox.js";
import { redact } from "../util/redact.js";
import { chunkText } from "../util/text.js";
import { routeInbound, parseAllowList } from "./inbox.js";
import { archive } from "../store/archive.js";
import { loadHooksConfig, saveHooksConfig, defaultHooksConfig } from "../hooks/config.js";
import { touchSession } from "../store/sessions.js";
import { routeAndAppend } from "../store/pending.js";
import {
  getContextToken,
  listAccountIds,
  loadAccount,
  resolveAccount,
  markContextTokenStale,
  contextTokenAgeSec,
} from "../store/account.js";
import { Logger } from "../util/log.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Optional bearer token required on mutating requests (env WECLAW_API_TOKEN). */
  apiToken?: string;
  /** External webhook to mirror inbound messages to. */
  inboundWebhook?: string;
  /** Override base URL / version advertised to iLink. */
  baseUrl?: string;
  channelVersion?: string;
  /** Disable outbound secret redaction (default: on). */
  redact?: boolean;
  /** Disable the /login/* endpoints (set for public deployments). */
  disableLogin?: boolean;
  /** Comma-separated CIDR/IP allowlist for non-health endpoints. */
  allowIps?: string[];
  /** Trust X-Forwarded-For (when behind a reverse proxy). */
  trustProxy?: boolean;
  /** Max /send calls per minute per IP (0 = unlimited). */
  rateLimitPerMin?: number;
  logger?: Logger;
}

interface MonitorHandle {
  accountId: string;
  controller: AbortController;
  running: boolean;
  lastInboundAt: number | null;
}

interface SseClient {
  res: http.ServerResponse;
  filter: { accountId?: string; userId?: string; session?: string };
}

interface InboundBroadcast {
  type: "inbound";
  accountId: string;
  userId: string;
  text: string;
  timestamp?: number;
  session?: string;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** A client-visible HTTP error with an explicit status code. */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/** Resolve the target user for a send: explicit `to` → account's bound userId. */
function resolveTarget(accountId: string, to?: string): string {
  if (to?.trim()) return to.trim();
  const userId = loadAccount(accountId)?.userId?.trim();
  if (!userId) {
    throw new Error(
      `no 'to' given and account ${accountId} has no bound userId; the recipient must have messaged the bot at least once, or pass ?to=<...@im.wechat>`,
    );
  }
  return userId;
}

/** Mask an id like `abcdef1234@im.wechat` → `abcdef…@im.wechat`. */
function maskId(id: string): string {
  const at = id.indexOf("@");
  if (at <= 4) return id;
  return `${id.slice(0, 6)}…${id.slice(at)}`;
}

export class BridgeServer {
  private readonly opts: Required<
    Omit<
      ServerOptions,
      | "apiToken"
      | "inboundWebhook"
      | "baseUrl"
      | "channelVersion"
      | "redact"
      | "disableLogin"
      | "allowIps"
      | "trustProxy"
      | "rateLimitPerMin"
      | "logger"
    >
  > & {
    apiToken?: string;
    inboundWebhook?: string;
    baseUrl?: string;
    channelVersion?: string;
    redact: boolean;
    disableLogin: boolean;
    allowIps: string[];
    trustProxy: boolean;
    rateLimitPerMin: number;
    inboxAllow: string[];
    logger: Logger;
  };
  private server?: http.Server;
  private readonly monitors = new Map<string, MonitorHandle>();
  private readonly logins = new Map<string, { client: IlinkClient; qrcode: string }>();
  private readonly outbox: Outbox;
  private readonly sseClients = new Set<SseClient>();
  private ssePing?: NodeJS.Timeout;
  /** rate limiter: ip → { windowStart, count } */
  private readonly rlBuckets = new Map<string, { start: number; count: number }>();

  constructor(opts: ServerOptions = {}) {
    const allowIps =
      opts.allowIps ??
      (process.env.WECLAW_ALLOW_IPS ? process.env.WECLAW_ALLOW_IPS.split(",").map((s) => s.trim()).filter(Boolean) : []);
    this.opts = {
      port: (opts.port ?? Number(process.env.WECLAW_PORT)) || 4789,
      host: (opts.host ?? process.env.WECLAW_HOST) || "127.0.0.1",
      apiToken: opts.apiToken ?? process.env.WECLAW_API_TOKEN,
      inboundWebhook: opts.inboundWebhook ?? process.env.WECLAW_INBOUND_WEBHOOK,
      baseUrl: opts.baseUrl,
      channelVersion: opts.channelVersion,
      redact: opts.redact ?? process.env.WECLAW_NO_REDACT !== "1",
      disableLogin: opts.disableLogin ?? process.env.WECLAW_DISABLE_LOGIN === "1",
      allowIps,
      trustProxy: opts.trustProxy ?? process.env.WECLAW_TRUST_PROXY === "1",
      rateLimitPerMin: opts.rateLimitPerMin ?? (Number(process.env.WECLAW_RATE_LIMIT) || 0),
      inboxAllow: parseAllowList(process.env.WECLAW_INBOX_ALLOW),
      logger: opts.logger ?? new Logger(),
    };
    const self = this;
    this.outbox = new Outbox({
      logger: this.opts.logger,
      clientFor: (accountId) => self.clientFor(accountId),
    });
  }

  /** Build a fresh iLink client for an account (token may rotate after rebind). */
  private clientFor(accountId: string): IlinkClient | null {
    try {
      const account = resolveAccount(accountId);
      if (!account.configured) return null;
      return new IlinkClient({
        baseUrl: account.baseUrl,
        token: account.token,
        channelVersion: this.opts.channelVersion,
      });
    } catch {
      return null;
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const host = this.opts.host;
    const isPublicHost = host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
    if (isPublicHost && !this.opts.apiToken) {
      this.opts.logger.warn(
        `⚠️ 监听在公网地址 ${host} 但未设置 WECLAW_API_TOKEN — /send 将对任意调用者开放。强烈建议设置 token。`,
      );
    }

    // Boot a monitor for each bound account.
    for (const id of listAccountIds()) {
      void this.startMonitor(id).catch((err: unknown) =>
        this.opts.logger.error(`failed to start monitor ${id}: ${String(err)}`),
      );
    }

    this.server = http.createServer((req, res) => {
      // SSE needs raw socket handling; everything else goes through handle().
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.replace(/\/+$/, "") === "/events" && (req.method ?? "GET") === "GET") {
        this.handleEvents(req, res).catch((err: unknown) =>
          this.opts.logger.error(`/events error: ${String(err)}`),
        );
        return;
      }
      this.handle(req, res).catch((err: unknown) => {
        if (err instanceof HttpError) {
          sendJson(res, err.status, { error: err.message });
        } else {
          this.opts.logger.error(`request error: ${String(err)}`);
          sendJson(res, 500, { error: String(err) });
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.opts.port, this.opts.host, () => resolve());
    });
    const addr = this.server.address() as AddressInfo;
    this.opts.logger.info(`webhook server listening on http://${addr.address}:${addr.port}`);

    // Keep SSE connections warm with a periodic comment ping.
    const ssePing = setInterval(() => {
      if (this.sseClients.size === 0) return;
      for (const c of this.sseClients) {
        try {
          c.res.write(": ping\n\n");
        } catch {
          this.sseClients.delete(c);
        }
      }
    }, 25_000);
    this.ssePing = ssePing;
    this.opts.logger.info(
      `hardening: redact=${this.opts.redact} disableLogin=${this.opts.disableLogin} allowIps=${this.opts.allowIps.length ? this.opts.allowIps.join(",") : "(all)"} rateLimit=${this.opts.rateLimitPerMin || "off"}/min`,
    );
  }

  async stop(): Promise<void> {
    if (this.ssePing) clearInterval(this.ssePing);
    for (const c of this.sseClients) {
      try {
        c.res.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();
    for (const handle of this.monitors.values()) {
      handle.controller.abort();
    }
    this.monitors.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  private startMonitor(accountId: string): Promise<void> {
    if (this.monitors.has(accountId)) return Promise.resolve();
    const account = resolveAccount(accountId);
    if (!account.configured) {
      this.opts.logger.warn(`account ${accountId} not configured, skipping monitor`);
      return Promise.resolve();
    }
    const controller = new AbortController();
    const client = new IlinkClient({
      baseUrl: account.baseUrl,
      token: account.token,
      channelVersion: this.opts.channelVersion,
    });
    const handle: MonitorHandle = { accountId, controller, running: true, lastInboundAt: null };
    this.monitors.set(accountId, handle);
    return runMonitor({
      client,
      accountId,
      abortSignal: controller.signal,
      logger: this.opts.logger.withAccount(accountId),
      onInbound: async (event) => {
        handle.lastInboundAt = Date.now();
        archive({ dir: "in", accountId: event.accountId, userId: event.userId, text: event.text });
        // Command router: /help /status etc. reply directly in WeChat.
        const route = routeInbound(event, {
          allow: this.opts.inboxAllow,
          monitorInfo: (aid) => {
            const m = this.monitors.get(aid);
            return { running: m?.running ?? false, lastInboundAt: m?.lastInboundAt ?? null, outboxPending: this.outbox.pending(aid) };
          },
        });
        if (route.handled) {
          if (route.reason) this.opts.logger.info(`inbox: ${route.reason}`);
          if (route.reply) {
            try {
              await sendText(client, { to: event.userId, text: route.reply, contextToken: event.contextToken });
            } catch (err) {
              this.opts.logger.warn(`inbox reply failed: ${String(err)}`);
            }
          }
          return; // commands are not mirrored to the external webhook
        }
        // Non-command reply from WeChat → route to the bound claude session's
        // pending file so its asyncRewake/cron hook can inject it. Same logic
        // the relay uses remotely; here the bridge writes directly.
        const session = event.raw.session_id;
        const targets = routeAndAppend(event.accountId, event.userId, {
          text: event.text,
          userId: event.userId,
          timestamp: event.timestamp,
          session,
        });
        this.opts.logger.info(`inbound routed to session(s): ${targets.join(", ")}`);
        this.broadcast({
          type: "inbound",
          accountId: event.accountId,
          userId: event.userId,
          text: event.text,
          timestamp: event.timestamp,
          session,
        });
        await this.mirrorInbound(event);
      },
    })
      .catch((err) => this.opts.logger.error(`monitor ${accountId} crashed: ${String(err)}`))
      .finally(() => {
        handle.running = false;
      });
  }

  private async mirrorInbound(event: {
    accountId: string;
    userId: string;
    text: string;
    contextToken?: string;
    timestamp?: number;
  }): Promise<void> {
    if (!this.opts.inboundWebhook) return;
    try {
      await fetch(this.opts.inboundWebhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: event.accountId,
          userId: event.userId,
          text: event.text,
          timestamp: event.timestamp,
        }),
      });
    } catch (err) {
      this.opts.logger.warn(`inbound mirror to ${this.opts.inboundWebhook} failed: ${String(err)}`);
    }
  }

  // ── auth + hardening ────────────────────────────────────────────────────────

  private authorized(req: http.IncomingMessage): boolean {
    if (!this.opts.apiToken) return true;
    // Header-only — never accept a token via query string (leaks into logs).
    const header = req.headers.authorization ?? "";
    return header.startsWith("Bearer ") && header.slice(7).trim() === this.opts.apiToken;
  }

  /** Best-effort client IP, honoring X-Forwarded-For when trusted. */
  private clientIp(req: http.IncomingMessage): string {
    if (this.opts.trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  private isLoopback(ip: string): boolean {
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  }

  /** True if the IP passes the allowlist (empty list = allow all). */
  private ipAllowed(ip: string): boolean {
    if (this.opts.allowIps.length === 0) return true;
    if (this.isLoopback(ip)) return true;
    return this.opts.allowIps.some((rule) => ip === rule || ip.endsWith(rule) || rule === ip);
  }

  /** Token-bucket-ish per-IP limiter. Returns true if the call is allowed. */
  private rateLimitOk(ip: string): boolean {
    const cap = this.opts.rateLimitPerMin;
    if (!cap || cap <= 0) return true;
    const now = Date.now();
    let bucket = this.rlBuckets.get(ip);
    if (!bucket || now - bucket.start > 60_000) {
      bucket = { start: now, count: 0 };
      this.rlBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    return bucket.count <= cap;
  }

  /** Push an inbound event to every matching SSE subscriber. */
  private broadcast(ev: InboundBroadcast): void {
    if (this.sseClients.size === 0) return;
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of this.sseClients) {
      const f = c.filter;
      if (f.accountId && f.accountId !== ev.accountId) continue;
      if (f.userId && f.userId !== ev.userId) continue;
      if (f.session && f.session !== ev.session) continue;
      try {
        c.res.write(line);
      } catch {
        this.sseClients.delete(c);
      }
    }
  }

  // ── routing ──────────────────────────────────────────────────────────────────

  /** GET /events — Server-Sent Events stream of inbound messages. */
  private async handleEvents(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    const ip = this.clientIp(req);
    if (!this.ipAllowed(ip)) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const filter: SseClient["filter"] = {
      accountId: url.searchParams.get("accountId") ?? undefined,
      userId: url.searchParams.get("userId") ?? undefined,
      session: url.searchParams.get("session") ?? undefined,
    };
    res.writeHead(200, {
      "content-type": "text/event-stream",
      cache: "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    const client: SseClient = { res, filter };
    this.sseClients.add(client);
    req.on("close", () => {
      this.sseClients.delete(client);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    const ip = this.clientIp(req);

    // Health is always public (load balancers / monitoring).
    if (path === "/health" && method === "GET") {
      const accounts = listAccountIds();
      const alive = accounts.filter((id) => this.monitors.get(id)?.running);
      return sendJson(res, 200, {
        ok: true,
        accounts: accounts.length,
        monitorsAlive: alive.length,
        sseClients: this.sseClients.size,
        outboxPending: accounts.reduce((n, id) => n + this.outbox.pending(id), 0),
      });
    }

    // Config UI is public so a browser can load it; the /config data endpoints
    // below still require auth. (Trusted-local use; put it behind a token + IP
    // allowlist for public deployments.)
    if (path === "/" && method === "GET") {
      return this.serveConfigPage(res);
    }

    // IP allowlist gate (everything past health).
    if (!this.ipAllowed(ip)) {
      return sendJson(res, 403, { error: "forbidden" });
    }

    if (!this.authorized(req)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (path === "/status" && method === "GET") {
      return sendJson(res, 200, this.status());
    }

    if (path === "/accounts" && method === "GET") {
      return sendJson(res, 200, { accounts: listAccountIds() });
    }

    if (path === "/config" && method === "GET") {
      const cfg = loadHooksConfig() ?? defaultHooksConfig();
      return sendJson(res, 200, cfg);
    }

    if (path === "/config" && method === "POST") {
      return sendJson(res, 200, this.handleConfigSave(await readBody(req)));
    }

    if (path === "/routes" && method === "POST") {
      // SessionStart registration: { session, userId?, accountId? }
      let body: { session?: string; userId?: string; accountId?: string };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { error: "invalid JSON body" });
      }
      if (!body.session) return sendJson(res, 400, { error: "session required" });
      const entry = touchSession(body.session, { userId: body.userId, accountId: body.accountId });
      return sendJson(res, 200, { ok: true, label: entry.label });
    }

    if (path === "/send" && method === "POST") {
      if (!this.rateLimitOk(ip)) {
        return sendJson(res, 429, { error: "rate limit exceeded" });
      }
      return sendJson(res, 200, await this.handleSend(await readBody(req)));
    }

    // Login endpoints can be shuttered for public deployments.
    if ((path === "/login/start" || path === "/login/wait") && method === "POST") {
      if (this.opts.disableLogin) {
        return sendJson(res, 404, { error: "login endpoints disabled (WECLAW_DISABLE_LOGIN=1)" });
      }
      if (path === "/login/start") return sendJson(res, 200, await this.handleLoginStart());
      return sendJson(res, 200, await this.handleLoginWait(await readBody(req)));
    }

    sendJson(res, 404, { error: `not found: ${method} ${path}` });
  }

  private status(): unknown {
    const accounts = listAccountIds().map((id) => {
      const data = loadAccount(id);
      const mon = this.monitors.get(id);
      const userId = data?.userId;
      return {
        accountId: id,
        configured: Boolean(data?.token),
        // mask the recipient id — /status is meant for liveness, not contact export
        userId: userId ? maskId(userId) : undefined,
        monitorRunning: mon?.running ?? false,
        lastInboundAt: mon?.lastInboundAt ?? null,
        contextTokenAgeSec: userId ? contextTokenAgeSec(id, userId) : undefined,
        outboxPending: this.outbox.pending(id),
      };
    });
    return { accounts };
  }

  private async handleSend(bodyText: string): Promise<unknown> {
    let body: { text?: string; to?: string; account?: string; session?: string };
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    const text = body.text;
    if (typeof text !== "string" || text.length === 0) {
      throw new HttpError(400, "body.text is required (non-empty string)");
    }
    // Scrub secrets before anything leaves the process.
    const redaction = redact(text, { enabled: this.opts.redact });
    if (redaction.count > 0) {
      this.opts.logger.warn(`outbound redacted: ${redaction.kinds.join(", ")}`);
    }
    let account;
    try {
      account = resolveAccount(body.account);
    } catch (err) {
      throw new HttpError(404, String(err instanceof Error ? err.message : err));
    }
    if (!account.configured) {
      throw new HttpError(409, `account ${account.accountId} not configured; run \`weclaw login\``);
    }
    let to: string;
    try {
      to = resolveTarget(account.accountId, body.to);
    } catch (err) {
      throw new HttpError(400, String(err instanceof Error ? err.message : err));
    }
    // Learn the claude session ↔ WeChat user binding so inbound replies route back.
    if (typeof body.session === "string" && body.session) {
      touchSession(body.session, { userId: to, accountId: account.accountId });
    }
    const client = new IlinkClient({
      baseUrl: account.baseUrl,
      token: account.token,
      channelVersion: this.opts.channelVersion,
    });
    const contextToken = getContextToken(account.accountId, to);
    const safeText = redaction.text;
    const chunks = chunkText(safeText);
    try {
      let lastMessageId = "";
      for (let i = 0; i < chunks.length; i++) {
        const part = chunks.length > 1 ? `${chunks[i]}\n(${i + 1}/${chunks.length})` : chunks[i];
        const r = await sendText(client, { to, text: part, contextToken });
        lastMessageId = r.messageId;
      }
      archive({ dir: "out", accountId: account.accountId, userId: to, text: safeText, status: "delivered" });
      return { ok: true, account: account.accountId, to, messageId: lastMessageId, parts: chunks.length };
    } catch (err) {
      if (err instanceof SendError && (err.kind === "prepare_failed" || err.kind === "stale_token")) {
        // Missing / expired session: park the message and wait for a fresh capture.
        markContextTokenStale(account.accountId, to, true);
        const id = this.outbox.enqueue(account.accountId, { to, text: safeText, contextToken }, err.kind);
        archive({ dir: "out", accountId: account.accountId, userId: to, text: safeText, status: "queued" });
        const hint =
          err.kind === "stale_token"
            ? "bot token 失效，请运行 `weclaw login` 重新绑定后再发"
            : "缺少会话凭证；请在手机微信里给 bot 发一条消息建立会话，桥接会自动重发";
        return {
          ok: false,
          queued: true,
          outboxId: id,
          reason: err.kind,
          pending: this.outbox.pending(account.accountId, to),
          hint,
        };
      }
      archive({ dir: "out", accountId: account.accountId, userId: to, text: safeText, status: "failed" });
      throw new HttpError(502, `send failed: ${String(err instanceof Error ? err.message : err)}`);
    }
  }

  // ── server-driven login (returns QR URL for the caller to render) ───────────

  private async handleLoginStart(): Promise<unknown> {
    const baseUrl = this.opts.baseUrl ?? DEFAULT_BASE_URL;
    const client = new IlinkClient({ baseUrl, channelVersion: this.opts.channelVersion });
    const localTokenList: string[] = [];
    for (const id of listAccountIds()) {
      const t = loadAccount(id)?.token?.trim();
      if (t) localTokenList.push(t);
    }
    const qr = await client.getBotQrCode("3", localTokenList);
    const sessionKey = crypto.randomUUID();
    this.logins.set(sessionKey, { client, qrcode: qr.qrcode });
    return { qrcodeUrl: qr.qrcode_img_content, qrcodePayload: qr.qrcode, sessionKey };
  }

  private async handleLoginWait(bodyText: string): Promise<unknown> {
    let body: { sessionKey?: string; verifyCode?: string };
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    const sessionKey = body.sessionKey ?? "";
    const entry = this.logins.get(sessionKey);
    if (!entry) throw new HttpError(404, "unknown or expired sessionKey");
    // Single long-poll tick; caller repeats until connected.
    const status = await entry.client.getQrcodeStatus(entry.qrcode, body.verifyCode, 30_000);
    return { status: status.status };
  }

  // ── config UI ───────────────────────────────────────────────────────────────

  private serveConfigPage(res: http.ServerResponse): void {
    const html = readConfigHtml();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  }

  private handleConfigSave(bodyText: string): unknown {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    // Merge onto the EXISTING config so partial saves don't reset other fields.
    const existing = loadHooksConfig() ?? defaultHooksConfig();
    const cfg = { ...existing, ...body } as ReturnType<typeof defaultHooksConfig>;
    // Light validation on types we depend on.
    if (typeof cfg.target !== "string") throw new HttpError(400, "target must be a string");
    saveHooksConfig(cfg);
    this.opts.logger.info("hooks config updated via /config");
    return { ok: true };
  }
}

/** Path to the bundled config page (assets/config.html relative to dist/). */
function configHtmlPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/bridge
  return path.resolve(here, "..", "..", "assets", "config.html");
}

let cachedHtml: string | null = null;
function readConfigHtml(): string {
  if (cachedHtml != null) return cachedHtml;
  try {
    cachedHtml = fs.readFileSync(configHtmlPath(), "utf-8");
  } catch {
    cachedHtml = "<!doctype html><meta charset=utf-8><title>weclaw</title><p>config.html not found (run from the installed package).</p>";
  }
  return cachedHtml;
}

