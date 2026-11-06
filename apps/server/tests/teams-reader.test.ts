import test from "node:test";
import assert from "node:assert/strict";
import { createTeamsReader } from "../dist/teams-reader.js";
import { ATTACHMENT_LIMITS } from "@assistant/features";
import { createTeamsGraph } from "../dist/teams-graph.js";
import { graphPageUrl } from "../dist/teams-graph.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const token = async () => "chat-token";

test("微软分页允许同一聊天 ID 的等价 URL 编码，仍拒绝切换聊天或注入路径", () => {
  const path = "/chats/19%3Aabc%40thread.v2/messages?$top=50";
  const next = GRAPH + "/chats/19:abc@thread.v2/messages?$skiptoken=private";
  assert.equal(graphPageUrl(path, next), next);
  assert.equal(graphPageUrl(path, GRAPH + "/chats/19%3aabc%40thread.v2/messages?$skiptoken=private"), GRAPH + "/chats/19%3aabc%40thread.v2/messages?$skiptoken=private");
  assert.throws(() => graphPageUrl(path, GRAPH + "/chats/another/messages"), /分页地址/);
  assert.throws(() => graphPageUrl("/chats/a%2Fb/messages", GRAPH + "/chats/a/b/messages"), /分页地址/);
});

test("在线历史不受本地日期和正文长度限制，逐页返回原文、消息 ID 及文件链接", async () => {
  const body = "历史原文".repeat(1500), requests: string[] = [];
  const next = GRAPH + "/chats/chat/messages?$skiptoken=next";
  const read = createTeamsReader({ getToken: token, fetchImpl: async input => {
    const url = String(input); requests.push(url);
    return Response.json(url === next ? { value: [{ id: "old", createdDateTime: "2019-01-01T00:00:00Z", body: { content: body } }] }
      : { value: [{ id: "new", attachments: [{ name: "合同.docx", contentUrl: "https://tenant.sharepoint.com/sites/project/合同.docx" }] }], "@odata.nextLink": next });
  } });
  const first = await read({ kind: "history", chatId: "chat" });
  assert.equal((first.data as { complete: boolean }).complete, false);
  assert.equal((first.data as { nextCursor: string }).nextCursor, next);
  const second = await read({ kind: "history", chatId: "chat", cursor: next });
  assert.equal((second.data as { items: { body: { content: string } }[] }).items[0].body.content, body);
  assert.equal((second.data as { complete: boolean }).complete, true);
  assert.equal(requests.length, 2, "按需逐页读取，不能暗中扫描或写入通知缓存");
  assert.match(requests[0], /createdDateTime/);
  assert.match(JSON.stringify(first), /合同\.docx/);
});

test("分页拒绝外站、其他聊天、其他账号、循环和错误格式，不向非法地址发送令牌", async () => {
  for (const cursor of ["https://evil.example/steal", GRAPH + "/chats/another/messages", GRAPH + "/users/another/chats", GRAPH + "/chats/chat/messages#fragment"]) {
    let calls = 0;
    const read = createTeamsReader({ getToken: token, fetchImpl: async () => { calls++; throw new Error("must not fetch"); } });
    await assert.rejects(read({ kind: "history", chatId: "chat", cursor }), /分页地址/);
    assert.equal(calls, 0);
  }
  for (const result of [{ value: {} }, { value: [], "@odata.nextLink": GRAPH + "/chats/chat/messages?$top=50&$orderby=createdDateTime desc" }]) {
    const read = createTeamsReader({ getToken: token, fetchImpl: async () => Response.json(result) });
    await assert.rejects(read({ kind: "history", chatId: "chat" }), /分页/);
  }
});

test("聊天、团队、频道及回复走各自资源，文件授权失败不妨碍聊天历史", async () => {
  const requests: { url: string; auth: string }[] = [];
  const read = createTeamsReader({ getToken: token, getChannelsToken: async () => "channel-token",
    getFilesToken: async () => { throw new Error("files denied"); },
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get("authorization")! });
      return Response.json(String(input).endsWith("/message") ? { id: "message", body: { content: "原文" } } : { value: [] });
    } });
  await assert.rejects(read({ kind: "files", query: "合同" }), /files denied/);
  await read({ kind: "chats" });
  await read({ kind: "channels" });
  await read({ kind: "channels", teamId: "team" });
  await read({ kind: "history", teamId: "team", channelId: "channel", messageId: "message", replies: true });
  await read({ kind: "history", chatId: "chat", messageId: "message" });
  assert.match(requests[0].url, /\/me\/chats/);
  assert.equal(requests[0].auth, "Bearer chat-token");
  assert.match(requests[1].url, /\/me\/teamwork\/associatedTeams/);
  assert.match(requests[2].url, /\/teams\/team\/allChannels/);
  assert.match(requests[3].url, /\/channels\/channel\/messages\/message\/replies/);
  assert.equal(requests[3].auth, "Bearer channel-token");
  assert.match(requests[4].url, /\/chats\/chat\/messages\/message$/);
  const count = requests.length;
  for (const query of [
    { kind: "history" as const }, { kind: "history" as const, chatId: "c", teamId: "t" },
    { kind: "history" as const, chatId: "c", replies: true }, { kind: "history" as const, chatId: ".." },
  ]) await assert.rejects(read(query));
  assert.equal(requests.length, count);
});

test("文件搜索只请求当前委托账号可访问的文件，保留分页和原链接以核对同名文件", async () => {
  let request: RequestInit | undefined;
  const read = createTeamsReader({ getToken: token, getFilesToken: async () => "file-token",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), GRAPH + "/search/query"); request = init;
      return Response.json({ value: [{ hitsContainers: [{ hits: [{ resource: {
        id: "item", name: "合同.docx", parentReference: { driveId: "drive" }, file: {}, webUrl: "https://tenant.sharepoint.com/合同.docx",
      } }], moreResultsAvailable: true }] }] });
    } });
  const result = await read({ kind: "files", query: "合同.docx", offset: 25 });
  assert.equal(request?.method, "POST");
  assert.equal(new Headers(request?.headers).get("authorization"), "Bearer file-token");
  assert.deepEqual(JSON.parse(String(request?.body)).requests[0], { entityTypes: ["driveItem"], query: { queryString: "合同.docx" }, from: 25, size: 25 });
  assert.equal((result.data as { nextOffset: number }).nextOffset, 26);
  assert.match(JSON.stringify(result.data), /drive.*合同\.docx/);
});

test("原文件下载只在 Graph 请求带令牌，跳转下载不带令牌，使用已有附件解析", async () => {
  const requests: { url: string; auth: string | null; redirect: string | undefined }[] = [];
  const read = createTeamsReader({ getToken: token, fetchImpl: async (input, init) => {
    const url = String(input);
    requests.push({ url, auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
    if (url.includes("?$select=")) return Response.json({ id: "item", name: "notes.txt", size: 6, file: { mimeType: "text/plain" }, webUrl: "https://tenant.sharepoint.com/notes.txt" });
    if (url.endsWith("/content")) return new Response(null, { status: 302, headers: { location: "https://tenant.sharepoint.com/download?ticket=private" } });
    return new Response("正文", { headers: { "content-length": "6" } });
  } });
  const result = await read({ kind: "file", driveId: "drive", itemId: "item" });
  assert.equal(result.attachment?.kind, "text");
  assert.equal(result.attachment?.kind === "text" && result.attachment.text, "正文");
  assert.equal(requests[1].auth, "Bearer chat-token");
  assert.equal(requests[2].auth, null);
  assert.equal(requests[1].redirect, "manual");
  assert.equal(requests[2].redirect, "error");
  assert.doesNotMatch(JSON.stringify(result), /private|chat-token/);
});

test("文件拒绝非法下载地址、超大元数据和流式超限；失败不伪装为空文件", async () => {
  for (const location of ["http://tenant.sharepoint.com/file", "https://127.0.0.1/file", "https://tenant.sharepoint.com.evil.example/file", "https://user:pass@tenant.sharepoint.com/file"]) {
    let calls = 0;
    const read = createTeamsReader({ getToken: token, fetchImpl: async () => {
      calls++;
      return calls === 1 ? Response.json({ id: "item", name: "test.txt", size: 1, file: {} })
        : new Response(null, { status: 302, headers: { location } });
    } });
    await assert.rejects(read({ kind: "file", driveId: "drive", itemId: "item" }), /下载地址/);
    assert.equal(calls, 2);
  }
  for (const oversizeMetadata of [true, false]) {
    let calls = 0;
    const read = createTeamsReader({ getToken: token, fetchImpl: async () => {
      calls++;
      if (calls === 1) return Response.json({ id: "item", name: "large.txt", size: oversizeMetadata ? ATTACHMENT_LIMITS.totalBytes + 1 : 1, file: {} });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(ATTACHMENT_LIMITS.totalBytes + 1)); controller.close();
      } }));
    } });
    await assert.rejects(read({ kind: "file", driveId: "drive", itemId: "item" }), /10MB/);
    assert.equal(calls, oversizeMetadata ? 1 : 2);
  }
});

test("权限、限流和无效结果明确失败；停止后不再访问网络", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const read = createTeamsReader({ getToken: token, fetchImpl: async () => new Response("private-error", { status }) });
    await assert.rejects(read({ kind: "chats" }), error => {
      assert.doesNotMatch(String(error), /private-error/); return true;
    });
  }
  const controller = new AbortController();
  controller.abort();
  const read = createTeamsReader({ getToken: async () => { throw new Error("token must not run"); }, signal: controller.signal });
  await assert.rejects(read({ kind: "chats" }), error => {
    assert.doesNotMatch(String(error), /token must not run/); return true;
  });
});

test("Graph 请求入口拒绝其他来源，不携带令牌进行重定向", async () => {
  let calls = 0;
  const graph = createTeamsGraph(async (_input, init) => {
    calls++;
    assert.equal(init?.redirect, "error");
    return Response.json({ value: [] });
  });
  await assert.rejects(graph("test", "https://evil.example/v1.0/me"), /请求地址/);
  await assert.rejects(graph("test", "https://user:test@graph.microsoft.com/v1.0/me"), /请求地址/);
  assert.equal(calls, 0);
  await graph("test", GRAPH + "/me/chats");
  assert.equal(calls, 1);
});
