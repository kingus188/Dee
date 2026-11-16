import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTeamsStore } from "../dist/teams-store.js";
import { createTeamsReader } from "../dist/teams-reader.js";
import { teamsDeliveryApi } from "../dist/teams-delivery-api.js";
import { readConfig } from "../dist/config.js";

for (const mode of ["same", "edit", "delete", "forbidden", "malformed"] as const) test(`Graph reader and source ledger recheck ${mode} without confirming or sending`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "teams-graph-evidence-")), store = openTeamsStore(dir);
  try {
    const at = new Date().toISOString();
    store.record({ id: "chat:in", chatId: "chat", chatType: "oneOnOne", senderId: "peer", senderName: "Peer", direction: "in", text: "original [截图]", important: true, notificationPriority: "urgent", createdAt: at });
    const batch = store.notifications.create(false, () => ({ text: "frozen", prompt: "frozen" }))!;
    const epoch = Number(store.notifications.claim(batch.id)); store.notifications.beginExternal(batch.id, epoch); store.notifications.unknown(batch.id, epoch);
    const requests: string[] = [], methods: (string | undefined)[] = [];
    const read = createTeamsReader({ getToken: async () => "synthetic-only", archive: store.archive, fetchImpl: async (input, init) => {
      const url = String(input); requests.push(url); methods.push(init?.method);
      assert.equal(new URL(url).origin, "https://graph.microsoft.com"); assert.equal(init?.method, "GET");
      if (url.includes("/me?")) return Response.json({ id: "me" });
      assert.equal(new URL(url).pathname, "/v1.0/chats/chat/messages/in");
      if (mode === "forbidden") return new Response("PRIVATE_PROVIDER_BODY", { status: 403 });
      if (mode === "malformed") return Response.json({ value: "PRIVATE_PROVIDER_BODY" });
      return Response.json({ id: "in", createdDateTime: at, messageType: "message", from: { user: { id: "peer" } }, body: { contentType: "html", content: `<p>${mode === "edit" ? "changed" : "original"}</p><img src="https://graph.microsoft.com/v1.0/chats/chat/messages/in/hostedContents/image/$value">` }, ...(mode === "delete" ? { deletedDateTime: at } : {}) });
    } });
    const context = { config: readConfig({}), teamsStore: store, teamsSender: { read, send: async () => { assert.fail("must never send"); } } };
    const run = () => teamsDeliveryApi(context, "POST", new URL("http://local/api/teams/delivery-issues/recheck"), { id: batch.id });
    if (mode === "forbidden" || mode === "malformed") await assert.rejects(run(), error => error instanceof Error && /核对未完成/.test(error.message) && !error.message.includes("PRIVATE"));
    else {
      const result = await run();
      assert.equal((result!.data as { sourceCheck: string }).sourceCheck, mode === "same" ? "verified" : "invalidated");
      assert.equal((result!.data as { deliveryCheck: string }).deliveryCheck, "unconfirmed");
      assert.equal(store.notifications.deliveryIssues().items[0].sourceStatus, mode === "same" ? "current" : "invalidated");
      if (mode !== "same") {
        const count = requests.length; await run(); assert.equal(requests.length, count, "invalidated provenance is not fetched again");
        assert.equal(store.message("chat:in"), undefined);
      }
    }
    assert.ok(requests.length > 0);
    assert.ok(methods.every(method => method === "GET"));
    assert.ok(requests.every(url => ["/v1.0/me", "/v1.0/chats/chat/messages/in"].includes(new URL(url).pathname)),
      "source verification must not discover or download hosted media, even if media errors are swallowed");
    if (mode === "same") assert.equal(requests.length, 2, "only exact source and account identity are requested"); assert.equal(store.notifications.deliveryIssues().items[0].state, "unknown");
    assert.equal(store.notifications.claim(batch.id), false);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
