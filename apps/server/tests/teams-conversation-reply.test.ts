import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamsSendRejectedError } from "@assistant/features";
import { openTeamsStore } from "../dist/teams-store.js";
import { readConfig } from "../dist/config.js";
import { teamsConversationReplyApi } from "../dist/teams-conversation-reply-api.js";
import { sendTeamsMessage } from "../dist/teams-send.js";
import type { TeamsSender } from "../dist/teams-reply-port.js";

const body = { chatId: "chat", requestId: "00000000-0000-4000-8000-000000000001", text: "收到，明天下午回复。\n<script>literal</script>" };
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "teams-reply-"));
  let store = openTeamsStore(dir), sends = 0, reads = 0;
  const sender: TeamsSender = {
    read: async () => { reads++; return { data: { items: [], nextCursor: null } }; },
    send: async (chatId, text, canSend) => { assert.equal(chatId, body.chatId); assert.equal(text, body.text); assert.equal(canSend?.(), true); sends++; },
  };
  const config = readConfig({});
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    sender, config, get store() { return store; }, get sends() { return sends; }, get reads() { return reads; },
    restart() { store.close(); store = openTeamsStore(dir); },
    call: (value: Record<string, unknown> = body) => teamsConversationReplyApi({ config, teamsSender: sender, teamsStore: store }, "POST", new URL("http://local/api/teams/conversations/reply"), value),
  };
}

test("direct reply verifies current access and sends once across concurrent requests, replays and restarts", async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.call(), f.call()]);
  assert.equal(f.sends, 1);
  assert.ok(results.every(value => ["sent", "sending"].includes(value!.data.state)));
  assert.equal((await f.call())!.data.state, "sent");
  f.restart(); delete f.sender.send; delete f.sender.read;
  assert.equal((await f.call())!.data.state, "sent"); assert.equal(f.sends, 1);
  await assert.rejects(f.call({ ...body, text: "another reply" }), /另一份回复/);
  await assert.rejects(f.call({ ...body, chatId: "other" }), /另一份回复/);
});

test("invalid input, offline mode, missing connector and denied online access never send", async t => {
  const f = await fixture(t);
  for (const value of [{ ...body, text: " \n" }, { ...body, text: "中".repeat(5334) }, { ...body, chatId: ".." }, { ...body, requestId: "bad" }]) await assert.rejects(f.call(value));
  assert.equal(f.reads, 0);
  f.config.offline = true; await assert.rejects(f.call(), /尚未连接/); f.config.offline = false;
  const send = f.sender.send; delete f.sender.send; await assert.rejects(f.call(), /尚未连接/); f.sender.send = send;
  f.sender.read = async () => { throw Object.assign(new Error("当前账号没有访问权限"), { status: 403 }); };
  await assert.rejects(f.call(), /访问权限/);
  assert.equal(f.sends, 0);
});

test("definite rejection remains retryable only with a new request, provider errors never leak", async t => {
  const f = await fixture(t); let attempts = 0;
  f.sender.send = async () => { attempts++; throw new TeamsSendRejectedError("PRIVATE_PROVIDER_RESPONSE"); };
  const result = (await f.call())!.data;
  assert.equal(result.state, "rejected"); assert.match(result.error!, /ChatMessage.Send/); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  await f.call(); assert.equal(attempts, 1);
  await f.call({ ...body, requestId: "00000000-0000-4000-8000-000000000002" }); assert.equal(attempts, 2);
});

test("ambiguous failures and interrupted sends persist as unknown and never resend", async t => {
  const f = await fixture(t); let attempts = 0;
  f.sender.send = async () => { attempts++; throw new Error("PRIVATE_TIMEOUT"); };
  const result = (await f.call())!.data;
  assert.equal(result.state, "unknown"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  f.restart(); assert.equal((await f.call())!.data.state, "unknown"); assert.equal(attempts, 1);
  f.store.directReplies.claim("interrupted", "chat", "hash"); f.restart();
  assert.equal(f.store.directReplies.find("interrupted", "chat", "hash")!.state, "unknown");
});

test("access revoked while acquiring the send token is rejected before the Graph POST", async t => {
  const f = await fixture(t); let posts = 0;
  t.mock.method(globalThis, "fetch", async () => { posts++; return Response.json({}); });
  f.sender.send = async (chatId, text, canSend) => { await sendTeamsMessage(async () => { f.store.triage.access(chatId, false); return "synthetic-token"; }, chatId, text, f.store, undefined, canSend); };
  assert.equal((await f.call())!.data.state, "rejected"); assert.equal(posts, 0);
});

test("accepted Graph send with missing local receipt is still sent, and is not replayed", async t => {
  const f = await fixture(t); let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    posts++; assert.equal(init!.method, "POST");
    assert.deepEqual(JSON.parse(String(init!.body)), { body: { contentType: "text", content: body.text } });
    return Response.json({}, { status: 201 });
  });
  f.sender.send = async (chatId, text, canSend) => { await sendTeamsMessage(async () => "synthetic-token", chatId, text, f.store, undefined, canSend); };
  assert.equal((await f.call())!.data.state, "sent");
  f.restart(); await f.call(); assert.equal(posts, 1);
});
