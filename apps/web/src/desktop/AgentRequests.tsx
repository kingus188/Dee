import { useRef, useState } from "react";
import type { AgentApproval, AgentApprovalAnswer, AgentActivity } from "@assistant/contracts";

function Request({ request, answer }: { request: AgentApproval; answer(input: AgentApprovalAnswer): Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}), [pending, setPending] = useState(false), [error, setError] = useState("");
  const locked = useRef(false);
  async function respond(allow: boolean) {
    if (locked.current) return;
    locked.current = true; setPending(true); setError("");
    try { await answer({ id: request.id, allow, ...(request.questions ? { answers } : {}) }); }
    catch { setError("请求已过期或响应未确认，请刷新后核对。"); locked.current = false; setPending(false); }
  }
  return <form className="desktop-agent-request" aria-label={request.title} onSubmit={event => { event.preventDefault(); void respond(true); }}>
    <strong>{request.title}</strong>
    {request.detail && <details><summary>查看操作</summary><pre>{request.detail}</pre></details>}
    {request.questions?.map(question => <label key={question.id}>{question.text}
      {question.options?.length ? <select required disabled={pending} aria-label={question.text} value={answers[question.id] ?? ""} onChange={event => setAnswers({ ...answers, [question.id]: event.target.value })}><option value="">请选择</option>{question.options.map(option => <option key={option} value={option}>{option}</option>)}</select>
        : <input required disabled={pending} type={question.secret ? "password" : "text"} aria-label={question.text} value={answers[question.id] ?? ""} autoComplete="off" maxLength={16000} onChange={event => setAnswers({ ...answers, [question.id]: event.target.value })} />}
    </label>)}
    {error && <p role="alert">{error}</p>}
    <div className="desktop-agent-job-actions"><button className="header-button" type="submit" disabled={pending}>{request.questions ? "提交回答" : "允许本次"}</button><button className="header-button" type="button" disabled={pending} onClick={() => void respond(false)}>{request.questions ? "取消" : "拒绝"}</button></div>
  </form>;
}
export function AgentRequests({ approvals, activities, answer }: { approvals: AgentApproval[]; activities: AgentActivity[]; answer(input: AgentApprovalAnswer): Promise<void> }) {
  return <div className="desktop-agent-progress">
    {activities.length > 0 && <details className="desktop-agent-activities"><summary>执行过程 · {activities.length}</summary>{activities.map(activity => <div key={activity.id} className="desktop-agent-activity"><span>{activity.title}</span><span>{activity.status === "running" ? "执行中" : activity.status === "done" ? "已完成" : "未完成"}</span>{activity.detail && <pre>{activity.detail}</pre>}</div>)}</details>}
    {approvals.map(request => <Request key={request.id} request={request} answer={answer} />)}
  </div>;
}
