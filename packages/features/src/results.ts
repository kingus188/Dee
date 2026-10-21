import type { ToolExecutionResult } from "@earendil-works/pi-durable";
export const resultText = (value: string): ToolExecutionResult => ({ output: [{ type: "text", text: value }] });
// Chord 的事务 overlay 不能在事务结束后读取。
export const detach = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export const finishTask = (result: string | null = null) => ({ status: "terminal", outcome: { status: "completed", result } } as const);
