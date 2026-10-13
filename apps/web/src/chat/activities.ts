import type { RunningTool, ToolArgs, ViewEntry } from "@assistant/contracts";

export type ToolActivity = { id: string; name: string; status: "pending" | "running" | "completed" | "error" | "interrupted" | "ended"; text: string; args?: ToolArgs };
const labels: Record<string, string> = {
  todo: "整理待办", memo: "保存笔记", fetch_page: "阅读网页", wait_seconds: "等待任务继续", current_time: "查看时间",
  remind_me: "设置提醒", schedule_task: "安排计划", delegate: "委派任务", delegate_background: "后台处理",
  propose_memory: "整理记忆", propose_skill: "整理技能", read_skill: "读取技能", search_knowledge: "检索知识库", read_knowledge: "阅读知识库",
};
export const activityLabel = (name: string) => labels[name] ?? "执行步骤";

export function toolActivities(entries: ViewEntry[], live: RunningTool[], busy: boolean): ToolActivity[] {
  const activities = new Map<string, ToolActivity>();
  for (const entry of entries) {
    for (const call of entry.toolCalls ?? []) activities.set(call.id, { id: call.id, name: call.name, args: call.args, status: "pending", text: "" });
    if (entry.kind !== "tool") continue;
    const id = entry.toolCallId ?? [...activities.values()].find(item => item.name === entry.name && ["pending", "running"].includes(item.status))?.id ?? `entry:${entry.id}`;
    const previous = activities.get(id);
    activities.set(id, { id, name: entry.name ?? previous?.name ?? "", args: previous?.args, status: entry.isError ? "error" : "completed", text: entry.text });
  }
  for (const tool of live) {
    const existing = tool.callId ? activities.get(tool.callId) : [...activities.values()].find(item => item.name === tool.name && ["pending", "running"].includes(item.status));
    if (existing?.status === "completed" || existing?.status === "error") continue;
    const id = tool.callId ?? existing?.id ?? `live:${activities.size}`;
    // SDK 的 done 也可能没有结果条目；只有已收到的结果能证明成功。
    const status = tool.status === "done" ? "ended" : tool.status === "pending" ? "pending" : tool.status === "error" ? "error" : "running";
    activities.set(id, { id, name: tool.name, args: tool.args ?? existing?.args, status, text: tool.output ?? existing?.text ?? "" });
  }
  return [...activities.values()].map(item => !busy && ["pending", "running"].includes(item.status) ? { ...item, status: "interrupted" } : item);
}
