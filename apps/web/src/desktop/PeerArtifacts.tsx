import { useState } from "react";
import type { DesktopAgentBridge } from "@assistant/contracts";

export function PeerArtifacts({ id, canShare, bridge }: { id: string; canShare: boolean; bridge: DesktopAgentBridge }) {
  const [items, setItems] = useState<Awaited<ReturnType<NonNullable<DesktopAgentBridge["listArtifacts"]>>>>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function load(share = false) {
    setBusy(true); setError("");
    try { if (share) await bridge.shareArtifact?.(id); setItems(await bridge.listArtifacts!(id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Artifact delivery unavailable"); }
    finally { setBusy(false); }
  }
  if (!bridge.listArtifacts) return null;
  return <section aria-label="Result files">
    <button type="button" className="header-button" disabled={busy} onClick={() => void load()}>Result files</button>
    {canShare && bridge.shareArtifact && <button type="button" className="header-button" disabled={busy} onClick={() => void load(true)}>Share selected file</button>}
    {error && <p role="alert">{error}</p>}
    {items.map(item => <p key={item.id}><a href={item.downloadUrl} download={item.name}>{item.name}</a> · {item.size} bytes · {item.status}<br /><code title={item.deviceId}>SHA256 {item.sha256}</code></p>)}
  </section>;
}
