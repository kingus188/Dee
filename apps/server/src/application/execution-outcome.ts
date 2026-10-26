import type { ExecutionRun } from '@assistant/contracts';
import type { DaylightStore } from '../daylight-store.js';

/** The execution owns this transition once; later user changes remain authoritative. */
export async function applyExecutionResult(store: DaylightStore, run: ExecutionRun) {
  if (!run.daylightTaskId || run.status !== 'done') return;
  await store.replayAction(`execution-review:${run.id}`, async port => {
    const item = (await port.snapshot()).tasks.find(task => task.id === run.daylightTaskId);
    if (item && (item.status === 'todo' || item.status === 'doing')) await port.moveTask(item.id, 'review');
    return { ok: true };
  });
}
