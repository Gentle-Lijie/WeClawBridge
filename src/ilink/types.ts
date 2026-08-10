/**
 * iLink (WeChat ClawBot) wire types.
 *
 * Mirrors the protobuf-ish JSON contract used by `ilinkai.weixin.qq.com`.
 * Byte fields are base64-encoded strings inside JSON.
 *
 * Reverse-engineered from @tencent-weixin/openclaw-weixin; re-implemented
 * here so the bridge can run without the openclaw host framework.
 */

/** Metadata attached to every outbound CGI request. */
export interface BaseInfo {
  channel_version?: string;
  /** UA-style self-declared bot identity; observability only. Default "WeClawBridge". */
  bot_agent?: string;
}

// ── QR login ────────────────────────────────────────────────────────────────

export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export type QRStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "need_verifycode"
  | "verify_code_blocked"
  | "scaned_but_redirect"
  | "binded_redirect";

export interface QRStatusResponse {
  status: QRStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

// ── Messages ────────────────────────────────────────────────────────────────

export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export interface TextItem {
  text?: string;
}

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  text_item?: TextItem;
  image_item?: Record<string, unknown>;
  voice_item?: Record<string, unknown> & { text?: string };
  file_item?: Record<string, unknown>;
  video_item?: Record<string, unknown>;
}

/** Unified message (proto: WeixinMessage). */
export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

// ── getUpdates ───────────────────────────────────────────────────────────────

export interface GetUpdatesResp {
  ret?: number;
  /** Server error code (e.g. -14 = stale token / session timeout). */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  /** Server-suggested timeout (ms) for the next long-poll. */
  longpolling_timeout_ms?: number;
}

// ── sendMessage ──────────────────────────────────────────────────────────────

export interface SendMessageReq {
  msg: WeixinMessage;
  base_info?: BaseInfo;
}

export interface SendMessageResp {
  ret?: number;
  errmsg?: string;
}

// ── getConfig / sendTyping ──────────────────────────────────────────────────

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

export interface SendTypingReq {
  ilink_user_id: string;
  typing_ticket?: string;
  status?: number;
  base_info?: BaseInfo;
}

// ── notify start/stop ─────────────────────────────────────────────────────────

export interface NotifyResp {
  ret?: number;
  errmsg?: string;
}
