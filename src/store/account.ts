/**
 * Account + session state persistence.
 *
 * Layout (under the state dir, default `~/.weclaw-bridge`):
 *   accounts.json                          → index of accountIds
 *   accounts/<id>.json                     → { token, savedAt, baseUrl, userId }
 *   accounts/<id>.sync.json                → { get_updates_buf }
 *   accounts/<id>.context-tokens.json      → { userId: contextToken }
 *
 * This is a standalone store (no openclaw). File shapes intentionally mirror
 * the upstream plugin so credentials remain human-readable / portable.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BASE_URL } from "../ilink/client.js";

/** Resolve the bridge state directory. */
export function resolveStateDir(): string {
  return (
    process.env.WECLAW_STATE_DIR?.trim() ||
    // Reuse an existing openclaw state dir if present (lets a user who already
    // bound via openclaw reuse those credentials). Falls back to our own dir.
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".weclaw-bridge")
  );
}

function weixinStateDir(): string {
  return path.join(resolveStateDir(), "openclaw-weixin");
}

function accountsDir(): string {
  return path.join(weixinStateDir(), "accounts");
}

function accountIndexPath(): string {
  return path.join(weixinStateDir(), "accounts.json");
}

/**
 * Normalize a raw ilink bot id (e.g. `hex@im.bot`, `hex@im.wechat`) into a
 * filesystem-safe key (`hex-im-bot`). Reverse of deriveRawAccountId.
 */
export function normalizeAccountId(rawId: string): string {
  const trimmed = rawId.trim();
  return trimmed.replace(/@/g, "-").replace(/\./g, "-");
}

/** Derive the original raw id from a normalized one (compat lookup helper). */
export function deriveRawAccountId(normalizedId: string): string | undefined {
  if (normalizedId.endsWith("-im-bot")) return `${normalizedId.slice(0, -7)}@im.bot`;
  if (normalizedId.endsWith("-im-wechat")) return `${normalizedId.slice(0, -10)}@im.wechat`;
  return undefined;
}

// ── index ────────────────────────────────────────────────────────────────────

export function listAccountIds(): string[] {
  try {
    if (!fs.existsSync(accountIndexPath())) return [];
    const parsed = JSON.parse(fs.readFileSync(accountIndexPath(), "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

export function registerAccountId(accountId: string): void {
  fs.mkdirSync(weixinStateDir(), { recursive: true });
  const ids = listAccountIds();
  if (ids.includes(accountId)) return;
  fs.writeFileSync(accountIndexPath(), JSON.stringify([...ids, accountId], null, 2), "utf-8");
}

export function unregisterAccountId(accountId: string): void {
  const ids = listAccountIds();
  const next = ids.filter((id) => id !== accountId);
  if (next.length !== ids.length) {
    fs.writeFileSync(accountIndexPath(), JSON.stringify(next, null, 2), "utf-8");
  }
}

// ── per-account credentials ───────────────────────────────────────────────────

export interface AccountData {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  userId?: string;
}

export interface ResolvedAccount {
  accountId: string;
  token?: string;
  baseUrl: string;
  configured: boolean;
  userId?: string;
}

function accountFilePath(accountId: string): string {
  return path.join(accountsDir(), `${accountId}.json`);
}

function readJsonIfExists<T>(filePath: string): T | null {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    // ignore
  }
  return null;
}

export function loadAccount(accountId: string): AccountData | null {
  const primary = readJsonIfExists<AccountData>(accountFilePath(accountId));
  if (primary) return primary;
  const rawId = deriveRawAccountId(accountId);
  if (rawId) {
    const compat = readJsonIfExists<AccountData>(accountFilePath(rawId));
    if (compat) return compat;
  }
  return null;
}

export function saveAccount(accountId: string, update: AccountData): void {
  fs.mkdirSync(accountsDir(), { recursive: true });
  const existing = loadAccount(accountId) ?? {};
  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId = update.userId !== undefined ? update.userId.trim() || undefined : existing.userId;
  const data: AccountData = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };
  const filePath = accountFilePath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

export function clearAccount(accountId: string): void {
  for (const file of [`${accountId}.json`, `${accountId}.sync.json`, `${accountId}.context-tokens.json`]) {
    try {
      fs.unlinkSync(path.join(accountsDir(), file));
    } catch {
      // ignore
    }
  }
  unregisterAccountId(accountId);
}

/** Resolve an account by id (or return the single registered account). */
export function resolveAccount(accountId?: string): ResolvedAccount {
  const ids = listAccountIds();
  if (ids.length === 0) {
    throw new Error("no bound accounts — run `weclaw login` first");
  }
  const id = accountId?.trim() || (ids.length === 1 ? ids[0] : undefined);
  if (!id) {
    throw new Error(
      `multiple accounts bound (${ids.join(", ")}); specify --account <id>`,
    );
  }
  const data = loadAccount(id);
  if (!data) throw new Error(`account ${id} not found in store`);
  const token = data.token?.trim();
  return {
    accountId: id,
    token,
    baseUrl: data.baseUrl?.trim() || DEFAULT_BASE_URL,
    configured: Boolean(token),
    userId: data.userId?.trim() || undefined,
  };
}

// ── get_updates_buf persistence ─────────────────────────────────────────────

function syncBufFilePath(accountId: string): string {
  return path.join(accountsDir(), `${accountId}.sync.json`);
}

export function loadSyncBuf(accountId: string): string {
  const data = readJsonIfExists<{ get_updates_buf?: string }>(syncBufFilePath(accountId));
  return data?.get_updates_buf ?? "";
}

export function saveSyncBuf(accountId: string, getUpdatesBuf: string): void {
  fs.mkdirSync(accountsDir(), { recursive: true });
  fs.writeFileSync(syncBufFilePath(accountId), JSON.stringify({ get_updates_buf: getUpdatesBuf }), "utf-8");
}

// ── context tokens (per account+user) ─────────────────────────────────────────

function contextTokensFilePath(accountId: string): string {
  return path.join(accountsDir(), `${accountId}.context-tokens.json`);
}

export function loadContextTokens(accountId: string): Record<string, string> {
  return readJsonIfExists<Record<string, string>>(contextTokensFilePath(accountId)) ?? {};
}

export function setContextToken(accountId: string, userId: string, token: string): void {
  if (!userId || !token) return;
  const tokens = loadContextTokens(accountId);
  if (tokens[userId] === token) return;
  tokens[userId] = token;
  fs.mkdirSync(accountsDir(), { recursive: true });
  fs.writeFileSync(contextTokensFilePath(accountId), JSON.stringify(tokens), "utf-8");
}

export function getContextToken(accountId: string, userId: string): string | undefined {
  return loadContextTokens(accountId)[userId];
}

/**
 * Find accountIds that have an active context token for the given userId.
 * Used to infer the sending account from a recipient address.
 */
export function findAccountIdsByUser(userId: string): string[] {
  return listAccountIds().filter((id) => Boolean(getContextToken(id, userId)));
}
