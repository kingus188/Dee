import { el } from "../ui/elements.js";
import type { CardGroup, ConversationCard } from "../chat/cards.js";

export function createConversationCardLayout() {
  const toolbar = document.getElementById("conversation-card-tools")!;
  const groups: [CardGroup, string][] = [["tasks", "任务与提醒"], ["memory", "记忆"], ["skills", "技能"], ["notes", "聊天记录"]];
  for (const [group, label] of groups) {
    const button = el("button", label);
    button.type = "button";
    button.dataset.cardGroup = group;
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-controls", "conversation-cards");
    toolbar.append(button);
  }
  return { toolbar, container: document.getElementById("conversation-cards")! };
}

export function emptyCard(group: CardGroup): ConversationCard {
  const examples = {
    tasks: { title: "还没有任务或提醒", text: "告诉我想做什么、什么时候做，我会把安排放在聊天里。", prompt: "10 分钟后提醒我站起来活动一下" },
    memory: { title: "让小 D 更了解你", text: "说说你的偏好，我会先请你确认，再用于以后的对话。", prompt: "请记住：我喜欢简洁、带要点的回答" },
    skills: { title: "把常用方法记成技能", text: "告诉我一套常用步骤，我会整理成卡片，等你批准后再使用。", prompt: "帮我把下面的流程保存为技能，先和我确认名称、使用时机与步骤：" },
    notes: { title: "还没有待办或备忘", text: "可以记一个想法，或和我一起梳理待办。", prompt: "帮我列一个今天的待办清单，先问我有哪些事情要做" },
  }[group];
  return { key: "empty:" + group, group, title: examples.title, text: examples.text,
    actions: [{ label: "试着说一句", kind: "prompt", text: examples.prompt }] };
}
