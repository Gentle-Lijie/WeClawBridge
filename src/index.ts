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
} from "./store/account.js";
export { loginWithQr } from "./auth/login.js";
export { runMonitor, extractText } from "./bridge/monitor.js";
export { sendText, buildTextMessageReq } from "./bridge/send.js";
export { BridgeServer } from "./bridge/server.js";
export { Logger } from "./util/log.js";
