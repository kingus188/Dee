import type { DesktopPeerJob } from "@assistant/contracts";
import type { useDesktopConversation } from "./useDesktopConversation.js";
import { MarkdownContent } from "../chat/MarkdownContent.js";
import { agentNames } from "./AgentPicker.js";

function execution(job: DesktopPeerJob): string {
  if (job.cancellation?.confirmedAt) return "Cancelled";
  if (job.cancellation && job.status !== "done" && job.status !== "failed") return "Cancellation pending";
  return { queued: "Queued", running: "Running", done: "Succeeded", failed: "Failed" }[job.status];
}

export function PeerJobs({ local }: { local: ReturnType<typeof useDesktopConversation> }) {
  const { snapshot, bridge, pending, action, pollError } = local;
  if (!snapshot || !bridge) return null;
  const jobs = snapshot.jobs.filter(job => job.source === snapshot.nodeId || (job.source === "server" && job.target === snapshot.nodeId));
  const ended = (job: DesktopPeerJob) => job.status === "done" || job.status === "failed";
  const completed = jobs.filter(ended);
  const renderJob = (job: DesktopPeerJob) => {
    const terminal = job.status === "done" || job.status === "failed";
    const approval = job.status === "queued" && job.target === snapshot.nodeId && !job.cancellation;
    const disabled = pending.includes(job.id) || !!pollError;
    return <article className="desktop-agent-job" key={job.id}>
      <details open={!terminal}>
        <summary>{execution(job)} · {job.task.slice(0, 80)}</summary>
        <dl>
          <dt>Runs on</dt><dd>{job.target}</dd>
          <dt>Workspace</dt><dd>{job.workspace ?? "Unspecified"}</dd>
          <dt>Execution</dt><dd>{execution(job)}</dd>
          <dt>Delivery</dt><dd>{job.resultDelivered ? "Delivered to source" : job.source !== snapshot.nodeId ? "Source confirmation unavailable" : terminal ? "Pending" : "Awaiting execution"}</dd>
          <dt>Review</dt><dd>Not recorded</dd>
          {job.constraints && <><dt>Constraints</dt><dd>{job.constraints}</dd></>}
          {job.acceptanceCriteria && <><dt>Acceptance criteria</dt><dd>{job.acceptanceCriteria}</dd></>}
        </dl>
        <div className="md"><MarkdownContent text={job.task} /></div>
        {job.result && <div className="md"><MarkdownContent text={job.result} /></div>}
        {job.deliveryError && <p role="status">{job.deliveryError}</p>}
        {approval && <p role="status">{job.approved ? "Waiting for execution slot" : "Waiting for approval"}</p>}
        <div className="desktop-agent-job-actions">
          {approval && <>
            {!job.approved && <button type="button" className="header-button" disabled={disabled || ((!job.targetSession || job.targetSession.agent === "pi") && !(snapshot.piConfigured ?? snapshot.configured))} onClick={() => void action(job.id, () => bridge.approve(job.id))}>Approve {agentNames[job.targetSession?.agent ?? "pi"]}</button>}
            <button type="button" className="header-button" disabled={disabled} onClick={() => void action(job.id, () => bridge.reject(job.id))}>Reject</button>
          </>}
          {!terminal && bridge.cancelPeer && <button type="button" className="header-button" disabled={disabled || !!job.cancellation} onClick={() => void action(job.id, () => bridge.cancelPeer!(job.id))}>Cancel</button>}
        </div>
      </details>
    </article>;
  };
  return <>{jobs.filter(job => !ended(job)).map(renderJob)}
    {completed.length > 0 && <details className="desktop-peer-history"><summary>Completed peer tasks ({completed.length})</summary>{completed.map(renderJob)}</details>}
  </>;
}
