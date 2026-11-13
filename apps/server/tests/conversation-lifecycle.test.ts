import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModelCatalog, openRuntime } from "@assistant/runtime";
import { createApi } from "../dist/application/api.js";
import type { AppContext } from "../dist/application/context.js";

test("conversation lifecycle management works without configured model and still blocks generation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "conversation-no-model-"));
  const catalog = await createModelCatalog({ api: "openai-completions", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [], onReport: () => {} }, ctx);
  const api = createApi({ ...runtime, ctx, config: { password: "" }, modelConfigured: false, episodeStore: { revokeSource() {} } } as unknown as AppContext);
  const call = (path: string, body: Record<string, unknown> = {}) => api.dispatch("POST", new URL(path, "http://localhost"), body);
  try {
    const { id } = (await call("/api/conversations/direct")).data as { id: number };
    assert.equal(((await call(`/api/conversations/${id}/status`, { status: "completed" })).data as { status: string }).status, "completed");
    assert.ok(((await call(`/api/conversations/${id}/archive`)).data as { archivedAt: string }).archivedAt);
    assert.equal(((await call(`/api/conversations/${id}/restore`)).data as { archivedAt: null }).archivedAt, null);
    await assert.rejects(call(`/api/conversations/${id}/messages`, { text: "requires model" }), /配置模型/);
    assert.equal(((await call(`/api/conversations/${id}/remove`)).data as { removed: boolean }).removed, true);
  } finally { await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});
