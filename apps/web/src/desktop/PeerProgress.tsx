import type { DesktopPeerJob } from "@assistant/contracts";

export function PeerProgress({ job }: { job: DesktopPeerJob }) {
  if (job.status !== "queued" && job.status !== "running") return null;
  const age = Math.max(0, Math.floor((Date.now() - Date.parse(job.updatedAt)) / 1000));
  return <p role="status">{job.cancellation ? "Waiting for cancellation confirmation" : job.status === "queued" ? "Waiting for execution admission" : "Waiting for execution result"}
    {Number.isFinite(age) && <> · Last recorded state {age}s ago</>}
    {age >= 120 && <>. State age is not a heartbeat; no automatic execution retry.</>}
  </p>;
}
