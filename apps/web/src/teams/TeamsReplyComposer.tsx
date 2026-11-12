import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TeamsConversationReply, TeamsConversationReplyResult } from "@assistant/contracts";
import { request } from "../api/request.js";
import { Icon } from "../ui/Icon.js";

function restore(key: string, chatId: string): TeamsConversationReply | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) || "null") as TeamsConversationReply | null;
    return value?.chatId === chatId && typeof value.text === "string" && typeof value.requestId === "string" ? value : null;
  } catch { return null; }
}
function forget(key: string, requestId: string) {
  const saved = window.sessionStorage.getItem(key);
  if (saved && (JSON.parse(saved) as TeamsConversationReply).requestId === requestId) window.sessionStorage.removeItem(key);
}

export function TeamsReplyComposer({ chatId, active, available, readable, onSent }: { chatId: string; active: boolean; available: boolean; readable: boolean; onSent: () => void }) {
  const key = `dee.teams.reply:${chatId}`;
  const [attempt, setAttempt] = useState(() => restore(key, chatId));
  const [draft, setDraft] = useState(attempt?.text ?? "");
  const [state, setState] = useState<TeamsConversationReplyResult["state"] | "idle">(attempt ? "unknown" : "idle");
  const [error, setError] = useState("");
  const busy = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const uncertain = !!attempt && state !== "sending";
  const tooLong = new TextEncoder().encode(draft).length > 16_000;
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!active || busy.current || !available || !readable || (!attempt && (!draft.trim() || tooLong))) return;
    const body: TeamsConversationReply = attempt ?? { chatId, text: draft, requestId: crypto.randomUUID() };
    busy.current = true; setError("");
    try {
      // Persist before sending so reloads and chat switches keep the same request.
      window.sessionStorage.setItem(key, JSON.stringify(body));
    } catch {
      busy.current = false; setError("无法保存本次发送编号，尚未发送，请检查浏览器存储权限。"); return;
    }
    setAttempt(body); setState("sending");
    try {
      const result = await request<TeamsConversationReplyResult>("/api/teams/conversations/reply", body);
      if (!result || result.chatId !== chatId || result.requestId !== body.requestId || !["sending", "sent", "rejected", "unknown"].includes(result.state) || (result.error !== undefined && typeof result.error !== "string")) throw new Error("发送结果格式不完整，请先在 Teams 核对。");
      if (result.state === "sent" || result.state === "rejected") forget(key, body.requestId);
      if (!mounted.current) return;
      setState(result.state === "sending" ? "unknown" : result.state);
      setError(result.error ?? "");
      if (result.state === "sent") { setAttempt(null); setDraft(""); onSent(); }
      else if (result.state === "rejected") setAttempt(null);
    } catch (failure) {
      if (mounted.current) { setState("unknown"); setError(failure instanceof Error ? failure.message : "发送结果未确认，请先在 Teams 核对。"); }
    } finally { busy.current = false; }
  }
  function acknowledge() {
    try { if (attempt) forget(key, attempt.requestId); }
    catch { setError("无法清除本次发送编号，请检查浏览器存储权限。"); return; }
    setAttempt(null); setDraft(""); setState("idle"); setError("");
  }
  if (!available && !attempt) return <p className="teams-readonly-note">当前连接未启用发送，请检查 Teams 账号配置。</p>;
  return <form className="teams-reply-composer" aria-label="回复当前 Teams 会话" aria-busy={state === "sending"} onSubmit={event => { void send(event); }}>
    <textarea aria-label="Teams 回复内容" placeholder="回复此 Teams 会话…" rows={2} maxLength={16_000} value={draft} disabled={!active || state === "sending" || uncertain} onChange={event => { setDraft(event.target.value); setState("idle"); setError(""); }} />
    {(error || uncertain || tooLong) && <p className="teams-reply-error" role="alert">{error || (tooLong ? "回复不能超过 16000 UTF-8 字节。" : "发送结果未确认，请先在 Teams 核对，勿重复发送。")}</p>}
    {state === "sent" && <p className="teams-reply-status" role="status">已发送到 Teams</p>}
    <div className="teams-reply-actions">
      {uncertain && <button type="button" className="text-button" onClick={acknowledge}>已在 Teams 核对，结束本次回复</button>}
      <button type="submit" className="teams-reply-send" disabled={!active || !available || !readable || state === "sending" || (!attempt && (!draft.trim() || tooLong))}><Icon name="send" />{state === "sending" ? "正在发送…" : uncertain ? "重试并核对" : "发送"}</button>
    </div>
  </form>;
}
