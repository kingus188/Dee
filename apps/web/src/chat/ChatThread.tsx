import { Fragment, memo, useState } from "react";
import type { ConversationView, ViewEntry } from "@assistant/contracts";
import { renderMarkdown } from "./markdown.js";
import { extractLiveInfo } from "./live.js";
import { chatTurns } from "./turns.js";
import { describeModelError } from "./model-errors.js";
import type { ChatTurn } from "./turns.js";
import { activityLabel, toolActivities } from "./activities.js";
import { formatFileSize } from "../ui/format.js";
import { showToast } from "../ui/toast.js";
import { Icon } from "../ui/Icon.js";
import { TeamsMedia } from "./TeamsMedia.js";
import { TeamsRecords, teamsRecords } from "./TeamsRecords.js";
import { chatTimestamp } from "./timestamps.js";
import type { PendingMessage } from "./useMessageDelivery.js";

function MessageTime({ timestamp }: { timestamp?: number }) {
  const value = chatTimestamp(timestamp);
  return value && <time className="message-time" dateTime={value.iso} title={`${value.fullDate} ${value.time}`}>{value.time}</time>;
}

function AssistantIdentity({ timestamp }: { timestamp?: number }) {
  return <div className="assistant-identity"><span className="assistant-avatar" aria-hidden="true"><Icon name="message-circle-more" /></span><strong>Dee</strong><MessageTime timestamp={timestamp} /></div>;
}

export function ResponseCard({ text, streaming = false, timestamp }: { text: string; streaming?: boolean; timestamp?: number }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { showToast("暂时无法复制，请手动选择文字。", "error"); }
  }
  return <div className="assistant-wrapper response-card" data-response-card-variant="response">
    <AssistantIdentity timestamp={streaming ? undefined : timestamp} />
    <div className="assistant-bubble md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
    {streaming ? <span className="cursor-blink" aria-label="正在回复" /> : text && <button type="button" className="response-copy" onClick={() => void copy()} aria-label="复制回复"><Icon name="copy" />{copied ? "已复制" : "复制"}</button>}
  </div>;
}

function UserMessageBubble({ entry, status }: { entry: ViewEntry; status?: string }) {
  if (!entry.text && !entry.attachments?.length) return null;
  if (/^\[(定时提醒|计划任务|后台任务结果)\]/.test(entry.text)) return <div className="message-row reminder-system-row"><div className="reminder-system-card">{entry.text.replace(/^\[(定时提醒|计划任务|后台任务结果)\]\s*/, "")}</div></div>;
  return <div className="message-row user-row">
    {!!entry.attachments?.length && <div className="user-attachments-grid">{entry.attachments.map((file, index) => file.kind === "image" && file.url ?
      <a key={index} href={file.url} target="_blank" rel="noopener noreferrer" className="msg-image-link"><img className="msg-image-thumb" src={file.url} alt={file.name} loading="lazy" /></a> :
      <div key={index} className="msg-file-card"><Icon name="file-text" /><span>{file.name}<small>{formatFileSize(file.size)}</small></span></div>)}</div>}
    {entry.text && <div className="user-bubble"><div className="user-text-body">{entry.text}</div></div>}
    <MessageTime timestamp={entry.timestamp} />
    {status && <span className="message-delivery-status" role="status">{status}</span>}
  </div>;
}

type ErrorActions = { onRetry?: (text: string) => void; onSettings?: () => void };

function TurnCard({ turn, live, busy, onRetry, onSettings }: { turn: ChatTurn; live?: ConversationView["live"]; busy: boolean } & ErrorActions) {
  const info = extractLiveInfo(live);
  const activities = toolActivities(turn.entries, info?.runningTools ?? [], busy);
  const records = teamsRecords(activities);
  const responses = turn.entries.filter(entry => entry.kind === "assistant" && entry.text && !entry.error);
  const intermediate = responses.slice(0, -1);
  const errorIndex = turn.entries.findLastIndex(entry => !!entry.error);
  const failed = errorIndex < 0 ? undefined : turn.entries[errorIndex];
  const recovered = turn.entries.slice(errorIndex + 1).some(entry => entry.kind === "assistant" && entry.text && !entry.error);
  const failure = !busy && !info?.text && !recovered ? failed : undefined;
  const previousErrors = turn.entries.filter(entry => entry.error && entry !== failure);
  const notice = failure?.error ? describeModelError(failure.error) : undefined;
  const hasError = !!failure || turn.entries.some(entry => entry.isError);
  return <section className="chat-turn" data-turn-id={turn.id}>
    <UserMessageBubble entry={turn.user} />
    {records.length ? <TeamsRecords records={records} /> : <TeamsMedia activities={activities} />}
    {(activities.length > 0 || !!intermediate.length || !!previousErrors.length || !!info?.thinking) && <details className="turn-activities">
      <summary><Icon name="chevron-right" /><span className="activity-count">{activities.length + previousErrors.length}</span><span>{busy ? "正在处理" : hasError ? "有步骤未完成" : "处理过程"}</span></summary>
      <div className="turn-activity-list">{activities.map(activity => <div className="turn-activity" key={activity.id}>
        <span className={`activity-status activity-${activity.status}`} aria-label={{ pending: "等待执行", completed: "已完成", error: "未完成", interrupted: "已停止", ended: "已结束，结果未确认", running: "正在执行" }[activity.status]}>{activity.status === "completed" ? <Icon name="check" /> : activity.status === "error" ? <Icon name="circle-alert" /> : activity.status === "interrupted" ? <Icon name="square" /> : activity.status === "ended" ? <Icon name="circle-help" /> : activity.status === "pending" ? <Icon name="clock-3" /> : <span className="activity-spinner" />}</span>
        <details><summary>{activityLabel(activity.name)}</summary><pre>{activity.text || (activity.status === "interrupted" ? "步骤已停止，尚无完成结果。" : activity.status === "ended" ? "步骤已结束，暂未收到结果。" : "等待执行结果。")}</pre></details>
      </div>)}</div>
      {intermediate.map(entry => <div className="turn-intermediate md" key={entry.id} dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text) }} />)}
      {previousErrors.map(entry => <details className="model-error-details" key={entry.id}><summary>{describeModelError(entry.error!).title}</summary><pre>{entry.error}</pre></details>)}
      {info?.thinking && <pre className="turn-thinking">{info.thinking}</pre>}
    </details>}
    {notice && failure && <div className="error-system-card model-error-notice" role="alert">
      <Icon name="circle-alert" />
      <div className="model-error-content"><p className="model-error-title">{notice.title}</p><p className="model-error-description">{notice.description}</p>
        <div className="model-error-actions">
          {!notice.settings && onRetry && turn.user.text && <button type="button" className="text-button" onClick={() => onRetry(turn.user.text)}><Icon name="rotate-ccw" />编辑后重试</button>}
          {notice.settings && onSettings && <button type="button" className="text-button" onClick={onSettings}><Icon name="settings" />查看服务器模型</button>}
        </div>
        <details className="model-error-details"><summary>查看错误详情</summary><pre>{failure.error}</pre></details>
      </div>
    </div>}
    {!!responses.length && (records.length ? <details className="teams-records-summary"><summary>助手说明</summary><ResponseCard text={responses.at(-1)!.text} timestamp={responses.at(-1)!.timestamp} /></details>
      : <div className="message-row assistant-row"><ResponseCard text={responses.at(-1)!.text} timestamp={responses.at(-1)!.timestamp} /></div>)}
    {info?.text && <div className="message-row assistant-row"><ResponseCard text={info.text} streaming /></div>}
    {busy && !info?.text && <div className="message-row assistant-row"><div className="assistant-wrapper response-card"><AssistantIdentity /><p className="turn-thinking turn-loading" role="status"><span className="activity-spinner" aria-hidden="true" />{info?.runningTools.length ? "正在执行…" : "思考中…"}</p></div></div>}
  </section>;
}

export const ChatThread = memo(function ChatThread({ view, pendingMessages = [], onRetry, onSettings }: { view: ConversationView | null; pendingMessages?: PendingMessage[] } & ErrorActions) {
  const turns = chatTurns(view?.entries ?? []);
  const busy = !!view?.busy || !!view?.inbox || !!Object.keys(view?.live ?? {}).length;
  if (!turns.length && !pendingMessages.length) return busy ? <div className="message-row assistant-row"><ResponseCard text="思考中…" streaming /></div> : <div className="chat-welcome"><Icon name="message-circle-more" /><h1>有什么想交给我？</h1><p>我可以帮你思考、整理、规划和执行日常事务。</p></div>;
  let previousDay: string | undefined;
  return <>{turns.map((turn, index) => {
    const timestamp = chatTimestamp(turn.user.timestamp ?? turn.entries.find(entry => entry.timestamp !== undefined)?.timestamp);
    const showDay = timestamp && timestamp.day !== previousDay;
    if (timestamp) previousDay = timestamp.day;
    return <Fragment key={turn.id}>
      {showDay && <div className="chat-day-separator"><time dateTime={timestamp.day} title={timestamp.fullDate}>{timestamp.dayLabel}</time></div>}
      <TurnCard turn={turn} live={index === turns.length - 1 ? view?.live : undefined} busy={index === turns.length - 1 && busy} onRetry={index === turns.length - 1 ? onRetry : undefined} onSettings={onSettings} />
    </Fragment>;
  })}
    {pendingMessages.map(message => <section className="chat-turn" key={message.requestId}><UserMessageBubble entry={{ id: -1, kind: "user", text: message.text, attachments: message.attachments }} status={{ sending: "正在发送…", waiting: "已发送，等待处理", unconfirmed: "发送未确认，可在输入框重试", stopped: "已停止处理" }[message.status]} /></section>)}
  </>;
});
