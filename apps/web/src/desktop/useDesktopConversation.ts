import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationView, DesktopAgentSnapshot } from "@assistant/contracts";
import { desktopAgentBridge } from "./bridge.js";
import type { MessageSender } from "../chat/useMessageDelivery.js";

export function useDesktopConversation() {
  const bridge = desktopAgentBridge();
  const [snapshot, setSnapshot] = useState<DesktopAgentSnapshot | null>(null);
  const [error, setError] = useState(""), [pollError, setPollError] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const locks = useRef(new Set<string>());
  const current = useRef(snapshot); current.current = snapshot;
  const refresh = useCallback(async () => { if (bridge) setSnapshot(await bridge.snapshot()); }, [bridge]);
  useEffect(() => {
    if (!bridge) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await bridge!.snapshot();
        if (!stopped) { setSnapshot(next); setPollError(""); }
      } catch (cause) {
        if (!stopped) setPollError(cause instanceof Error ? cause.message : "无法读取本机状态，请重试。");
      } finally { if (!stopped) timer = setTimeout(() => void poll(), 1000); }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [bridge]);
  async function action(id: string, run: () => Promise<void>): Promise<boolean> {
    if (locks.current.has(id)) return false;
    locks.current.add(id); setPending([...locks.current]); setError("");
    try { await run(); await refresh(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "本机操作未完成，请重试。"); return false; }
    finally { locks.current.delete(id); setPending([...locks.current]); }
  }
  const view = useMemo<ConversationView | null>(() => snapshot ? {
    conversationId: -1, channel: "desktop", entries: snapshot.messages.map((message, index) => ({ id: index + 1, kind: message.role, text: message.text })),
    live: {}, busy: snapshot.busy, inbox: 0, notes: { todos: [], memos: [] }, usage: null, tasks: [], reminders: [], subagents: [], parentId: null,
  } : null, [snapshot]);
  const send: MessageSender = async (body, files, checkDestination) => {
    if (!bridge || !current.current?.configured || current.current.busy || pollError || locks.current.size) throw new Error("本机 Agent 尚未就绪，请检查状态后重试。");
    if (files.length || body.attachments?.length) throw new Error("本机 Agent 暂不支持附件，请先移除附件。");
    checkDestination?.(-1);
    if (!await action("send", () => bridge.send({ id: body.requestId, text: body.text ?? "" }))) throw new Error("本机发送结果未确认，请核对后重试。");
  };
  async function newConversation(): Promise<void> {
    if (!bridge || !current.current || current.current.busy || locks.current.size) throw new Error("本机 Agent 正忙或尚未就绪，请稍后重试。");
    if (!await action("new-session", () => bridge.newSession())) throw new Error("本机新对话未创建，草稿已保留。");
  }
  return { bridge, snapshot, view, pending, action, refresh, send, newConversation, pollError, error,
    warning: error || pollError || snapshot?.error || (snapshot && !snapshot.serverConnected ? "服务器未连接，本机对话仍可使用。" : "") };
}
