/**
 * QR-code login flow — binds a WeChat ClawBot to this bridge without openclaw.
 *
 * Flow:
 *   1. POST get_bot_qrcode  → receive { qrcode, qrcode_img_content }
 *   2. render qrcode_img_content as a terminal QR
 *   3. long-poll get_qrcode_status → wait/scaned/need_verifycode/.../confirmed
 *   4. on `confirmed` → persist token + accountId + baseUrl + userId
 */

import { IlinkClient, DEFAULT_BASE_URL, DEFAULT_BOT_TYPE } from "../ilink/client.js";
import type { QRStatusResponse } from "../ilink/types.js";
import {
  loadAccount,
  normalizeAccountId,
  registerAccountId,
  saveAccount,
  listAccountIds,
  clearAccount,
} from "../store/account.js";
import { sleep } from "../util/id.js";

const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH = 3;
const VERIFY_PROMPT_INITIAL = "输入手机微信显示的数字，以继续连接：";
const VERIFY_PROMPT_RETRY = "❌ 数字不匹配，请重新输入：";

export interface LoginResult {
  connected: boolean;
  alreadyConnected?: boolean;
  accountId?: string;
  botToken?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
}

export interface LoginOptions {
  /** Override base URL (default https://ilinkai.weixin.qq.com). */
  baseUrl?: string;
  /** Override the channel/plugin version advertised to the server. */
  channelVersion?: string;
  /** Verbose polling dots. */
  verbose?: boolean;
  /** Max time to wait for a scan, in ms (default 480_000). */
  timeoutMs?: number;
  /** Injectable client (used by server-driven login / tests). */
  client?: IlinkClient;
}

async function readLineFromStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk: Buffer | string) => {
      input += chunk.toString();
      if (input.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(input.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
  });
}

async function renderQR(content: string): Promise<void> {
  // qrcode_img_content is the data to encode (a URL or payload) — render it
  // as a scannable terminal QR, with a plain-text fallback.
  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(content, { small: true });
  } catch {
    // qrcode-terminal not installed — fall through to URL.
  }
  process.stdout.write("若二维码未显示或不可用，可访问以下链接继续：\n");
  process.stdout.write(`${content}\n`);
}

/**
 * Drive the full interactive QR login. Reads from stdin for the pairing code.
 */
export async function loginWithQr(opts: LoginOptions = {}): Promise<LoginResult> {
  const baseUrl = opts.baseUrl?.trim() || DEFAULT_BASE_URL;
  const client = opts.client ?? new IlinkClient({ baseUrl, channelVersion: opts.channelVersion });
  const timeoutMs = Math.max(opts.timeoutMs ?? 480_000, 1000);
  const deadline = Date.now() + timeoutMs;

  const localTokenList: string[] = [];
  for (const id of listAccountIds()) {
    const t = loadAccount(id)?.token?.trim();
    if (t) localTokenList.push(t);
  }

  // Initial QR.
  let qr = await client.getBotQrCode(DEFAULT_BOT_TYPE, localTokenList);
  await renderQR(qr.qrcode_img_content);
  let currentBaseUrl = baseUrl;
  let scanned = false;
  let refreshCount = 1;
  let pendingVerifyCode: string | undefined;

  while (Date.now() < deadline) {
    let status: QRStatusResponse;
    try {
      status = await client.getQrcodeStatus(qr.qrcode, pendingVerifyCode, QR_LONG_POLL_TIMEOUT_MS);
    } catch (err) {
      // Network error / gateway 524 → treat as wait and keep polling.
      if (opts.verbose) process.stdout.write("!");
      await sleep(1000);
      continue;
    }

    switch (status.status) {
      case "wait":
        if (opts.verbose) process.stdout.write(".");
        break;
      case "scaned":
        pendingVerifyCode = undefined;
        if (!scanned) {
          process.stdout.write("\n正在验证\n");
          scanned = true;
        }
        break;
      case "need_verifycode": {
        const prompt = pendingVerifyCode ? VERIFY_PROMPT_RETRY : VERIFY_PROMPT_INITIAL;
        pendingVerifyCode = await readLineFromStdin(prompt);
        continue; // immediately re-poll with the code
      }
      case "scaned_but_redirect":
        if (status.redirect_host) currentBaseUrl = `https://${status.redirect_host}`;
        break;
      case "expired":
      case "verify_code_blocked": {
        pendingVerifyCode = undefined;
        refreshCount++;
        if (refreshCount > MAX_QR_REFRESH) {
          return { connected: false, message: "二维码多次失效，连接已停止，请重试。" };
        }
        if (status.status === "verify_code_blocked") process.stdout.write("\n⛔ 多次输入错误，请稍后再试。\n");
        process.stdout.write("\n⏳ 正在刷新二维码...\n");
        try {
          qr = await client.getBotQrCode(DEFAULT_BOT_TYPE, localTokenList);
          scanned = false;
          await renderQR(qr.qrcode_img_content);
        } catch (err) {
          return { connected: false, message: `刷新二维码失败: ${String(err)}` };
        }
        break;
      }
      case "binded_redirect":
        process.stdout.write("\n✅ 此微信已绑定过本桥接，无需重复连接。\n");
        return { connected: false, alreadyConnected: true, message: "已连接过，无需重复连接。" };
      case "confirmed": {
        if (!status.ilink_bot_id) {
          return { connected: false, message: "登录失败：服务器未返回 ilink_bot_id。" };
        }
        const normalizedId = normalizeAccountId(status.ilink_bot_id);
        saveAccount(normalizedId, {
          token: status.bot_token,
          baseUrl: status.baseurl || currentBaseUrl,
          userId: status.ilink_user_id,
        });
        registerAccountId(normalizedId);
        // Drop any stale accounts bound to the same WeChat user.
        if (status.ilink_user_id) {
          for (const id of listAccountIds()) {
            if (id === normalizedId) continue;
            if (loadAccount(id)?.userId?.trim() === status.ilink_user_id) clearAccount(id);
          }
        }
        process.stdout.write("\n✅ 已将微信 ClawBot 绑定到本桥接。\n");
        return {
          connected: true,
          accountId: normalizedId,
          botToken: status.bot_token,
          baseUrl: status.baseurl || currentBaseUrl,
          userId: status.ilink_user_id,
          message: "绑定成功。",
        };
      }
    }

    await sleep(1000);
  }

  return { connected: false, message: "登录超时，请重试。" };
}

/** Convenience: perform the interactive login and print a friendly summary. */
export async function runInteractiveLogin(opts: LoginOptions = {}): Promise<void> {
  process.stdout.write("\n请用手机微信扫描以下二维码以绑定 ClawBot：\n\n");
  const result = await loginWithQr(opts);
  process.stdout.write(`\n${result.message}\n`);
  if (result.accountId) {
    process.stdout.write(`accountId: ${result.accountId}\n`);
  }
  if (!result.connected && !result.alreadyConnected) {
    process.exitCode = 1;
  }
}
