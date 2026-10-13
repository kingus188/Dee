import { el } from "../ui/elements.js";

export type CardGroup = "tasks" | "memory" | "skills" | "notes";
export type CardAction =
  | { label: string; kind: "request"; path: string }
  | { label: string; kind: "prompt"; text: string }
  | { label: string; kind: "link"; href: string; download?: boolean }
  | { label: string; kind: "refresh" };
export type ConversationCard = {
  key: string;
  group: CardGroup;
  title: string;
  text: string;
  status?: string;
  tone?: "pending" | "done" | "error";
  meta?: string;
  details?: string;
  actions?: CardAction[];
};

export function renderConversationCard(card: ConversationCard, busy: boolean, expanded: boolean) {
  const article = el("article", "", "conversation-card");
  article.dataset.cardKey = card.key;
  article.setAttribute("aria-label", card.title);
  article.setAttribute("aria-busy", String(busy));
  const header = el("header", "", "conversation-card-header");
  header.append(el("h3", card.title));
  if (card.status) header.append(el("span", card.status, "conversation-card-status " + (card.tone || "")));
  article.append(header, el("p", card.text, "conversation-card-text"));
  if (card.meta) article.append(el("p", card.meta, "conversation-card-meta"));
  if (card.details) {
    const details = el("details", "");
    details.open = expanded;
    details.append(el("summary", "查看详情"), el("pre", card.details));
    article.append(details);
  }
  if (card.actions?.length) {
    const actions = el("div", "", "conversation-card-actions");
    card.actions.forEach((action, index) => {
      if (action.kind === "link") {
        const link = el("a", action.label);
        link.href = action.href;
        if (action.download) link.download = "";
        actions.append(link);
      } else {
        const button = el("button", busy ? "处理中…" : action.label);
        button.type = "button";
        button.disabled = busy;
        button.dataset.cardAction = String(index);
        actions.append(button);
      }
    });
    article.append(actions);
  }
  return article;
}
