import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PeerJobs } from "../dist/desktop/PeerJobs.js";
import { mount } from "./dom.js";
import type { useDesktopConversation } from "../src/desktop/useDesktopConversation.js";
import type { DesktopPeerJob } from "@assistant/contracts";

type Local = ReturnType<typeof useDesktopConversation>;
const job: DesktopPeerJob = { id: "job", source: "desktop", target: "server", task: "Inspect build", status: "running", createdAt: "", updatedAt: "", workspace: "/repo", constraints: "Read only", acceptanceCriteria: "Tests pass" };
function local(item: DesktopPeerJob, cancel = async (_id: string) => {}): Local {
  return { snapshot: { nodeId: "desktop", configured: true, jobs: [item] }, bridge: { cancelPeer: cancel }, pending: [], action: async (_id: string, work: () => Promise<void>) => { await work(); return true; } } as unknown as Local;
}
test("peer boundaries show actual target, constraints and separate delivery and review", () => {
  const html = renderToStaticMarkup(<PeerJobs local={local({ ...job, status: "done" })} />);
  assert.match(html, /Runs on<\/dt><dd>server/);
  assert.match(html, /Workspace<\/dt><dd>\/repo/);
  assert.match(html, /Read only/);
  assert.match(html, /Tests pass/);
  assert.match(html, /Execution<\/dt><dd>Succeeded/);
  assert.match(html, /Delivery<\/dt><dd>Pending/);
  assert.match(html, /Review<\/dt><dd>Not recorded/);
  assert.doesNotMatch(html, />Cancel<\/button>/);
});
test("peer cancellation requests exact job and stays pending until confirmation", async t => {
  const calls: string[] = [];
  const { dom, render } = await mount(t, <PeerJobs local={local(job, async id => { calls.push(id); })} />);
  await act(async () => dom.window.document.querySelector("button")!.click());
  assert.deepEqual(calls, [job.id]);
  await render(<PeerJobs local={local({ ...job, cancellation: { requestedAt: "now" } })} />);
  assert.match(dom.window.document.body.textContent!, /Cancellation pending/);
  assert.equal(dom.window.document.querySelector("button")!.disabled, true);
  assert.doesNotMatch(dom.window.document.body.textContent!, /Cancelled/);
});
test("local queued approvals include requested resources before approving", () => {
  const html = renderToStaticMarkup(<PeerJobs local={local({ ...job, source: "server", target: "desktop", status: "queued" })} />);
  assert.match(html, /Waiting for approval/);
  assert.match(html, /Approve Pi/);
  assert.match(html, /Read only/);
  assert.match(html, /Source confirmation unavailable/);
});
