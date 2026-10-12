import type { PersonalData } from "@assistant/contracts";
import { $, el, fillEmpty, addButton } from "../ui/elements.js";
import type { CachedElement } from "../ui/elements.js";
import { request } from "../api/request.js";
import type { TaskPanelContext } from "../tasks/context.js";
export function createPersonalPanel({ run, isCurrent, say }: TaskPanelContext) {
  const statusText = { approved: "已生效", pending: "待批准", rejected: "已撤回" };
  function renderDecisionList(node: CachedElement, items: (PersonalData["memory"][number] | PersonalData["skills"][number])[], kind: "memory" | "skills", emptyText: string) {
    const opened = new Set([...node.querySelectorAll<HTMLDetailsElement>("details[open]")].map((node) => node.dataset.id));
    const dataStr = JSON.stringify(items);
    if (node._lastData === dataStr) return;
    node._lastData = dataStr;
    node.replaceChildren();
    for (const item of items.filter((entry) => entry.status !== "rejected")) {
      const row = el("div", "", "v3-row");
      row.append(el("p", "text" in item ? item.text : item.name + "：" + item.description));
      row.append(el("span", (statusText[item.status] || item.status) + " · " + (item.source === "user" ? "你写下的" : "助手提交"), "v3-muted"));
      if ("body" in item) {
        const details = document.createElement("details");
        details.dataset.id = String(item.id);
        details.open = opened.has(String(item.id));
        const summary = document.createElement("summary");
        summary.textContent = "查看步骤";
        const body = document.createElement("pre");
        body.textContent = item.body;
        details.append(summary, body);
        row.append(details);
      }
      const actions = el("div", "", "v3-actions");
      if (item.status === "pending") addButton(actions, "批准", () => run(() => request("/api/personal/" + kind + "/" + item.id + "/approve", {})));
      if (item.status === "pending" || item.status === "approved") {
        addButton(actions, item.status === "approved" ? "撤回" : "驳回", () => run(() => request("/api/personal/" + kind + "/" + item.id + "/reject", {})));
      }
      row.append(actions);
      node.append(row);
    }
    fillEmpty(node, emptyText);
  }
  async function loadPersonal(sequence: number) {
    try {
      const data = await request<PersonalData>("/api/personal");
      if (!isCurrent(sequence)) return;
      const knowledge: Partial<PersonalData["knowledge"]> = data.knowledge || {};
      $("v3-knowledge").textContent = knowledge.enabled
        ? "知识库只读：" + (knowledge.allow || []).join("、")
        : "知识库未启用：" + (knowledge.reason || "未配置");
      renderDecisionList($("v3-memory"), data.memory || [], "memory", "还没有跨会话记忆");
      renderDecisionList($("v3-skills"), data.skills || [], "skills", "还没有技能");
    } catch (e) {
      if (isCurrent(sequence)) say("读取记忆和技能失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }
  $("v3-memory-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    run(async () => {
      await request("/api/personal/memory", { text: new FormData(form).get("text"), requestId: (typeof crypto!=="undefined"&&crypto.randomUUID?crypto.randomUUID():"req-"+Date.now()+"-"+Math.random().toString(36).slice(2,10)) });
      form.reset();
    });
  });
  $("v3-skill-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const data = Object.fromEntries(new FormData(form));
    run(async () => {
      await request("/api/personal/skills", { ...data, requestId: (typeof crypto!=="undefined"&&crypto.randomUUID?crypto.randomUUID():"req-"+Date.now()+"-"+Math.random().toString(36).slice(2,10)) });
      form.reset();
    });
  });

return loadPersonal;
}
