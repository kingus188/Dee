import { useRef, useState } from "react";
import type { DesktopAgentBridge, DesktopAgentSnapshot } from "@assistant/contracts";

type Sync = NonNullable<DesktopAgentSnapshot["conversationSync"]>;
export function ConversationSync({ sync, save, disabled }: {
  sync: Sync;
  save: NonNullable<DesktopAgentBridge["setConversationSync"]>;
  disabled: boolean;
}) {
  const [mode, setMode] = useState(sync.mode), [summary, setSummary] = useState(sync.summary);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const saving = useRef(false);
  const changed = mode !== sync.mode || (mode === "summary" && summary !== sync.summary);
  async function submit() {
    if (disabled || saving.current || !changed) return;
    saving.current = true; setPending(true); setError("");
    try { await save({ sessionId: sync.sessionId, mode, ...(mode === "summary" ? { summary } : {}) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Sync preference was not saved. Try again."); }
    finally { saving.current = false; setPending(false); }
  }
  return <form className="conversation-sync-control" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <label>Share with server <select aria-label="Conversation sync scope" value={mode} disabled={disabled || pending} onChange={event => setMode(event.target.value as Sync["mode"])}>
      <option value="local">Local only</option><option value="summary">Summary &amp; results</option><option value="full">Full conversation</option>
    </select></label>
    {sync.serverMismatch && <p>This conversation remains bound to its original server; changing servers does not move it.</p>}
    {mode === "summary" && <label>Shared summary<textarea aria-label="Shared summary" value={summary} maxLength={32000} disabled={disabled || pending} onChange={event => setSummary(event.target.value)} placeholder="Write the summary and results you want to share." /></label>}
    {mode === "summary" && <p>Only this text is shared. Future replies are not added automatically.</p>}
    {mode === "full" && mode !== sync.mode && <p>Share the complete text history and future replies with the paired server. Files and tool state are not included.</p>}
    {sync.previouslyShared && mode !== "full" && <p>Previously shared data remains on the server. Changing scope does not erase it.</p>}
    <button className="header-button" type="submit" disabled={disabled || pending || !changed || (mode === "summary" && !summary.trim())}>{pending ? "Saving…" : "Save"}</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
