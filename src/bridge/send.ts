/** Outbound helpers — build & send text messages via the iLink protocol. */

import { IlinkClient } from "../ilink/client.js";
import { MessageItemType, MessageType, MessageState } from "../ilink/types.js";
import type { SendMessageReq } from "../ilink/types.js";
import { generateClientId } from "../util/id.js";

export interface SendTextParams {
  to: string;
  text: string;
  /** Context token captured from the inbound conversation. */
  contextToken?: string;
  runId?: string;
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
  const resp = await client.sendMessage(req);
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
  }
  return { messageId: req.msg.client_id ?? "" };
}
