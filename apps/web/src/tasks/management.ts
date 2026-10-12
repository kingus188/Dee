import type { Management } from "@assistant/contracts";
import { $, el, fmt, addButton } from "../ui/elements.js";
import { request } from "../api/request.js";
import { base } from "./context.js";
import type { TaskPanelContext } from "./context.js";
export function createManagementPanel({ run, isCurrent, say }: TaskPanelContext) {
  async function loadManagement(sequence: number, id: string | null) {
    const schedules = $("v3-schedules");
    const reminders = $("v3-reminders");
    const background = $("v3-background");
    const owner = String(id || "");
    if (schedules._owner !== owner) {
      schedules._owner = reminders._owner = background._owner = owner;
      schedules._lastData = reminders._lastData = background._lastData = "";
    }
    if (!id) {
      schedules.replaceChildren(el("p", "选择会话后才能管理计划任务", "v3-muted"));
      reminders.replaceChildren();
      background.replaceChildren();
      return;
    }
    try {
      const data = await request<Management>("/api/conversations/" + id + "/management");
      if (!isCurrent(sequence, id)) return;
      const schedules = $("v3-schedules");
   const schedStr = JSON.stringify(data.schedules || []);
   if (schedules._lastData !== schedStr) { schedules._lastData = schedStr; schedules.replaceChildren();
      for (const item of data.schedules || []) {
        const row = el("div", "", "v3-row");
        row.append(el("p", item.text), el("span", item.status + " · 已执行 " + item.runs + " 次 · 下次 " + fmt(item.nextAt), "v3-muted"));
        const actions = el("div", "", "v3-actions");
        if (item.status === "active") addButton(actions, "暂停", () => run(() => request(base() + "/schedules/" + item.id + "/pause", {})));
        if (item.status === "paused") addButton(actions, "继续", () => run(() => request(base() + "/schedules/" + item.id + "/resume", {})));
        if (item.status === "active" || item.status === "paused") addButton(actions, "取消", () => run(() => request(base() + "/schedules/" + item.id + "/cancel", {})));
        row.append(actions); schedules.append(row);
      }
      if (!schedules.childElementCount) schedules.append(el("p", "暂无计划任务", "v3-muted")); }

      const reminders = $("v3-reminders");
   const remStr = JSON.stringify(data.reminders || []);
   if (reminders._lastData !== remStr) { reminders._lastData = remStr; reminders.replaceChildren();
      for (const item of data.reminders || []) {
        const row = el("div", "", "v3-row");
        row.append(el("p", item.text), el("span", item.status + " · " + fmt(item.at), "v3-muted"));
        if (item.status === "scheduled") addButton(row, "取消提醒", () => run(() => request(base() + "/reminders/" + item.id + "/cancel", {})));
        reminders.append(row);
      }
      if (!reminders.childElementCount) reminders.append(el("p", "暂无提醒", "v3-muted")); }

      const background = $("v3-background");
   const bgStr = JSON.stringify(data.background || []);
   if (background._lastData !== bgStr) { background._lastData = bgStr; background.replaceChildren();
      for (const item of data.background || []) {
        const row = el("div", "", "v3-row");
        row.append(el("p", item.text), el("span", item.status, "v3-status"));
        if (item.result) row.append(el("p", item.result.slice(0, 350), "v3-muted"));
        const actions = el("div", "", "v3-actions");
        if (item.conversationId) addButton(actions, "查看对话", () => { location.hash = "#" + item.conversationId; });
        if (item.status === "running") addButton(actions, "停止", () => run(() => request(base() + "/background/" + item.id + "/stop", {})));
        row.append(actions); background.append(row);
      }
      if (!background.childElementCount) background.append(el("p", "暂无后台任务", "v3-muted")); }
    } catch (e) {
      if (isCurrent(sequence, id)) say("读取任务失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }
  $("v3-schedule-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const data = Object.fromEntries(new FormData(form));
    run(() => request(base() + "/schedules", {
      ...data, minutesFromNow: Number(data.minutesFromNow),
      everyMinutes: Number(data.everyMinutes), requestId: (typeof crypto!=="undefined"&&crypto.randomUUID?crypto.randomUUID():"req-"+Date.now()+"-"+Math.random().toString(36).slice(2,10)),
    }));
  });
  $("v3-background-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    run(async () => {
      await request(base() + "/background", {
        text: new FormData(form).get("text"), requestId: (typeof crypto!=="undefined"&&crypto.randomUUID?crypto.randomUUID():"req-"+Date.now()+"-"+Math.random().toString(36).slice(2,10)),
      });
      form.reset();
    });
  });

return loadManagement;
}
