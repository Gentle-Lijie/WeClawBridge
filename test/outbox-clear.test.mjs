import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = await mkdtemp(path.join(os.tmpdir(), "weclaw-outbox-test-"));
process.env.WECLAW_STATE_DIR = stateDir;

const [{ Outbox }, { IlinkClient }, { setContextToken }] = await Promise.all([
  import("../dist/bridge/outbox.js"),
  import("../dist/ilink/client.js"),
  import("../dist/store/account.js"),
]);

test.after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

test("clearAccount discards every user queue for one account", () => {
  const outbox = new Outbox({ clientFor: () => null });
  outbox.enqueue("account-a", { to: "user-1", text: "one" }, "test");
  outbox.enqueue("account-a", { to: "user-1", text: "two" }, "test");
  outbox.enqueue("account-a", { to: "user-2", text: "three" }, "test");
  outbox.enqueue("account-b", { to: "user-3", text: "keep" }, "test");

  assert.equal(outbox.clearAccount("account-a"), 3);
  assert.equal(outbox.pending("account-a"), 0);
  assert.equal(outbox.pending("account-b"), 1);
  assert.deepEqual(outbox.snapshot().map((entry) => entry.text), ["keep"]);
  assert.equal(outbox.clearAccount("account-a"), 0);
});

test("an in-flight flush cannot send old tail entries or delete a replacement queue", async () => {
  const accountId = "account-race";
  const userId = "user-race";
  setContextToken(accountId, userId, "fresh-token");

  let releaseFirst;
  let markStarted;
  const firstStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const firstReleased = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const sent = [];
  const client = new IlinkClient({ token: "test-token" });
  client.sendMessage = async (request) => {
    const text = request.msg.item_list?.[0]?.text_item?.text ?? "";
    sent.push(text);
    if (text === "old-1") {
      markStarted();
      await firstReleased;
    }
    return { ret: 0, errcode: 0 };
  };

  const outbox = new Outbox({ clientFor: () => client });
  outbox.enqueue(accountId, { to: userId, text: "old-1" }, "test");
  outbox.enqueue(accountId, { to: userId, text: "old-2" }, "test");

  const flushing = outbox.flush(accountId, userId);
  await firstStarted;
  assert.equal(outbox.clearAccount(accountId), 2);
  outbox.enqueue(accountId, { to: userId, text: "new" }, "test");
  releaseFirst();
  await flushing;

  assert.deepEqual(sent, ["old-1"]);
  assert.equal(outbox.pending(accountId, userId), 1);

  await outbox.flush(accountId, userId);
  assert.deepEqual(sent, ["old-1", "new"]);
  assert.equal(outbox.pending(accountId, userId), 0);
});
