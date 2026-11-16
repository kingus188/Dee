import type { Context } from "@earendil-works/chord";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { toolInputInTx, UserOriginError, type Runtime } from "@assistant/runtime";

// This validates a durable call identity, not user approval or model adoption.
// The IDs come from ToolExecutionApi, never read_episode's model arguments.
export async function verifyEpisodeReadCall(runtime: Runtime, ctx: Context, callerId: number,
  call?: { taskId: number; callId: string }) {
  if (!call || !Number.isSafeInteger(call.taskId) || call.taskId <= 0
    || typeof call.callId !== "string" || !call.callId.length || Buffer.byteLength(call.callId, "utf8") > 256) return undefined;
  try {
    await runtime.root.commit(tx => toolInputInTx(tx, {
      conversationId: callerId as ConversationId, taskId: call.taskId as TaskId, callId: call.callId,
    }), ctx);
    return { callerId, taskId: call.taskId, callId: call.callId };
  } catch (error) {
    if (error instanceof UserOriginError) return undefined;
    throw error;
  }
}
