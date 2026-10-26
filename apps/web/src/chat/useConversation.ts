import { useEffect, useRef, useState } from "react";
import type { ConversationView, ServerInfo } from "@assistant/contracts";
import { apiClient } from "../api/socket.js";
import type { ConnectionState } from "../api/socket.js";
import { openDirectConversation, newDirectConversation } from "../api/conversations.js";
import { readServerInfo } from "../api/server.js";
import { showToast } from "../ui/toast.js";

export function useConversation(initialId?: number) {
  const [view, setView] = useState<ConversationView | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [recoveredUntil, setRecoveredUntil] = useState(0);
  const id = useRef<number | null>(initialId ?? null), subscribed = useRef(false), selection = useRef(0);
  const connecting = useRef<Promise<number> | null>(null), creating = useRef<Promise<number> | null>(null);
  const switching = useRef<Promise<number> | null>(null);
  function openConversation(nextId: number): Promise<number> {
    if (!Number.isSafeInteger(nextId) || nextId < 1) return Promise.reject(new Error("对话编号无效"));
    if (id.current === nextId) {
      if (switching.current) return switching.current;
      if (subscribed.current) return Promise.resolve(nextId);
    }
    const version = ++selection.current;
    subscribed.current = false; id.current = nextId; setView(null);
    const operation = apiClient.subscribeConversation(nextId).then(() => {
      if (version === selection.current) subscribed.current = true;
      return nextId;
    }).finally(() => { if (version === selection.current) switching.current = null; });
    switching.current = operation;
    return operation;
  }
  function connectDirectChat(): Promise<number> {
    if (creating.current) return creating.current;
    if (switching.current) return switching.current;
    if (id.current !== null) return subscribed.current ? Promise.resolve(id.current) : openConversation(id.current);
    return connecting.current ??= openDirectConversation().then(result => id.current === null ? openConversation(result.id) : connectDirectChat()).finally(() => { connecting.current = null; });
  }
  function newConversation(): Promise<number> {
    if (creating.current) return creating.current;
    const pending = switching.current ?? connecting.current;
    return creating.current = (async () => {
      if (pending) await pending;
      const result = await newDirectConversation();
      return openConversation(result.id);
    })().finally(() => { creating.current = null; });
  }
  useEffect(() => {
    let mounted = true;
    let previousBoots: number | undefined;
    const offView = apiClient.onView(data => { if (mounted && data.conversationId === id.current) setView(data); });
    const offConnection = apiClient.onConnection(status => {
      if (!mounted) return;
      setConnection(status);
      if (status !== "connected") return;
      void readServerInfo().then(data => {
        if (!mounted) return;
        if (previousBoots !== undefined && data.boots > previousBoots) setRecoveredUntil(Date.now() + 4000);
        previousBoots = data.boots; setInfo(data);
        // 指向历史会话的链接可先读取；发送仍由服务端核对模型与会话状态。
        if (data.configured !== false || id.current !== null) void connectDirectChat().catch(error => showToast("暂时连不上小 D：" + error.message, "error"));
      }).catch(error => showToast("暂时无法读取服务状态：" + error.message, "error"));
    });
    void apiClient.connect().catch(error => showToast("暂时连不上小 D：" + error.message, "error"));
    const close = () => apiClient.close();
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted) void apiClient.resume().catch(error => showToast("恢复连接失败：" + error.message, "error"));
    };
    window.addEventListener("pagehide", close); window.addEventListener("pageshow", resume);
    return () => { mounted = false; offView(); offConnection(); window.removeEventListener("pagehide", close); window.removeEventListener("pageshow", resume); };
  }, []);
  return { view, connection, info, recoveredUntil, connectDirectChat, newConversation, openConversation };
}
