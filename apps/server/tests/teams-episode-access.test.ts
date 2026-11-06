import assert from "node:assert/strict";
import test from "node:test";
import { createTeamsEpisodeAccess } from "../dist/teams-episode-access.js";

test("探测现有账号及最多一条消息，丢弃正文，每次重新验证且不缓存成功权限", async () => {
  let denied = false;
  const requests: string[] = [], owners: string[] = [];
  const allowed = createTeamsEpisodeAccess({ getToken: async () => "synthetic-token", bindAccount: id => { owners.push(id); },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input)); requests.push(url.href);
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(url.origin, "https://graph.microsoft.com");
      if (url.pathname.endsWith("/me")) { assert.equal(url.searchParams.get("$select"), "id"); return Response.json({ id: "synthetic-user" }); }
      assert.equal(url.pathname, "/v1.0/chats/chat%3Aone/messages");
      assert.equal(url.searchParams.get("$top"), "1");
      assert.equal(url.searchParams.has("$select"), false, "Graph 消息列表不支持 $select");
      return denied ? new Response(null, { status: 403 }) : Response.json({ value: [{ id: "synthetic-message", body: { content: "synthetic-private-content-not-for-model" } }] });
    },
  });
  assert.equal(await allowed("chat:one"), true);
  denied = true;
  assert.equal(await allowed("chat:one"), false);
  assert.equal(requests.length, 4);
  assert.deepEqual(owners, ["synthetic-user", "synthetic-user"]);
});

test("权限拒绝、缺失来源、无效响应和网络失败全部拒绝，不降级为缓存许可", async () => {
  for (const status of [401, 403, 404, 500, "invalid", "network"] as const) {
    const allowed = createTeamsEpisodeAccess({ getToken: async () => "synthetic-token", bindAccount: () => {},
      fetchImpl: async input => {
        if (String(input).includes("/me?")) return Response.json({ id: "synthetic-user" });
        if (status === "network") throw new Error("synthetic-network-error");
        if (status === "invalid") return Response.json({ wrong: "not a message page" });
        return new Response(null, { status });
      },
    });
    assert.equal(await allowed("c1"), false, String(status));
  }
  const wrongAccount = createTeamsEpisodeAccess({ getToken: async () => "synthetic-token", bindAccount: () => { throw new Error("different account"); }, fetchImpl: async () => Response.json({ id: "other-user" }) });
  assert.equal(await wrongAccount("c1"), false);
});

test("429 遵守 Retry-After，冷却期间所有聊天不再请求，之后可重新检查", async () => {
  let now = Date.parse("2026-10-01T00:00:00Z"), requests = 0, limited = true;
  const allowed = createTeamsEpisodeAccess({ getToken: async () => "synthetic-token", bindAccount: () => {}, now: () => now,
    fetchImpl: async input => {
      requests++;
      if (String(input).includes("/me?")) return Response.json({ id: "synthetic-user" });
      return limited ? new Response(null, { status: 429, headers: { "Retry-After": "120" } }) : Response.json({ value: [] });
    },
  });
  assert.equal(await allowed("c1"), false);
  assert.equal(requests, 2);
  now += 119_000;
  assert.equal(await allowed("c2"), false);
  assert.equal(requests, 2);
  now += 1_000; limited = false;
  assert.equal(await allowed("c2"), true);
  assert.equal(requests, 4);
});

test("无效目标、已停止集成不访问网络；并发相同目标只探测一次", async () => {
  const controller = new AbortController();
  let requests = 0;
  const allowed = createTeamsEpisodeAccess({ getToken: async () => "synthetic-token", bindAccount: () => {}, signal: controller.signal,
    fetchImpl: async input => { requests++; return Response.json(String(input).includes("/me?") ? { id: "synthetic-user" } : { value: [] }); },
  });
  for (const id of ["", ".", "..", "bad\nvalue"]) assert.equal(await allowed(id), false);
  assert.equal(requests, 0);
  assert.deepEqual(await Promise.all([allowed("c1"), allowed("c1")]), [true, true]);
  assert.equal(requests, 2);
  controller.abort();
  assert.equal(await allowed("c2"), false);
  assert.equal(requests, 2);
});
