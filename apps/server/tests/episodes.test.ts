import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure } from "@earendil-works/pi-durable";
import { openEpisodeStore } from "../dist/episode-store.js";
import { runEpisodePass } from "../dist/episode-job.js";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const base = { source: "teams:c1", label: "Teams 私聊「张三」", channel: "teams" };

async function withStore(run: (store: ReturnType<typeof openEpisodeStore>) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), "pi-episodes-"));
  const store = openEpisodeStore(directory);
  try { await run(store); } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

test("检索按命中数排序，回想会刷新最近使用，待跟进事项可列出", () => withStore(store => {
  store.add({ ...base, periodStart: ago(3), periodEnd: ago(3), summary: "张三提交了报销单，财务审批中", openItems: ["周五前回复张三"] });
  store.add({ ...base, source: "conv:1", label: "新对话", channel: "web", periodStart: ago(2), periodEnd: ago(2), summary: "讨论了周五评审安排", openItems: [] });
  const hits = store.search(["报销", "审批"], 5);
  assert.deepEqual(hits.map(item => item.summary.slice(0, 5)), ["张三提交了"], "两字中文词可命中，未命中的不返回");
  assert.equal(store.search(["不存在"], 5).length, 0);
  assert.deepEqual(store.openItems(30, 5).map(item => item.text), ["周五前回复张三"]);
  assert.equal(store.openItems(1, 5).length, 0, "超过时间窗的待跟进事项不再进入提示");
}));

test("遗忘：久未使用的摘要被删除，带待跟进事项的保留更久，被回想过的不丢", () => withStore(store => {
  for (const [summary, openItems] of [["旧细节", []], ["旧承诺", ["回电话"]], ["旧但被用到", []]] as const) {
    store.add({ ...base, periodStart: ago(120), periodEnd: ago(120), summary, openItems: [...openItems] });
  }
  for (const item of store.all()) store.setLastUsed(item.id, ago(100));
  store.search(["被用到"], 5);
  assert.equal(store.forget(), 1, "只有没被用到、也没有待跟进事项的旧细节被遗忘");
  assert.deepEqual(store.all().map(item => item.summary).sort(), ["旧但被用到", "旧承诺"]);
  for (const item of store.all()) store.setLastUsed(item.id, ago(200));
  assert.equal(store.forget(), 2, "超过 180 天无人问津，带待跟进事项的也遗忘");
}));

test("同一来源同一周的旧摘要合并为周摘要，原摘要被替换", () => withStore(store => {
  store.add({ ...base, periodStart: "2026-01-05T09:00:00.000Z", periodEnd: "2026-01-05T10:00:00.000Z", summary: "周一", openItems: [] });
  store.add({ ...base, periodStart: "2026-01-07T09:00:00.000Z", periodEnd: "2026-01-07T10:00:00.000Z", summary: "周三", openItems: [] });
  store.add({ ...base, periodStart: "2026-01-13T09:00:00.000Z", periodEnd: "2026-01-13T10:00:00.000Z", summary: "下周", openItems: [] });
  const groups = store.rollupGroups("2026-02-01T00:00:00.000Z");
  assert.equal(groups.length, 1, "只有同周两条以上才合并");
  store.replaceWithRollup(groups[0].map(item => item.id), { ...base, periodStart: groups[0][0].periodStart, periodEnd: groups[0][1].periodEnd, summary: "本周合并", openItems: [] });
  assert.deepEqual(store.all().map(item => [item.summary, item.level]), [["本周合并", 1], ["下周", 0]]);
}));

test("整理流程：内容太短或对话未安静时不整理；整理后推进进度；含凭据的摘要丢弃", () => withStore(async store => {
  const logs: string[] = [];
  const long = "报销".repeat(400);
  const batch = (source: string, periodEnd: string, text = long) => ({ source, label: source, channel: "web", text, chars: text.length, periodStart: periodEnd, periodEnd, cursor: `${source}:end` });
  const prompts: string[] = [];
  const summarize = async (prompt: string) => { prompts.push(prompt); return prompt.includes("secret-source") ? `{"summary":"password: hunter2hunter2","openItems":[]}` : `{"summary":"已整理","openItems":["跟进报销"]}`; };
  const collect = async () => [
    batch("conv:short", ago(1), "太短"),
    batch("conv:busy", new Date().toISOString()),
    batch("conv:ok", ago(1)),
    batch("conv:secret-source", ago(1)),
  ];
  await runEpisodePass({ store, collect, summarize, log: message => logs.push(message) });
  assert.equal(prompts.length, 2, "只有安静且足够长的两个来源调用了模型");
  assert.equal(store.cursor("conv:ok"), "conv:ok:end");
  assert.equal(store.cursor("conv:busy"), undefined);
  assert.equal(store.cursor("conv:secret-source"), "conv:secret-source:end", "含凭据的摘要丢弃，但进度前进，避免反复调用");
  assert.deepEqual(store.all().map(item => item.source), ["conv:ok"]);
  assert.match(logs.join("\n"), /secret/);
}));

test("摘要模型失败时不推进进度，下一轮可重试", () => withStore(async store => {
  const text = "报销".repeat(400);
  const collect = async () => [{ source: "conv:x", label: "x", channel: "web", text, chars: text.length, periodStart: ago(1), periodEnd: ago(1), cursor: "end" }];
  const logs: string[] = [];
  await runEpisodePass({ store, collect, summarize: async () => { throw new Error("模型不可用"); }, log: message => logs.push(message) });
  assert.equal(store.cursor("conv:x"), undefined);
  assert.equal(store.all().length, 0);
  assert.match(logs[0], /模型不可用/);
}));

test("真实会话：读取新内容、推进进度、整理成摘要并可回想", async () => {
  const { Index } = await import("@assistant/runtime");
  const { createApplication } = await import("../dist/application/index.js");
  const { readConfig } = await import("../dist/config.js");
  const { conversationBatches } = await import("../dist/episode-sources.js");
  const data = await mkdtemp(join(tmpdir(), "pi-episodes-app-"));
  const app = await createApplication(readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: data, NOTIFY_MODE: "off" }));
  try {
    const id = await app.root.commit(async tx => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, conversation.id, { model: app.agentModel });
      (await tx.doc(Index)).items.push({ id: conversation.id, title: "报销沟通", channel: "web", createdAt: "2026-10-10" });
      return conversation.id;
    }, app.ctx);
    const conversation = await app.harness.conversation(id, app.ctx);
    await (await conversation!.submit({ type: "input", content: "张三的报销单已提交，等财务审批。" + "补充说明".repeat(200) }, app.ctx)).wait(app.ctx);

    const [batch] = await conversationBatches(app, () => undefined);
    assert.equal(batch.source, `conv:${id}`);
    assert.equal(batch.label, "报销沟通");
    assert.match(batch.text, /^用户：张三的报销单已提交/);
    assert.match(batch.text, /\n助手：/);
    assert.deepEqual(await conversationBatches(app, source => (source === batch.source ? batch.cursor : undefined)), [], "进度之后没有新内容");

    // 模拟对话已安静数小时，让整理流程放行。
    await runEpisodePass({ store: app.episodeStore, collect: cursorOf => conversationBatches(app, cursorOf), summarize: async () => '{"summary":"张三报销单已提交，等待财务审批","openItems":["跟进审批"]}', log: message => assert.fail(message), now: () => Date.now() + 3 * 3_600_000 });
    assert.equal(app.episodeStore.search(["报销"], 5).length, 1, "摘要入库并可按关键词回想");
    assert.equal(app.episodeStore.cursor(batch.source), batch.cursor);
  } finally {
    app.taskGraph.dispose();
    await app.harness.close(app.ctx);
    app.modelSettings.close();
    app.episodeStore.close();
    await rm(data, { recursive: true, force: true });
  }
});
