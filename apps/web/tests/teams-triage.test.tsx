import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { TeamsSyncSettings, TeamsTriageItem, TeamsTriageOverview } from "@assistant/contracts";
import { TeamsTriage } from "../dist/teams/TeamsTriage.js";
import { TeamsSyncPreferences } from "../dist/teams/TeamsSyncPreferences.js";
import { isTeamsTriageOverview, teamsSourceUrl } from "../dist/teams/data.js";
import { usePageResource } from "../dist/today/usePageResource.js";
import type { PageResource } from "../dist/today/usePageResource.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const settings: TeamsSyncSettings = { enabled: true, timeZone: "Asia/Shanghai", workDays: [1, 2, 3, 4, 5], workStart: "09:00", workEnd: "18:00", workIntervalMinutes: 2, offHoursIntervalMinutes: 15, archiveIntervalMinutes: 30, normalDigestMinutes: 30 };
function item(patch: Partial<TeamsTriageItem> = {}): TeamsTriageItem {
  return { id: "teams/message", revision: 1, chatId: "chat-1", chatLabel: "发布讨论", senderName: "同事甲", createdAt: "2026-11-06T03:00:00Z", text: "请今天核对发布清单。", sourceUrl: "https://teams.microsoft.com/l/message/chat-1/message-1", attention: "now", reason: "消息提到今天的行动，建议优先核对。", uncertainty: "尚未核对完整会话，不能确认是否已经完成。", suggestTodo: true, suggestedTitle: "跟进发布清单", ...patch };
}
function overview(patch: Partial<TeamsTriageOverview> = {}): TeamsTriageOverview {
  return { enabled: true, stale: false, lastSuccessAt: "2026-11-06T03:05:00Z", settings, items: [item()], truncated: false, ...patch };
}
function resource(data: TeamsTriageOverview, patch: Partial<PageResource<TeamsTriageOverview>> = {}): PageResource<TeamsTriageOverview> {
  return { data, loading: false, error: "", updatedAt: 1, refresh: () => {}, ...patch };
}
const noop = () => {};
function button(doc: Document, text: string) {
  const result = [...doc.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes(text));
  assert.ok(result, `Missing button: ${text}`); return result;
}

test("Teams 建议默认折叠，仅展示证据与不确定性，不因读取自动创建或发消息", async t => {
  const requests: string[] = [];
  t.mock.method(apiClient, "request", async (path: string) => { requests.push(path); return {}; });
  const data = overview({ stale: true, truncated: true, items: [item(), item({ id: "later", attention: "later", suggestTodo: false }), item({ id: "unclear", attention: "unclear", suggestTodo: false })] });
  const view = await mount(t, <TeamsTriage active resource={resource(data)} onDaylight={noop} onCreated={noop} />), doc = view.dom.window.document;
  assert.equal(doc.querySelector<HTMLDetailsElement>(".teams-triage")!.open, false);
  assert.match(doc.querySelector(".teams-triage > summary")!.textContent!, /1 条建议优先核对.*缓存/);
  assert.match(doc.querySelector(".teams-triage-content")!.textContent!, /建议优先核对.*待安排处理.*需要你判断/s);
  assert.match(doc.body.textContent!, /仅在你确认后创建待办，不会自动发送 Teams 消息/);
  assert.match(doc.body.textContent!, /创建前会重新核对来源/);
  assert.match(doc.body.textContent!, /建议列表已截断/);
  assert.equal(doc.querySelectorAll(".teams-triage-create").length, 2, "one proposal button and one settings save button");
  assert.equal(doc.querySelectorAll<HTMLButtonElement>(".teams-triage-item .teams-triage-create").length, 1);
  assert.equal(doc.querySelector(".teams-triage-evidence p")!.textContent, data.items[0].text);
  assert.equal(doc.querySelector(".teams-triage-evidence a")!.getAttribute("href"), data.items[0].sourceUrl);
  assert.match(doc.body.textContent!, /不能确认是否已经完成/);
  assert.deepEqual(requests, []);
});

test("确认创建提交来源版本，一次处理中重复点击不会重复提交，完成后可打开真实待办", async t => {
  const requests: { path: string; body: unknown }[] = [], opened: string[] = [];
  let finish!: (value: unknown) => void, refreshes = 0, created = 0;
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => { requests.push({ path, body }); return new Promise(resolve => { finish = resolve; }); });
  const view = await mount(t, <TeamsTriage active resource={resource(overview(), { refresh: () => { refreshes++; } })} onDaylight={id => { if (id) opened.push(id); }} onCreated={() => { created++; }} />), doc = view.dom.window.document;
  await act(async () => { button(doc, "确认创建待办").click(); button(doc, "确认创建待办").click(); });
  assert.deepEqual(requests, [{ path: "/api/teams/triage/act", body: { id: "teams/message", revision: 1, action: "create" } }]);
  assert.equal(button(doc, "正在核对并处理").disabled, true);
  await act(async () => { finish({ ok: true, taskId: "daylight/task-2" }); });
  assert.equal(doc.querySelector(".teams-triage-item"), null, "settled version cannot reappear from an older list response");
  assert.equal(refreshes, 1); assert.equal(created, 1);
  await act(async () => { button(doc, "查看待办").click(); });
  assert.deepEqual(opened, ["daylight/task-2"]);
});

test("暂缓和忽略只提交对应动作，不创建待办，不自行推断新版本的状态", async t => {
  const actions: unknown[] = [];
  t.mock.method(apiClient, "request", async (_path: string, body?: unknown) => { actions.push(body); return { ok: true }; });
  const render = (revision: number) => <TeamsTriage active resource={resource(overview({ items: [item({ revision, suggestTodo: false })] }))} onDaylight={noop} onCreated={() => { assert.fail("must not create a task"); }} />;
  const view = await mount(t, render(1)), doc = view.dom.window.document;
  await act(async () => { button(doc, "稍后再看").click(); });
  assert.match(doc.querySelector('[role="status"]')!.textContent!, /暂缓 2 小时/);
  await view.render(render(2));
  assert.ok(doc.querySelector(".teams-triage-item"));
  await act(async () => { button(doc, "忽略建议").click(); });
  assert.deepEqual(actions, [{ id: "teams/message", revision: 1, action: "snooze" }, { id: "teams/message", revision: 2, action: "dismiss" }]);
});

test("来源撤回或失权失败后刷新列表并移除旧原文，不误报成功", async t => {
  let removed = false, writes = 0;
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/teams/triage") return overview({ items: removed ? [] : [item({ text: "已撤回的敏感正文" })] });
    if (path === "/api/teams/triage/act") { removed = true; writes++; throw new Error("消息已撤回、编辑或无权访问，请重新核对。"); }
    throw new Error(`Unexpected request: ${path}`);
  });
  function Harness({ active }: { active: boolean }) { const data = usePageResource("/api/teams/triage", active, isTeamsTriageOverview); return <TeamsTriage active={active} resource={data} onDaylight={noop} onCreated={() => { assert.fail("no task was created"); }} />; }
  const view = await mount(t, <Harness active={false} />), doc = view.dom.window.document;
  Object.defineProperty(doc, "visibilityState", { configurable: true, value: "visible" });
  await view.render(<Harness active />);
  await act(async () => { button(doc, "确认创建待办").click(); });
  assert.equal(writes, 1);
  assert.match(doc.querySelector('[role="alert"]')!.textContent!, /消息已撤回/);
  assert.doesNotMatch(doc.body.textContent!, /已撤回的敏感正文|待办已创建/);
  assert.equal(doc.querySelector(".teams-triage-item"), null);
});

test("来源读取失败时隐藏缓存原文与动作，停用或失连也不可操作", async t => {
  const requested: string[] = [];
  t.mock.method(apiClient, "request", async (path: string) => { requested.push(path); return {}; });
  const props = { onDaylight: noop, onCreated: noop };
  const view = await mount(t, <TeamsTriage {...props} active resource={resource(overview(), { error: "权限已撤销" })} />), doc = view.dom.window.document;
  assert.match(doc.body.textContent!, /旧建议已隐藏/);
  assert.equal(doc.querySelector(".teams-triage-item"), null);
  await view.render(<TeamsTriage {...props} active={false} resource={resource(overview())} />);
  await act(async () => { button(doc, "确认创建待办").click(); button(doc, "更新来源").click(); });
  await view.render(<TeamsTriage {...props} active resource={resource(overview({ enabled: false }))} />);
  assert.equal(doc.querySelector(".teams-triage-item"), null);
  assert.equal(button(doc, "更新来源").disabled, true);
  assert.deepEqual(requested, []);
});

test("导航离开后的旧动作回包不产生成功提示、导航或覆盖新建议", async t => {
  let finish!: (value: unknown) => void, refreshes = 0;
  t.mock.method(apiClient, "request", async () => new Promise(resolve => { finish = resolve; }));
  const props = { resource: resource(overview(), { refresh: () => { refreshes++; } }), onDaylight: () => assert.fail("must not navigate"), onCreated: () => assert.fail("stale callback") };
  const view = await mount(t, <TeamsTriage {...props} active />), doc = view.dom.window.document;
  await act(async () => { button(doc, "确认创建待办").click(); });
  await view.render(<TeamsTriage {...props} active={false} />);
  await view.render(<TeamsTriage {...props} active />);
  await act(async () => { finish({ ok: true, taskId: "old-task" }); });
  assert.equal(refreshes, 0);
  assert.equal(doc.querySelector(".teams-triage-notice"), null);
  assert.equal(button(doc, "确认创建待办").disabled, false);
});

test("Teams 原文按纯文本显示，未知来源链接不可导航，异常响应不能变成空列表", async t => {
  const text = '<img src=x onerror="alert(1)"><script>external()</script>';
  const data = overview({ items: [item({ text, reason: text, suggestedTitle: text, sourceUrl: "javascript:alert(1)" })] });
  const view = await mount(t, <TeamsTriage active resource={resource(data)} onDaylight={noop} onCreated={noop} />), doc = view.dom.window.document;
  assert.equal(doc.querySelector("img, script, .teams-triage-evidence a"), null);
  assert.equal(doc.querySelector(".teams-triage-evidence p")!.textContent, text);
  assert.equal(teamsSourceUrl("https://teams.microsoft.com.evil.test/message"), undefined);
  assert.equal(teamsSourceUrl("https://user:secret@teams.microsoft.com/l/message/a/b"), undefined);
  assert.equal(teamsSourceUrl("https://teams.cloud.microsoft/l/message/a/b"), "https://teams.cloud.microsoft/l/message/a/b");
  assert.equal(isTeamsTriageOverview(data), true);
  assert.equal(isTeamsTriageOverview({}), false);
  assert.equal(isTeamsTriageOverview(overview({ items: [item({ revision: NaN })] })), false);
  assert.equal(isTeamsTriageOverview(overview({ items: [item({ createdAt: "unknown" })] })), false);
  assert.equal(isTeamsTriageOverview(overview({ settings: { ...settings, workDays: [0] } })), false);
  assert.equal(isTeamsTriageOverview(overview({ settings: { ...settings, workDays: [7] } })), true);
});

test("更新来源是显式操作，重复点击只刷新一次，并重新读取建议", async t => {
  let finish!: (value: unknown) => void, reads = 0;
  const writes: { path: string; body: unknown }[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => { writes.push({ path, body }); return new Promise(resolve => { finish = resolve; }); });
  const view = await mount(t, <TeamsTriage active resource={resource(overview({ settings: { ...settings, enabled: false } }), { refresh: () => { reads++; } })} onDaylight={noop} onCreated={noop} />), doc = view.dom.window.document;
  await act(async () => { button(doc, "更新来源").click(); button(doc, "更新来源").click(); });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { path: "/api/teams/triage/refresh", body: {} });
  await act(async () => { finish(overview()); });
  assert.equal(reads, 1);
  assert.match(doc.body.textContent!, /来源已更新/);
});

test("采集设置只在保存时提交，周日使用 ISO 7，取消不写入", async t => {
  const writes: { path: string; body: unknown }[] = []; let saved = 0;
  t.mock.method(apiClient, "request", async (path: string, body: { settings: TeamsSyncSettings }) => { writes.push({ path, body }); return body.settings; });
  const view = await mount(t, <TeamsSyncPreferences settings={settings} active available onSaved={() => { saved++; }} />), doc = view.dom.window.document;
  const sunday = () => [...doc.querySelectorAll<HTMLLabelElement>(".teams-sync-days label")].find(label => label.textContent === "周日")!.querySelector<HTMLInputElement>("input")!;
  assert.equal(doc.querySelector<HTMLDetailsElement>("details")!.open, false);
  await act(async () => { sunday().click(); });
  assert.deepEqual(writes, []);
  await act(async () => { button(doc, "取消修改").click(); });
  assert.equal(sunday().checked, false);
  await act(async () => { sunday().click(); });
  await act(async () => { doc.querySelector("form")!.dispatchEvent(new view.dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.deepEqual(writes, [{ path: "/api/teams/triage/settings", body: { settings: { ...settings, workDays: [1, 2, 3, 4, 5, 7] } } }]);
  assert.equal(saved, 1);
  assert.equal(sunday().checked, true, "saved response is not overwritten by the previous poll");
  assert.match(doc.querySelector('[role="status"]')!.textContent!, /设置已保存/);
});

test("折叠建议和来源后刷新不会自动展开，也不会写入任何状态", async t => {
  let writes = 0;
  t.mock.method(apiClient, "request", async () => { writes++; return {}; });
  const props = { onDaylight: noop, onCreated: noop, active: true };
  const view = await mount(t, <TeamsTriage {...props} resource={resource(overview())} />), doc = view.dom.window.document;
  const main = doc.querySelector<HTMLDetailsElement>(".teams-triage")!;
  await act(async () => { main.open = true; main.dispatchEvent(new view.dom.window.Event("toggle")); });
  assert.equal(main.open, true);
  const evidence = doc.querySelector<HTMLDetailsElement>(".teams-triage-evidence")!;
  await act(async () => { evidence.open = true; evidence.open = false; main.open = false; main.dispatchEvent(new view.dom.window.Event("toggle")); });
  await view.render(<TeamsTriage {...props} resource={resource(overview({ stale: true }))} />);
  assert.equal(main.open, false);
  assert.equal(doc.querySelector<HTMLDetailsElement>(".teams-triage-evidence")!.open, false);
  assert.equal(writes, 0);
});

test("非法采集间隔在本地阻止保存，不把无效设置提交给服务器", async t => {
  let writes = 0;
  t.mock.method(apiClient, "request", async () => { writes++; return settings; });
  const view = await mount(t, <TeamsSyncPreferences settings={{ ...settings, workIntervalMinutes: 61 }} active available onSaved={noop} />), doc = view.dom.window.document;
  await act(async () => { doc.querySelector("form")!.dispatchEvent(new view.dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.equal(writes, 0);
  assert.match(doc.querySelector('[role="alert"]')!.textContent!, /工作时段采集间隔须为 1–60 分钟的整数/);
});
