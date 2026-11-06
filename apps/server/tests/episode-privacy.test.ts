import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEpisodePass } from "../dist/episode-job.js";
import { episodeHasSensitiveData, OMITTED_EPISODE_TEXT, sanitizeEpisodeText } from "../dist/episode-privacy.js";
import { openEpisodeStore } from "../dist/episode-store.js";
import { conversationBatches, episodeSourceAllowed, teamsBatches } from "../dist/episode-sources.js";
import { openTeamsStore } from "../dist/teams-store.js";
import { createSummarizer } from "../dist/episode-model.js";
import { createTeamsEpisodeAccess } from "../dist/teams-episode-access.js";

const at = "2026-10-01T10:00:00.000Z";
const text = "讨论报销进展并确认周五答复。".repeat(80);
const batch = { source: "conv:test", label: "报销安排", channel: "web", text, chars: text.length, periodStart: at, periodEnd: at, cursor: "2", messageIds: ["1", "2"] };
const summary = '{"summary":"报销待审批","openItems":["周五跟进"]}';

async function withStore(run: (store: ReturnType<typeof openEpisodeStore>, directory: string) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), "pi-episode-privacy-"));
  const store = openEpisodeStore(directory);
  try { await run(store, directory); } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

test("本地筛查覆盖常见凭据、验证码及明确的身份/账户标识，正常事实保留", () => {
  for (const value of [
    "password: x", '"refresh_token": "synthetic-test-value"', "api_key=short", "密码：123456",
    "-----BEGIN PRIVATE KEY-----\nsynthetic-test-value\n-----END PRIVATE KEY-----",
    "Bearer synthetic-test-value", "Cookie: session=synthetic-test-value", "验证码是123456",
    "SSN: 123-45-6789", "身份证号：110105199001011234", "银行卡号：4111111111111111",
    "https://name:synthetic-test-value@example.invalid/", "github_pat_synthetic_test_value",
    '{"Cookie":"sessionid=synthetic-cookie"}', '{"Set-Cookie":"sessionid=synthetic-cookie"}',
    '{"message":"\\u9a8c\\u8bc1\\u7801\\uff1a123456"}', '{"\\u0070assword":"synthetic-json-secret"}',
  ]) {
    assert.equal(episodeHasSensitiveData(value), true, value);
    assert.equal(sanitizeEpisodeText(value), OMITTED_EPISODE_TEXT);
  }
  assert.equal(sanitizeEpisodeText("周五确认 1200 元报销，项目编号 20261001。"), "周五确认 1200 元报销，项目编号 20261001。");
});

test("模型调用前拒绝未脱敏原文，脱敏来源标签，错误日志不回显原文或上游响应", () => withStore(async store => {
  const logs: string[] = [], prompts: string[] = [];
  const collect = async () => [
    { ...batch, source: "conv:unsafe", text: `${text} password: synthetic-input-secret` },
    { ...batch, source: "conv:safe", label: "token: synthetic-title-secret" },
    { ...batch, source: "conv:error" },
  ];
  await runEpisodePass({ store, collect, allowSource: () => true, now: () => Date.parse(at) + 86400_000,
    summarize: async prompt => { prompts.push(prompt); if (prompts.length === 2) throw new Error("provider echoed synthetic-error-secret"); return summary; },
    log: message => logs.push(message),
  });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[0].includes(OMITTED_EPISODE_TEXT));
  assert.equal(prompts.join("").includes("synthetic-"), false);
  assert.equal(logs.join("").includes("synthetic-"), false);
  assert.equal(store.cursor("conv:unsafe"), "2", "不重复处理已拒绝的敏感批次");
  assert.equal(store.cursor("conv:error"), undefined, "模型失败可以重试");
  assert.deepEqual(store.all().map(row => row.source), ["conv:safe"]);
  assert.equal(store.all()[0].label, OMITTED_EPISODE_TEXT);
}));

test("来源许可缺失、拒绝、异常或来源未知时均不发送、不推进进度", () => withStore(async store => {
  let calls = 0;
  for (const allowSource of [undefined, () => false, () => { throw new Error("synthetic-private-permission-error"); }]) {
    const logs: string[] = [];
    await runEpisodePass({ store, collect: async () => [batch], summarize: async () => { calls++; return summary; },
      allowSource, now: () => Date.parse(at) + 86400_000, log: message => logs.push(message) });
    assert.equal(logs.join("").includes("synthetic-private"), false);
  }
  await runEpisodePass({ store, collect: async () => [{ ...batch, source: "unknown:test" }, { ...batch, channel: "unknown" }],
    summarize: async () => { calls++; return summary; }, allowSource: () => true, now: () => Date.parse(at) + 86400_000, log: () => {} });
  assert.equal(calls, 0);
  assert.equal(store.cursor(batch.source), undefined);
}));

test("最靠近 provider 的摘要适配器再次拒绝敏感输入", async () => {
  let calls = 0;
  const models = { getModel: () => ({}), completeSimple: async () => { calls++; return { stopReason: "stop", content: [{ type: "text", text: summary }] }; } } as unknown as Parameters<typeof createSummarizer>[0];
  const summarize = createSummarizer(models, { provider: "test", modelId: "test" });
  await assert.rejects(summarize("password: synthetic-direct-secret"), /已阻止发送/);
  assert.equal(calls, 0);
  assert.equal(await summarize("普通摘要输入"), summary);
  assert.equal(calls, 1);
});

test("生成期间来源状态不再许可时不保存结果", () => withStore(async store => {
  let permitted = true;
  await runEpisodePass({ store, collect: async () => [batch], allowSource: () => permitted,
    summarize: async () => { permitted = false; return summary; }, now: () => Date.parse(at) + 86400_000, log: () => {} });
  assert.equal(store.cursor(batch.source), undefined);
  assert.deepEqual(store.all(), []);
}));

test("解码 JSON 后完整字段再次筛查，转义敏感数据和截断边界都不落库", () => withStore(async store => {
  const escaped = "\\u9a8c\\u8bc1\\u7801\\uff1a123456";
  const outputs = [
    `{"summary":"${escaped}","openItems":[]}`,
    `{"summary":"${"x".repeat(795)}${escaped}","openItems":[]}`,
    `{"summary":"正常事项","openItems":["${"x".repeat(115)}${escaped}"]}`,
  ];
  for (const [index, output] of outputs.entries()) {
    const source = `conv:escaped-${index}`;
    await runEpisodePass({ store, collect: async () => [{ ...batch, source }], allowSource: () => true,
      summarize: async () => output, now: () => Date.parse(at) + 86400_000, log: () => {} });
    assert.equal(store.cursor(source), batch.cursor);
  }
  assert.deepEqual(store.all(), []);
}));

test("收集游标改变时不发送陈旧批次，模型执行期间改变时不能回退或重存", () => withStore(async store => {
  store.setCursor(batch.source, "10");
  let calls = 0;
  await runEpisodePass({ store, collect: async () => [{ ...batch, afterCursor: null }], allowSource: () => true,
    summarize: async () => { calls++; return summary; }, now: () => Date.parse(at) + 86400_000, log: () => {} });
  assert.equal(calls, 0);
  await runEpisodePass({ store, collect: async () => [{ ...batch, cursor: "12", afterCursor: "10" }], allowSource: () => true,
    summarize: async () => { store.setCursor(batch.source, "20"); return summary; }, now: () => Date.parse(at) + 86400_000, log: () => {} });
  assert.equal(store.cursor(batch.source), "20");
  assert.deepEqual(store.all(), []);
}));

test("失败来源的远程权限检查也受每轮预算约束", () => withStore(async store => {
  let checks = 0;
  await runEpisodePass({ store, collect: async () => Array.from({ length: 30 }, (_, i) => ({ ...batch, source: `conv:${i}` })),
    allowSource: () => { checks++; return false; }, summarize: async () => assert.fail("拒绝的来源不可发送"), now: () => Date.parse(at) + 86400_000, log: () => {} });
  assert.equal(checks, 10);
}));

test("下轮从最后尝试来源之后继续，失败来源不会永久耗尽预算", () => withStore(async store => {
  const collect = async () => Array.from({ length: 11 }, (_, i) => ({ ...batch, source: `conv:${i}` }));
  const deps = { store, collect, allowSource: (source: string) => source === "conv:10", summarize: async () => summary,
    now: () => Date.parse(at) + 86400_000, log: () => {} };
  const startAfterSource = await runEpisodePass(deps);
  assert.equal(startAfterSource, "conv:9");
  assert.deepEqual(store.all(), []);
  await runEpisodePass({ ...deps, startAfterSource });
  assert.deepEqual(store.all().map(item => item.source), ["conv:10"]);
}));

test("收集后的来源撤回阻止首次发送，生成时撤回阻止摘要及进度写回", () => withStore(async store => {
  const revision = store.sourceRevision(batch.source);
  store.revokeSource(batch.source, "1");
  await runEpisodePass({ store, collect: async () => [{ ...batch, sourceRevision: revision }], allowSource: () => true,
    summarize: async () => assert.fail("已撤回的收集快照不能发送"), now: () => Date.parse(at) + 86400_000, log: () => {} });
  await runEpisodePass({ store, collect: async () => [{ ...batch, messageIds: ["2"], sourceRevision: store.sourceRevision(batch.source) }], allowSource: () => true,
    summarize: async () => { store.revokeSource(batch.source, "2"); return summary; }, now: () => Date.parse(at) + 86400_000, log: () => {} });
  assert.equal(store.cursor(batch.source), undefined);
  assert.deepEqual(store.all(), []);
}));

test("汇总旧摘要也在发送前筛查，模型返回的敏感内容不落库", () => withStore(async store => {
  const old = { source: "teams:legacy", label: "旧记录", channel: "teams", openItems: [] };
  store.add({ ...old, periodStart: "2026-01-05", periodEnd: "2026-01-05", summary: "正常周一内容" });
  store.add({ ...old, periodStart: "2026-01-06", periodEnd: "2026-01-06", summary: "password: synthetic-legacy-secret" });
  let calls = 0;
  await runEpisodePass({ store, collect: async () => [batch], allowSource: () => true, now: () => Date.parse(at) + 86400_000,
    summarize: async () => { calls++; return '{"summary":"验证码：123456","openItems":[]}'; }, log: () => {} });
  assert.equal(calls, 1, "旧敏感摘要未二次外发");
  assert.equal(store.all().filter(row => row.source === batch.source).length, 0);
  assert.equal(store.cursor(batch.source), batch.cursor);
}));

test("Teams 在行截断前筛查正文及作者/标题，并记录消息来源", () => withStore((store, directory) => {
  const teams = openTeamsStore(directory);
  try {
    const now = new Date().toISOString();
    teams.record({ id: "c1:secret", chatId: "c1", chatType: "oneOnOne", senderId: "u1", senderName: "token: synthetic-author-secret", direction: "in",
      text: `${"x".repeat(1495)}sk-synthetic_secret_beyond_line_limit`, createdAt: now, important: false });
    teams.record({ id: "c1:safe", chatId: "c1", chatType: "oneOnOne", senderId: "u1", senderName: "张三", direction: "in", text, createdAt: now, important: false });
    const [result] = teamsBatches(teams, () => undefined, store);
    assert.ok(result.text.includes(OMITTED_EPISODE_TEXT));
    assert.ok(result.text.includes("报销进展"));
    assert.equal(result.text.includes("synthetic"), false);
    assert.equal(result.text.includes("xxx"), false, "整条敏感消息省略，不保留截断后的片段");
    assert.equal(result.label.includes("synthetic"), false);
    assert.deepEqual(result.messageIds, ["c1:secret", "c1:safe"]);
    assert.equal(result.sourceRevision, 0);
  } finally { teams.close(); }
}));

test("Teams 读取快照后被另一连接编辑，旧正文不得标成新版本发送", () => withStore((store, directory) => {
  const teams = openTeamsStore(directory), editor = openTeamsStore(directory);
  try {
    const message = { id: "c1:one", chatId: "c1", chatType: "oneOnOne", senderId: "u1", senderName: "张三", direction: "in" as const,
      text, createdAt: new Date().toISOString(), important: false };
    teams.record(message);
    const source = { ...teams, episodeMessagesSince: (...args: Parameters<typeof teams.episodeMessagesSince>) => {
      const stale = teams.episodeMessagesSince(...args);
      editor.record({ ...message, text: "更新后的正文" });
      return stale;
    } };
    assert.deepEqual(teamsBatches(source, () => undefined, store), []);
    assert.equal(store.sourceRevision("teams:c1"), 1);
  } finally { teams.close(); editor.close(); }
}));

test("Teams 远程读取权限在模型运行时失效，回写前实测拒绝结果", () => withStore(async (store, directory) => {
  const teams = openTeamsStore(directory);
  let denied = false, providerCalls = 0, probes = 0;
  try {
    teams.record({ id: "c1:one", chatId: "c1", chatType: "oneOnOne", senderId: "u1", senderName: "张三", direction: "in", text, createdAt: at, important: false });
    const canReadEpisodeSource = createTeamsEpisodeAccess({ getToken: async () => "synthetic-token", bindAccount: id => teams.archive.bindAccount(id),
      fetchImpl: async input => {
        if (String(input).includes("/me?")) return Response.json({ id: "synthetic-user" });
        probes++;
        return denied ? new Response(null, { status: 403 }) : Response.json({ value: [{ id: "one" }] });
      },
    });
    const app = { ctx: {}, harness: {}, config: { offline: false }, teamsStore: teams, teamsSender: { canReadEpisodeSource } } as unknown as Parameters<typeof episodeSourceAllowed>[0];
    await runEpisodePass({ store, collect: async () => [{ ...batch, source: "teams:c1", channel: "teams", messageIds: ["c1:one"] }],
      allowSource: (source, channel) => episodeSourceAllowed(app, source, channel),
      summarize: async () => { providerCalls++; denied = true; return summary; }, now: () => Date.parse(at) + 86400_000, log: () => {} });
    assert.equal(providerCalls, 1, "首个远程探测成功后才发送");
    assert.equal(probes, 2, "写回前再次探测，没有缓存成功许可");
    assert.deepEqual(store.all(), []);
    assert.equal(store.cursor("teams:c1"), undefined);
  } finally { teams.close(); }
}));

test("会话正文也先筛查再截断；采集期间撤回使快照不可用", () => withStore(async store => {
  const fake = { episodeStore: store, ctx: {}, harness: {
    snapshot: async () => ({ items: [{ id: 1, title: "password: synthetic-label-secret", channel: "web" }] }),
    conversation: async () => ({ entries: async () => ({ items: [
      { id: 1, kind: "pi.user", model: [{ content: `${"x".repeat(1495)}sk-synthetic_secret_beyond_line_limit`, timestamp: Date.parse(at) }] },
      { id: 2, kind: "pi.assistant", model: [{ content: [{ type: "text", text }], timestamp: Date.parse(at) }] },
    ] }) }),
  } } as unknown as Parameters<typeof conversationBatches>[0];
  const [result] = await conversationBatches(fake, () => undefined);
  assert.equal(result.label, OMITTED_EPISODE_TEXT);
  assert.ok(result.text.includes(OMITTED_EPISODE_TEXT));
  assert.equal(result.text.includes("xxx"), false);
  assert.deepEqual(result.messageIds, ["1", "2"]);
  store.revokeSource(result.source, "1");
  assert.equal(store.sourceAllowed(result.source, result.sourceRevision, result.messageIds), false);
}));

test("生产来源复核依据当前状态，失联集成、归档和未知来源拒绝", async () => {
  const fake = { ctx: {}, config: { offline: false, wechat: { enabled: true } }, teamsSender: { read: () => {}, canReadEpisodeSource: async () => true },
    teamsStore: { recentInChat: () => [{}] }, harness: { snapshot: async () => ({ items: [
      { id: 1, channel: "web" }, { id: 2, channel: "web", archivedAt: "2026-01-01" }, { id: 3, channel: "wechat" },
    ] }) },
  } as unknown as Parameters<typeof episodeSourceAllowed>[0];
  assert.equal(await episodeSourceAllowed(fake, "conv:1", "web"), true);
  assert.equal(await episodeSourceAllowed(fake, "conv:2", "web"), false);
  assert.equal(await episodeSourceAllowed(fake, "conv:missing", "web"), false);
  assert.equal(await episodeSourceAllowed(fake, "conv:3", "wechat"), true);
  assert.equal(await episodeSourceAllowed({ ...fake, config: { ...fake.config, wechat: { ...fake.config.wechat, enabled: false } } }, "conv:3", "wechat"), false);
  assert.equal(await episodeSourceAllowed(fake, "teams:c1", "teams"), true);
  assert.equal(await episodeSourceAllowed({ ...fake, teamsSender: {} }, "teams:c1", "teams"), false);
  assert.equal(await episodeSourceAllowed({ ...fake, teamsSender: { read: fake.teamsSender.read } }, "teams:c1", "teams"), false);
  assert.equal(await episodeSourceAllowed({ ...fake, teamsSender: { canReadEpisodeSource: async () => false } }, "teams:c1", "teams"), false);
  assert.equal(await episodeSourceAllowed({ ...fake, teamsSender: { canReadEpisodeSource: async () => { throw new Error("synthetic-403"); } } }, "teams:c1", "teams"), false);
  assert.equal(await episodeSourceAllowed({ ...fake, config: { ...fake.config, offline: true } }, "conv:1", "web"), false);
});
