import { useState } from "react";
import type { PeerArtifact } from "@assistant/contracts";
import { request } from "../api/request.js";

/** Retrieval never asks a device to read or upload additional files. */
export function ResultFiles() {
  const [items, setItems] = useState<PeerArtifact[]>([]), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function load() {
    setBusy(true); setError("");
    try { setItems((await request<{ items: PeerArtifact[] }>("/api/peers/artifacts")).items); setLoaded(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Result files unavailable"); }
    finally { setBusy(false); }
  }
  return <section aria-label="Result files" className="workspace-records">
    <button type="button" className="text-button" disabled={busy} onClick={() => void load()}>Result files</button>
    {error && <p role="alert">{error}</p>}
    {loaded && !items.length && <p>No shared result files</p>}
    {items.map(item => <article className="workspace-record" key={item.id}>
      <a href={`/api/peers/tasks/${item.taskId}/artifacts/${item.id}?deviceId=${item.deviceId}&download=1`} download={item.name}>{item.name}</a>
      <p>{item.size} bytes · {item.mimeType} · {item.status}</p>
      <details><summary>Details</summary><dl><dt>Device</dt><dd>{item.deviceId}</dd><dt>Task</dt><dd>{item.taskId}</dd><dt>SHA256</dt><dd style={{ overflowWrap: "anywhere" }}>{item.sha256}</dd></dl></details>
    </article>)}
  </section>;
}
