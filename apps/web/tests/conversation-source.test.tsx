import test from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { ConversationHistoryContent } from "../dist/ui/ConversationHistoryContent.js";
import { mount } from "./dom.js";

test("历史侧栏的来源与页面同步并支持往返切换", async t => {
  function Sidebar() {
    const [source, setSource] = useState<"assistant" | "teams">("assistant");
    return <ConversationHistoryContent source={source} onAssistant={() => setSource("assistant")} onTeams={() => setSource("teams")} query="" onQuery={() => {}} onClose={() => {}}>{source}</ConversationHistoryContent>;
  }
  const { dom } = await mount(t, <Sidebar />);
  const select = dom.window.document.querySelector("select")!;
  for (const source of ["teams", "assistant", "teams", "assistant"]) {
    await act(async () => {
      select.value = source;
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(select.value, source);
    assert.equal(dom.window.document.querySelector(".history-list")?.textContent, source);
  }
});
