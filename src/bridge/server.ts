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
import type { AddressInfo } from "node:net";

import { IlinkClient, DEFAULT_BASE_URL } from "../ilink/client.js";
import { sendText, SendError } from "./send.js";
import { runMonitor } from "./monitor.js";
import { Outbox } from "./outbox.js";
import { redact } from "../util/redact.js";
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
  logger?: Logger;
}

interface MonitorHandle {
  accountId: string;
  controller: AbortController;
  running: boolean;
  lastInboundAt: number | null;
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

export class BridgeServer {
  private readonly opts: Required<
    Omit<ServerOptions, "apiToken" | "inboundWebhook" | "baseUrl" | "channelVersion" | "redact" | "logger">
  > & {
    apiToken?: string;
    inboundWebhook?: string;
    baseUrl?: string;
    channelVersion?: string;
    redact: boolean;
    logger: Logger;
  };
  private server?: http.Server;
  private readonly monitors = new Map<string, MonitorHandle>();
  private readonly logins = new Map<string, { client: IlinkClient; qrcode: string }>();
  private readonly outbox: Outbox;

  constructor(opts: ServerOptions = {}) {
    this.opts = {
      port: (opts.port ?? Number(process.env.WECLAW_PORT)) || 4789,
      host: (opts.host ?? process.env.WECLAW_HOST) || "127.0.0.1",
      apiToken: opts.apiToken ?? process.env.WECLAW_API_TOKEN,
      inboundWebhook: opts.inboundWebhook ?? process.env.WECLAW_INBOUND_WEBHOOK,
      baseUrl: opts.baseUrl,
      channelVersion: opts.channelVersion,
      redact: opts.redact ?? process.env.WECLAW_NO_REDACT !== "1",
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
    // Boot a monitor for each bound account.
    for (const id of listAccountIds()) {
      void this.startMonitor(id).catch((err: unknown) =>
        this.opts.logger.error(`failed to start monitor ${id}: ${String(err)}`),
      );
    }

    this.server = http.createServer((req, res) => {
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
  }

  async stop(): Promise<void> {
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

  // ── auth ─────────────────────────────────────────────────────────────────────

  private authorized(req: http.IncomingMessage): boolean {
    if (!this.opts.apiToken) return true;
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Bearer ") && header.slice(7).trim() === this.opts.apiToken) return true;
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("token") === this.opts.apiToken;
  }

  // ── routing ──────────────────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    // Health is always public.
    if (path === "/health" && method === "GET") {
      return sendJson(res, 200, { ok: true });
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

    if (path === "/send" && method === "POST") {
      return sendJson(res, 200, await this.handleSend(await readBody(req)));
    }

    if (path === "/login/start" && method === "POST") {
      return sendJson(res, 200, await this.handleLoginStart());
    }

    if (path === "/login/wait" && method === "POST") {
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
        userId,
        monitorRunning: mon?.running ?? false,
        lastInboundAt: mon?.lastInboundAt ?? null,
        contextTokenAgeSec: userId ? contextTokenAgeSec(id, userId) : undefined,
        outboxPending: this.outbox.pending(id),
      };
    });
    return { accounts };
  }

  private async handleSend(bodyText: string): Promise<unknown> {
    let body: { text?: string; to?: string; account?: string };
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
    const client = new IlinkClient({
      baseUrl: account.baseUrl,
      token: account.token,
      channelVersion: this.opts.channelVersion,
    });
    const contextToken = getContextToken(account.accountId, to);
    const safeText = redaction.text;
    try {
      const { messageId } = await sendText(client, { to, text: safeText, contextToken });
      return { ok: true, account: account.accountId, to, messageId };
    } catch (err) {
      if (err instanceof SendError && (err.kind === "prepare_failed" || err.kind === "stale_token")) {
        // Missing / expired session: park the message and wait for a fresh capture.
        markContextTokenStale(account.accountId, to, true);
        const id = this.outbox.enqueue(account.accountId, { to, text: safeText, contextToken }, err.kind);
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
}
