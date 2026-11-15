import { useEffect, useRef, useState } from "react";
import type { DesktopAgentBridge, DesktopAgentSnapshot } from "@assistant/contracts";

type Sync = NonNullable<DesktopAgentSnapshot["conversationSync"]>;
export function ConversationSync({ sync, save, disabled, generate, cancel }: {
  sync: Sync;
  save: NonNullable<DesktopAgentBridge["setConversationSync"]>;
  disabled: boolean;
  generate?: DesktopAgentBridge["generateSummaryDraft"];
  cancel?: DesktopAgentBridge["cancelSummaryDraft"];
}) {
  const [mode, setMode] = useState(sync.mode), [summary, setSummary] = useState(sync.summary);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const saving = useRef(false), generation = useRef(0);
  const [generating, setGenerating] = useState(false), [sourceRevision, setSourceRevision] = useState<string>();
  useEffect(() => () => { generation.current++; void cancel?.({ sessionId: sync.sessionId }).catch(() => {}); }, [sync.sessionId, cancel]);
  async function draft() {
    if (!generate || generating || saving.current || disabled) return;
    const token = ++generation.current;
    setGenerating(true); setError("");
    try {
      const result = await generate({ sessionId: sync.sessionId });
      if (token === generation.current) { setSummary(result.summary); setSourceRevision(result.sourceRevision); }
    } catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : "Draft generation failed"); }
    finally { if (token === generation.current) setGenerating(false); }
  }
  async function cancelDraft() {
    generation.current++; setGenerating(false);
    try { await cancel?.({ sessionId: sync.sessionId }); }
    catch { setError("Could not stop generation; any returned draft will be discarded"); }
  }
  const changed = mode !== sync.mode || (mode === "summary" && summary !== sync.summary);
  async function submit() {
    if (disabled || generating || saving.current || !changed) return;
    saving.current = true; setPending(true); setError("");
    try { await save({ sessionId: sync.sessionId, mode, ...(mode === "summary" ? { summary, ...(sourceRevision ? { sourceRevision } : {}) } : {}) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Sync preference was not saved. Try again."); }
    finally { saving.current = false; setPending(false); }
  }
  return <form className="conversation-sync-control" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <label>Share with server <select aria-label="Conversation sync scope" value={mode} disabled={disabled || pending || generating} onChange={event => setMode(event.target.value as Sync["mode"])}>
      <option value="local">Local only</option><option value="summary">Summary &amp; results</option><option value="full">Full conversation</option>
    </select></label>
    {sync.serverMismatch && <p>This conversation remains bound to its original server; changing servers does not move it.</p>}
    {(mode === "summary" || sourceRevision) && <label>Summary draft<textarea aria-label="Shared summary" value={summary} maxLength={32000} disabled={disabled || pending || generating} onChange={event => setSummary(event.target.value)} placeholder="Write the summary and results you want to share." /></label>}
    {generate && <button className="header-button" type="button" disabled={disabled || pending || generating} title="Uses the configured Pi model provider; does not publish to the Dee server" onClick={() => void draft()}>Generate draft</button>}
    {generating && <button className="header-button" type="button" onClick={() => void cancelDraft()}>Cancel generation</button>}
    {sourceRevision && <p>Review and edit the draft, then choose Summary &amp; results and publish. Generation does not change sharing.</p>}
    {mode === "summary" && <p>Only this text is shared. Future replies are not added automatically.</p>}
    {mode === "full" && mode !== sync.mode && <p>Share the complete text history and future replies with the paired server. Files and tool state are not included.</p>}
    {sync.previouslyShared && mode !== "full" && <p>Previously shared data remains on the server. Changing scope does not erase it.</p>}
    <button className="header-button" type="submit" disabled={disabled || pending || generating || !changed || (mode === "summary" && !summary.trim())}>{pending ? "Saving…" : mode === "summary" ? "Publish summary" : "Save"}</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
