import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { ConversationSearch } from "../dist/ui/ConversationSearch.js";
import { SearchMessage } from "../dist/ui/SearchMessage.js";
import { apiClient } from "../dist/api/socket.js";
import { readWorkspaceRoute, workspaceHash } from "../dist/ui/navigation.js";
import { mount } from "./dom.js";

const hit = (text: string) => ({ conversation: { id: 7, title: "Project", createdAt: "2026-01-01" }, entryId: 2, messageId: "2", role: "user", snippet: text, href: "#chat/7/2" });
const wait = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 280)); });
test("message search ignores stale responses and continues empty bounded pages", async t => {
  const requests: { path: string; resolve: (value: any) => void }[] = [];
  t.mock.method(apiClient, "request", (path: string) => new Promise(resolve => requests.push({ path, resolve })));
  const ui = await mount(t, <ConversationSearch query="old" archived={false} />);
  await wait();
  await ui.render(<ConversationSearch query="new" archived={true} />); await wait();
  assert.match(requests[1].path, /archived=true/);
  await act(async () => { requests[1].resolve({ items: [], nextCursor: "7:8", scanned: 1000 }); });
  await act(async () => { requests[0].resolve({ items: [hit("stale")], nextCursor: null, scanned: 50 }); });
  assert.doesNotMatch(ui.dom.window.document.body.textContent!, /stale/);
  const more = [...ui.dom.window.document.querySelectorAll("button")].find(button => button.textContent === "Continue search")!;
  await act(async () => more.click());
  assert.match(requests[2].path, /cursor=7%3A8/);
  await act(async () => requests[2].resolve({ items: [hit("<script>not HTML</script>")], nextCursor: null, scanned: 50 }));
  assert.equal(ui.dom.window.document.querySelector(".conversation-search-hit")?.getAttribute("href"), "#chat/7/2");
  assert.equal(ui.dom.window.document.querySelector("script"), null);
});

test("original-message route survives roundtrip and reads source independent of current view", async t => {
  assert.equal(workspaceHash(readWorkspaceRoute("#chat/7/2")), "#chat/7/2");
  assert.equal(readWorkspaceRoute("#chat/7/-1").entryId, undefined);
  const paths: string[] = [];
  t.mock.method(apiClient, "request", async (path: string) => { paths.push(path); return { message: { entryId: 2, role: "user", text: "Original archived message", truncated: false } }; });
  const { dom } = await mount(t, <SearchMessage conversationId={7} entryId={2} />);
  assert.match(paths[0], /conversationId=7&entryId=2/);
  assert.match(dom.window.document.body.textContent!, /Original archived message/);
});
