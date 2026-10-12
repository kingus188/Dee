import { $ } from "../ui/elements.js";
import { showToast } from "../ui/toast.js";
import { createTaskCenterLayout } from "./layout.js";
import { createManagementPanel } from "./management.js";
import { createPersonalPanel } from "../personal/panel.js";
import { base, currentId } from "./context.js";

export function initializeTaskCenter() {
 const { toggle, panel } = createTaskCenterLayout();
 let latestRefresh = 0;
 const say = (msg: string) => {
   $("v3-feedback").textContent = msg;
   if (msg.startsWith("操作")) showToast(msg, msg.includes("失败") ? "warning" : "info");
 };
 const isCurrent = (sequence: number, id?: string | null) => sequence === latestRefresh && !panel.hidden && (id === undefined || currentId() === id);
 async function run(action: () => Promise<unknown>) {
   try { say("正在处理…"); await action(); say("操作完成"); await refresh(); }
   catch (e) { say("操作失败：" + (e instanceof Error ? e.message : String(e))); }
 }
 const loadManagement = createManagementPanel({ run, isCurrent, say });
 const loadPersonal = createPersonalPanel({ run, isCurrent, say });
  async function refresh() {
    const sequence = ++latestRefresh;
    const id = currentId();
    $("v3-context").textContent = id ? "当前会话 #" + id : "记忆和技能不依赖当前会话；计划任务需要先选择会话";
    $("v3-schedule-form").querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = !id;
    $("v3-background-form").querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = !id;
    $<HTMLButtonElement>("v3-export").disabled = !id;
    if (panel.hidden) return;
    await Promise.all([loadManagement(sequence, id), loadPersonal(sequence)]);
  }
  function open(state: boolean) {
    panel.hidden = !state;
    toggle.setAttribute("aria-expanded", String(state));
    if (state) refresh();
  }
  toggle.addEventListener("click", () => open(panel.hidden));
  $("v3-close").addEventListener("click", () => open(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) open(false); });
  $("v3-export").addEventListener("click", () => {
    if (!currentId()) return;
    const a = document.createElement("a"); a.href = base() + "/export.md"; a.click();
  });
  $("v3-refresh").addEventListener("click", refresh);
  window.addEventListener("hashchange", refresh);
  window.setInterval(() => { if (!panel.hidden) refresh(); }, 5000);

}
