import type { Management, PersonalData } from "@assistant/contracts";
import type { AppState, AppActions } from "../state.js";
import { request } from "../api/request.js";
import { createConversationCardLayout, emptyCard } from "./layout.js";
import { managementCards } from "./management.js";
import { personalCards } from "../personal/panel.js";
import { noteCards } from "./panels.js";
import { cardGroupsForTurn, visibleCards } from "./context.js";
import { renderConversationCard } from "../chat/cards.js";
import type { CardGroup, ConversationCard } from "../chat/cards.js";

type CardActions = Pick<AppActions, "patchChildren" | "insertExamplePrompt">;
export function createConversationCards(state: AppState, getActions: () => CardActions) {
  let layout: ReturnType<typeof createConversationCardLayout> | undefined;
  let sequence = 0;
  let group: CardGroup | null = null;
  let tasks: ConversationCard[] = [];
  let personal: ConversationCard[] = [];
  let shown: ConversationCard[] = [];
  let taskError = false;
  let personalError = false;
  let loaded = false;
  let lastTool = "";
  let lastUser: number | undefined;
  const pending = new Set<string>();
  const kept = new Set<string>();
  const currentId = () => state.currentConversationId == null ? null : String(state.currentConversationId);

  function render() {
    if (!layout) return;
    const scroll = document.getElementById("messages-container")!;
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    const view = state.currentViewData;
    const notes = view && String(view.conversationId) === currentId() ? noteCards(view.notes) : [];
    shown = visibleCards([...tasks, ...personal, ...notes], group, kept, cardGroupsForTurn(view?.entries ?? []));
    if (group && loaded && !shown.length && !(group === "tasks" ? taskError : group === "memory" || group === "skills" ? personalError : false)) {
      shown.push(emptyCard(group));
    }
    if (group === "notes" && currentId()) shown.push({
      key: "export", group: "notes", title: "保存聊天记录", text: "把你和小 D 的聊天记录下载为 Markdown 文件。",
      actions: [{ label: "导出聊天记录", kind: "link", href: "/api/conversations/" + encodeURIComponent(currentId()!) + "/export.md", download: true }],
    });
    if (taskError || personalError) shown.push({
      key: "load-error", group: "tasks", title: "暂时无法更新卡片",
      text: taskError && personalError ? "任务和个人资料读取失败，请检查连接后重试。" : taskError ? "任务读取失败，请重试。" : "记忆和技能读取失败，请重试。",
      status: "未能读取", tone: "error", actions: [{ label: "重新读取", kind: "refresh" }],
    });
    const expanded = new Set(Array.from(layout.container.querySelectorAll<HTMLElement>("[data-card-key]")).filter(node => node.querySelector("details[open]")).map(node => node.dataset.cardKey));
    const staging = document.createElement("div");
    for (const card of shown) staging.append(renderConversationCard(card, pending.has(card.key), expanded.has(card.key)));
    getActions().patchChildren(layout.container, staging);
    for (const button of layout.toolbar.querySelectorAll<HTMLButtonElement>("button")) button.setAttribute("aria-pressed", String(button.dataset.cardGroup === group));
    if (atBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  async function refreshConversationCards() {
    if (!layout) return;
    const version = ++sequence;
    const owner = currentId();
    const results = await Promise.allSettled([
      owner ? request<Management>("/api/conversations/" + encodeURIComponent(owner) + "/management") : Promise.resolve({ schedules: [], reminders: [], background: [] } as Management),
      request<PersonalData>("/api/personal"),
    ]);
    if (version !== sequence || owner !== currentId()) return;
    const [management, data] = results;
    taskError = management.status === "rejected";
    personalError = data.status === "rejected";
    tasks = management.status === "fulfilled" && owner ? managementCards(management.value, owner) : [];
    personal = data.status === "fulfilled" ? personalCards(data.value) : [];
    loaded = true;
    render();
  }

  function resetConversationCards() {
    sequence++;
    tasks = [];
    personal = [];
    shown = [];
    kept.clear();
    group = null;
    loaded = false;
    taskError = personalError = false;
    lastTool = "";
    lastUser = undefined;
    if (layout) {
      layout.container.replaceChildren();
      document.getElementById("card-feedback")!.textContent = "";
      render();
      void refreshConversationCards();
    }
  }

  function updateConversationCards() {
    const user = state.currentViewData?.entries.findLast(entry => entry.kind === "user")?.id;
    if (user !== lastUser) {
      lastUser = user;
      group = null;
      kept.clear();
    }
    render();
    const tool = state.currentViewData?.entries.findLast(entry => entry.kind === "tool");
    const key = currentId() + ":" + (tool?.id ?? "");
    if (key !== lastTool) {
      if (tool) group = null;
      lastTool = key;
      void refreshConversationCards();
    }
  }

  async function onAction(event: MouseEvent) {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-card-action]");
    if (!button || !layout?.container.contains(button)) return;
    const key = button.closest<HTMLElement>("[data-card-key]")?.dataset.cardKey;
    const card = shown.find(item => item.key === key);
    const action = card?.actions?.[Number(button.dataset.cardAction)];
    if (!card || !action || pending.has(card.key)) return;
    if (action.kind === "prompt") { getActions().insertExamplePrompt(action.text); return; }
    if (action.kind === "refresh") { await refreshConversationCards(); return; }
    if (action.kind !== "request") return;
    const owner = currentId();
    pending.add(card.key);
    kept.add(card.key);
    const feedback = document.getElementById("card-feedback")!;
    feedback.textContent = "正在处理…";
    render();
    try {
      await request(action.path, {});
      if (owner === currentId()) {
        feedback.textContent = "操作已完成。";
        await refreshConversationCards();
      }
    } catch {
      if (owner === currentId()) feedback.textContent = "操作未能确认，卡片会自动刷新。请核对最新状态后再操作。";
    } finally {
      pending.delete(card.key);
      render();
    }
  }

  function initializeConversationCards() {
    layout = createConversationCardLayout();
    layout.container.addEventListener("click", onAction);
    layout.toolbar.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button[data-card-group]");
      if (!button) return;
      group = group === button.dataset.cardGroup ? null : button.dataset.cardGroup as CardGroup;
      render();
      if (group) layout!.container.scrollIntoView({ block: "start" });
      void refreshConversationCards();
    });
    window.setInterval(() => { if (!document.hidden) void refreshConversationCards(); }, 5000);
  }
  return { initializeConversationCards, resetConversationCards, updateConversationCards };
}
