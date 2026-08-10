/**
 * iLink HTTP client — direct re-implementation of the WeChat ClawBot protocol.
 *
 * Talks to `https://ilinkai.weixin.qq.com` using global `fetch`, so it runs on
 * Node >= 18, Bun, and Deno (with node: compat) alike — no native deps.
 */

import crypto from "node:crypto";

import type {
  BaseInfo,
  GetConfigResp,
  GetUpdatesResp,
  NotifyResp,
  QRCodeResponse,
  QRStatusResponse,
  SendMessageReq,
  SendMessageResp,
  SendTypingReq,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** `ilink_appid` advertised in the plugin's package.json. */
const ILINK_APP_ID = "bot";

/** Default `bot_type` for QR login requests. */
export const DEFAULT_BOT_TYPE = "3";

/** Server-reported stale-token / session-timeout error code. */
export const STALE_TOKEN_ERRCODE = -14;

export interface IlinkClientOptions {
  baseUrl?: string;
  /** Bot token obtained after a successful QR login. */
  token?: string;
  /** Channel/plugin version string used for `iLink-App-ClientVersion` + base_info. */
  channelVersion?: string;
  /** Self-declared bot_agent (UA-style). Defaults to "WeClawBridge". */
  botAgent?: string;
  /** Optional routing tag header (SKRouteTag). */
  routeTag?: string;
}

/**
 * Encode a semver string into the uint32 `iLink-App-ClientVersion`:
 * `(major & 0xff) << 16 | (minor & 0xff) << 8 | (patch & 0xff)`.
 */
export function encodeClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return (((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)) >>> 0;
}

/** X-WECHAT-UIN header: random uint32 → decimal string → base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

export class IlinkError extends Error {
  constructor(
    message: string,
    public readonly ret?: number,
    public readonly errcode?: number,
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = "IlinkError";
  }
}

export class IlinkClient {
  readonly baseUrl: string;
  readonly token?: string;
  private readonly channelVersion: string;
  private readonly botAgent: string;
  private readonly routeTag?: string;
  private readonly clientVersion: number;

  constructor(opts: IlinkClientOptions = {}) {
    this.baseUrl = opts.baseUrl?.trim() || DEFAULT_BASE_URL;
    this.token = opts.token?.trim() || undefined;
    this.channelVersion = opts.channelVersion ?? "0.1.0";
    this.botAgent = opts.botAgent?.trim() || "WeClawBridge";
    this.routeTag = opts.routeTag?.trim() || undefined;
    this.clientVersion = encodeClientVersion(this.channelVersion);
  }

  /** Build a new client bound to a different account/token. */
  withToken(token?: string, baseUrl?: string): IlinkClient {
    return new IlinkClient({
      baseUrl: baseUrl ?? this.baseUrl,
      token,
      channelVersion: this.channelVersion,
      botAgent: this.botAgent,
      routeTag: this.routeTag,
    });
  }

  baseInfo(): BaseInfo {
    return { channel_version: this.channelVersion, bot_agent: this.botAgent };
  }

  // ── header builders ───────────────────────────────────────────────────────

  private commonHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(this.clientVersion),
    };
    if (this.routeTag) headers.SKRouteTag = this.routeTag;
    return headers;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
      ...this.commonHeaders(),
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  // ── fetch wrappers ─────────────────────────────────────────────────────────

  private withTrailingSlash(url: string): string {
    return url.endsWith("/") ? url : `${url}/`;
  }

  async get<T>(endpoint: string, timeoutMs?: number): Promise<T> {
    const url = new URL(endpoint, this.withTrailingSlash(this.baseUrl));
    return this.doFetch<T>(url.toString(), "GET", undefined, this.commonHeaders(), timeoutMs, endpoint);
  }

  async post<T>(endpoint: string, body: unknown, timeoutMs?: number): Promise<T> {
    const url = new URL(endpoint, this.withTrailingSlash(this.baseUrl));
    return this.doFetch<T>(
      url.toString(),
      "POST",
      JSON.stringify(body),
      this.authHeaders(),
      timeoutMs,
      endpoint,
    );
  }

  private async doFetch<T>(
    url: string,
    method: string,
    body: string | undefined,
    headers: Record<string, string>,
    timeoutMs: number | undefined,
    endpoint: string,
  ): Promise<T> {
    const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : undefined;
    const timer =
      controller && timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: controller?.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new IlinkError(`${method} ${endpoint} HTTP ${res.status}: ${text}`, undefined, undefined, endpoint);
      }
      return JSON.parse(text) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── QR login ────────────────────────────────────────────────────────────────

  getBotQrCode(botType = DEFAULT_BOT_TYPE, localTokenList: string[] = []): Promise<QRCodeResponse> {
    return this.post<QRCodeResponse>(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      { local_token_list: localTokenList },
      15_000,
    );
  }

  getQrcodeStatus(qrcode: string, verifyCode?: string, timeoutMs = 35_000): Promise<QRStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    return this.get<QRStatusResponse>(endpoint, timeoutMs);
  }

  // ── getUpdates (long-poll) ─────────────────────────────────────────────────

  getUpdates(getUpdatesBuf: string, timeoutMs = 35_000): Promise<GetUpdatesResp> {
    return this.post<GetUpdatesResp>(
      "ilink/bot/getupdates",
      { get_updates_buf: getUpdatesBuf, base_info: this.baseInfo() },
      timeoutMs,
    );
  }

  // ── sendMessage ─────────────────────────────────────────────────────────────

  sendMessage(body: SendMessageReq, timeoutMs = 15_000): Promise<SendMessageResp> {
    const req: SendMessageReq = { ...body, base_info: this.baseInfo() };
    return this.post<SendMessageResp>("ilink/bot/sendmessage", req, timeoutMs);
  }

  // ── config / typing / notify ────────────────────────────────────────────────

  getConfig(ilinkUserId: string, contextToken?: string, timeoutMs = 10_000): Promise<GetConfigResp> {
    return this.post<GetConfigResp>(
      "ilink/bot/getconfig",
      { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: this.baseInfo() },
      timeoutMs,
    );
  }

  sendTyping(body: SendTypingReq, timeoutMs = 10_000): Promise<unknown> {
    return this.post("ilink/bot/sendtyping", { ...body, base_info: this.baseInfo() }, timeoutMs);
  }

  notifyStart(timeoutMs = 10_000): Promise<NotifyResp> {
    return this.post<NotifyResp>("ilink/bot/msg/notifystart", { base_info: this.baseInfo() }, timeoutMs);
  }

  notifyStop(timeoutMs = 10_000): Promise<NotifyResp> {
    return this.post<NotifyResp>("ilink/bot/msg/notifystop", { base_info: this.baseInfo() }, timeoutMs);
  }
}
