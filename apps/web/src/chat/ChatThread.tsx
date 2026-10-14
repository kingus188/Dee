import { memo, useState } from "react";
import type { ConversationView, ViewEntry } from "@assistant/contracts";
import { renderMarkdown } from "./markdown.js";
import { extractLiveInfo } from "./live.js";
import { chatTurns } from "./turns.js";
import type { ChatTurn } from "./turns.js";
import { activityLabel, toolActivities } from "./activities.js";
import { formatFileSize } from "../ui/format.js";
import { showToast } from "../ui/toast.js";
import { Icon } from "../ui/Icon.js";

export function ResponseCard({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { showToast("暂时无法复制，请手动选择文字。", "error"); }
  }
  return <div className="assistant-wrapper response-card" data-response-card-variant="response">
    <div className="assistant-bubble md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
    {streaming ? <span className="cursor-blink" aria-label="正在回复" /> : text && <button type="button" className="response-copy" onClick={() => void copy()} aria-label="复制回复"><Icon name="copy" />{copied ? "已复制" : "复制"}</button>}
  </div>;
}

function UserMessageBubble({ entry }: { entry: ViewEntry }) {
  if (!entry.text && !entry.attachments?.length) return null;
  if (/^\[(定时提醒|计划任务|后台任务结果)\]/.test(entry.text)) return <div className="message-row reminder-system-row"><div className="reminder-system-card">{entry.text.replace(/^\[(定时提醒|计划任务|后台任务结果)\]\s*/, "")}</div></div>;
  return <div className="message-row user-row">
    {!!entry.attachments?.length && <div className="user-attachments-grid">{entry.attachments.map((file, index) => file.kind === "image" && file.url ?
      <a key={index} href={file.url} target="_blank" rel="noopener noreferrer" className="msg-image-link"><img className="msg-image-thumb" src={file.url} alt={file.name} loading="lazy" /></a> :
      <div key={index} className="msg-file-card"><Icon name="file-text" /><span>{file.name}<small>{formatFileSize(file.size)}</small></span></div>)}</div>}
    {entry.text && <div className="user-bubble"><div className="user-text-body">{entry.text}</div></div>}
  </div>;
}

function TurnCard({ turn, live, busy }: { turn: ChatTurn; live?: ConversationView["live"]; busy: boolean }) {
  const info = extractLiveInfo(live);
  const activities = toolActivities(turn.entries, info?.runningTools ?? [], busy);
  const responses = turn.entries.filter(entry => entry.kind === "assistant" && entry.text && !entry.error);
  const intermediate = responses.slice(0, -1);
  const hasError = turn.entries.some(entry => entry.error || entry.isError);
  return <section className="chat-turn" data-turn-id={turn.id}>
    <UserMessageBubble entry={turn.user} />
    {(activities.length > 0 || !!intermediate.length || !!info?.thinking) && <details className="turn-activities">
      <summary><Icon name="chevron-right" /><span className="activity-count">{activities.length}</span><span>{busy ? "正在处理" : hasError ? "有步骤未完成" : "处理过程"}</span></summary>
      <div className="turn-activity-list">{activities.map(activity => <div className="turn-activity" key={activity.id}>
        <span className={`activity-status activity-${activity.status}`} aria-label={{ pending: "等待执行", completed: "已完成", error: "未完成", interrupted: "已停止", ended: "已结束，结果未确认", running: "正在执行" }[activity.status]}>{activity.status === "completed" ? <Icon name="check" /> : activity.status === "error" ? <Icon name="circle-alert" /> : activity.status === "interrupted" ? <Icon name="square" /> : activity.status === "ended" ? <Icon name="circle-help" /> : activity.status === "pending" ? <Icon name="clock-3" /> : <span className="activity-spinner" />}</span>
        <details><summary>{activityLabel(activity.name)}</summary><pre>{activity.text || (activity.status === "interrupted" ? "步骤已停止，尚无完成结果。" : activity.status === "ended" ? "步骤已结束，暂未收到结果。" : "等待执行结果。")}</pre></details>
      </div>)}</div>
      {intermediate.map(entry => <div className="turn-intermediate md" key={entry.id} dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text) }} />)}
      {info?.thinking && <pre className="turn-thinking">{info.thinking}</pre>}
    </details>}
    {turn.entries.filter(entry => entry.error).map(entry => <div key={entry.id} className="error-system-card" role="alert"><p>模型调用失败：{entry.error}</p><small>可以稍后重发，或检查模型服务。</small></div>)}
    {!!responses.length && <div className="message-row assistant-row"><ResponseCard text={responses.at(-1)!.text} /></div>}
    {info?.text && <div className="message-row assistant-row"><ResponseCard text={info.text} streaming /></div>}
    {busy && !info?.text && <p className="turn-thinking turn-loading" role="status"><span className="activity-spinner" aria-hidden="true" />{info?.runningTools.length ? "正在执行…" : "思考中…"}</p>}
  </section>;
}

export const ChatThread = memo(function ChatThread({ view }: { view: ConversationView | null }) {
  const turns = chatTurns(view?.entries ?? []);
  const busy = !!view?.busy || !!Object.keys(view?.live ?? {}).length;
  if (!turns.length) return <div className="message-row assistant-row"><ResponseCard text={busy ? "思考中…" : "我在。今天想聊点什么？"} streaming={busy} /></div>;
  return <>{turns.map((turn, index) => <TurnCard key={turn.id} turn={turn} live={index === turns.length - 1 ? view?.live : undefined} busy={index === turns.length - 1 && busy} />)}</>;
});
