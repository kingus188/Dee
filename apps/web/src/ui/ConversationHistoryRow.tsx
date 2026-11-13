import type { MouseEventHandler } from "react";
import { Icon } from "./Icon.js";
import { historyTime } from "./history-groups.js";

export function ConversationHistoryRow({ href, title, source, detail, createdAt, current, status, hint, onClick }: {
  href: string; title: string; source: string; detail: string; createdAt?: string;
  current?: boolean; status?: "running" | "waiting" | "done" | "failed" | "cancelled" | "interrupted";
  hint?: string;
  onClick: MouseEventHandler<HTMLAnchorElement>;
}) {
  const state = status && {
    running: { icon: "loader-circle", label: "Running" }, waiting: { icon: "circle-pause", label: "Awaiting confirmation" }, done: { icon: "circle-check", label: "Completed" },
    failed: { icon: "circle-alert", label: "Failed" }, cancelled: { icon: "circle-slash", label: "Cancelled" }, interrupted: { icon: "circle-pause", label: "Interrupted" },
  }[status];
  return <a className="history-row" href={href} title={`${title}\n${source} · ${detail}${hint ? `\n${hint}` : ""}`} aria-current={current ? "true" : undefined} onClick={onClick}>
    <span className="history-row-meta"><span className="history-row-source"><span className="history-row-avatar" aria-hidden="true">D</span><span className="history-channel">{source}</span></span>
      {state ? <span className="history-row-status" data-status={status}><Icon name={state.icon} />{state.label}</span> : createdAt && <time dateTime={createdAt}>{historyTime(createdAt)}</time>}
    </span>
    <span className="history-row-title">{title}</span>
    <span className="history-row-detail">{detail}</span>
  </a>;
}
