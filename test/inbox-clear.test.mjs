import assert from "node:assert/strict";
import test from "node:test";

import { routeInbound } from "../dist/bridge/inbox.js";

function route(text, clearOutbox) {
  return routeInbound(
    { accountId: "account-current", userId: "user-current", text },
    { clearOutbox },
  );
}

test("/clear clears the inbound account and reports the discarded count", () => {
  const calls = [];
  const result = route("/clear", (accountId) => {
    calls.push(accountId);
    return 4;
  });

  assert.deepEqual(calls, ["account-current"]);
  assert.deepEqual(result, {
    handled: true,
    reply: "已丢弃当前账号 outbox 中 4 条 agent 待发消息（webhook 推送不受影响）。",
  });
});

test("/clear reports an empty outbox", () => {
  const result = route("/clear", () => 0);
  assert.deepEqual(result, {
    handled: true,
    reply: "当前账号 outbox 没有 agent 待发消息。",
  });
});

test("legacy /clear arguments are rejected without clearing", () => {
  for (const text of ["/clear 1", "/clear all"]) {
    let called = false;
    const result = route(text, () => {
      called = true;
      return 1;
    });
    assert.equal(called, false);
    assert.deepEqual(result, {
      handled: true,
      reply: "用法：/clear（清空当前账号 outbox 的 agent 待发消息，webhook 推送不受影响）",
    });
  }
});
