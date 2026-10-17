import { useEffect, useRef, useState } from "react";
import type { ConversationView, ServerInfo } from "@assistant/contracts";
import { apiClient } from "../api/socket.js";
import type { ConnectionState } from "../api/socket.js";
import { openDirectConversation, newDirectConversation } from "../api/conversations.js";
import { readServerInfo } from "../api/server.js";
import { showToast } from "../ui/toast.js";

export function useConversation() {
  const [view, setView] = useState<ConversationView | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [recoveredUntil, setRecoveredUntil] = useState(0);
  const id = useRef<number | null>(null);
  const connecting = useRef<Promise<number> | null>(null);
  const creating = useRef<Promise<number> | null>(null);
  function connectDirectChat(): Promise<number> {
    if (creating.current) return creating.current;
    if (id.current !== null) return Promise.resolve(id.current);
    return connecting.current ??= openDirectConversation().then(async result => {
      await apiClient.subscribeConversation(result.id);
      id.current = result.id;
      return result.id;
    }).finally(() => { connecting.current = null; });
  }
  function newConversation(): Promise<number> {
    if (creating.current) return creating.current;
    const pending = connecting.current;
    return creating.current = (async () => {
      if (pending) await pending;
      const result = await newDirectConversation();
      // 已创建就不再向旧会话发送；订阅失败后由普通连接恢复最新会话。
      id.current = null;
      setView(null);
      await apiClient.subscribeConversation(result.id);
      id.current = result.id;
      return result.id;
    })().finally(() => { creating.current = null; });
  }
  useEffect(() => {
    let mounted = true;
    let previousBoots: number | undefined;
    const offView = apiClient.onView(data => { if (mounted) setView(data); });
    const offConnection = apiClient.onConnection(status => {
      if (!mounted) return;
      setConnection(status);
      if (status !== "connected") return;
      void readServerInfo().then(data => {
        if (!mounted) return;
        if (previousBoots !== undefined && data.boots > previousBoots) setRecoveredUntil(Date.now() + 4000);
        previousBoots = data.boots; setInfo(data);
        if (data.configured !== false) void connectDirectChat().catch(error => showToast("暂时连不上小 D：" + error.message, "error"));
      }).catch(error => showToast("暂时无法读取服务状态：" + error.message, "error"));
    });
    void apiClient.connect().catch(error => showToast("暂时连不上小 D：" + error.message, "error"));
    const close = () => apiClient.close();
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted) void apiClient.resume().catch(error => showToast("恢复连接失败：" + error.message, "error"));
    };
    window.addEventListener("pagehide", close);
    window.addEventListener("pageshow", resume);
    return () => { mounted = false; offView(); offConnection(); window.removeEventListener("pagehide", close); window.removeEventListener("pageshow", resume); };
  }, []);
  return { view, connection, info, recoveredUntil, connectDirectChat, newConversation };
}
