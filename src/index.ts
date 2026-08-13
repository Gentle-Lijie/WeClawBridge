/**
 * Public API surface for weclaw-bridge.
 */

export { IlinkClient, IlinkError, DEFAULT_BASE_URL, CDN_BASE_URL, encodeClientVersion } from "./ilink/client.js";
export * as IlinkTypes from "./ilink/types.js";
export {
  resolveStateDir,
  listAccountIds,
  loadAccount,
  saveAccount,
  resolveAccount,
  normalizeAccountId,
  getContextToken,
  getContextTokenMeta,
  contextTokenAgeSec,
  markContextTokenStale,
  setContextToken,
  onContextTokenRefresh,
} from "./store/account.js";
export { loginWithQr } from "./auth/login.js";
export { runMonitor, extractText } from "./bridge/monitor.js";
export { sendText, buildTextMessageReq, SendError } from "./bridge/send.js";
export { BridgeServer } from "./bridge/server.js";
export { RelayServer } from "./bridge/relay.js";
export { Outbox } from "./bridge/outbox.js";
export { redact, looksSensitive } from "./util/redact.js";
export { deployRemote } from "./service/deploy.js";
export { Logger } from "./util/log.js";
