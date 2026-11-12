import { PeerJobs } from "@assistant/runtime";
import type { ApiEvent } from "@assistant/contracts";
import type { AppContext } from "../application/context.js";

export async function watchPeerTasks(context: Pick<AppContext, "harness" | "root" | "ctx">, deviceId: string, send: (event: ApiEvent) => Promise<void>, onError: (error: unknown) => void) {
  await context.root.commit(async tx => { await tx.doc(PeerJobs); }, context.ctx);
  const doc = await context.harness.documentState(PeerJobs, context.ctx);
  if (!doc) throw new Error("委派状态不可用");
  let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  let previous = "";
  function schedule() {
    if (closed) return;
    const next = JSON.stringify((doc!.value?.items ?? []).filter(job => job.source === deviceId || job.target === deviceId));
    if (next === previous) return;
    previous = next;
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; if (!closed) void send({ type: "event", event: "peer-tasks", data: { deviceId } }).catch(onError); }, 50);
  }
  const unsubscribe = doc.subscribe(schedule);
  schedule();
  return () => { if (closed) return; closed = true; clearTimeout(timer); unsubscribe(); doc.dispose(); };
}
