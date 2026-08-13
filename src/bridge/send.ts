/** Outbound helpers — build & send text messages via the iLink protocol. */

import { IlinkClient } from "../ilink/client.js";
import { MessageItemType, MessageType, MessageState } from "../ilink/types.js";
import type { SendMessageReq, SendMessageResp } from "../ilink/types.js";
import { generateClientId } from "../util/id.js";

export interface SendTextParams {
  to: string;
  text: string;
  /** Context token captured from the inbound conversation. */
  contextToken?: string;
  runId?: string;
}

/** Classification of send failures, so callers can recover (e.g. queue + wait). */
export type SendErrorKind =
  | "stale_token" // errcode -14 / token expired → needs re-login or re-capture
  | "prepare_failed" // ret -2 → missing/invalid context_token, needs user to message first
  | "rejected" // non-zero ret, transient or permanent server rejection
  | "network"; // fetch-level failure

export class SendError extends Error {
  constructor(
    message: string,
    public readonly kind: SendErrorKind,
    public readonly ret?: number,
    public readonly errcode?: number,
  ) {
    super(message);
    this.name = "SendError";
  }
}

/** Map a sendMessage response to a SendErrorKind, or null on success. */
export function classifySendResp(resp: SendMessageResp): SendErrorKind | null {
  const retOk = resp.ret === undefined || resp.ret === 0;
  const errOk = resp.errcode === undefined || resp.errcode === 0;
  if (retOk && errOk) return null;
  if (resp.errcode === -14 || resp.ret === -14) return "stale_token";
  if (resp.ret === -2) return "prepare_failed";
  return "rejected";
}

/** Build a SendMessageReq carrying a single text item. */
export function buildTextMessageReq(params: SendTextParams): SendMessageReq {
  const item_list =
    params.text && params.text.length > 0
      ? [{ type: MessageItemType.TEXT, text_item: { text: params.text } }]
      : undefined;
  return {
    msg: {
      from_user_id: "",
      to_user_id: params.to,
      client_id: generateClientId(),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list,
      context_token: params.contextToken,
      run_id: params.runId,
    },
  };
}

/** Send a plain text message downstream. Returns the client_id (messageId). */
export async function sendText(
  client: IlinkClient,
  params: SendTextParams,
): Promise<{ messageId: string }> {
  const req = buildTextMessageReq(params);
  let resp: SendMessageResp;
  try {
    resp = await client.sendMessage(req);
  } catch (err) {
    throw new SendError(`sendMessage network error: ${String(err)}`, "network");
  }
  const kind = classifySendResp(resp);
  if (kind) {
    const detail = `ret=${resp.ret} errcode=${resp.errcode ?? "(none)"} errmsg=${resp.errmsg ?? "(none)"}`;
    throw new SendError(`sendMessage ${kind}: ${detail}`, kind, resp.ret, resp.errcode);
  }
  return { messageId: req.msg.client_id ?? "" };
}
