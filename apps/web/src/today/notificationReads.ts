import { useEffect, useRef, useState } from "react";
import type { NotificationReadPatch, NotificationReadState, WorkspaceActivity } from "@assistant/contracts";
import { request } from "../api/request.js";
import { activityKey } from "./model.js";

const storageKey = "assistant.notification-reads.v1";
const changesKey = "assistant.notification-read-changes.v1";
const limit = 500;
type Change = { key: string; read: boolean };

// 标记跟随内容版本；状态、时间或执行结果变化时重新成为未读。
export function notificationRevision(item: WorkspaceActivity): string {
  const content = JSON.stringify([item.status, item.at, item.text, item.result ?? null]);
  let hash = 2166136261;
  for (let index = 0; index < content.length; index++) hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
  return `${activityKey(item)}:${hash >>> 0}`;
}

const validKey = (key: unknown): key is string => typeof key === "string" && !!key.trim() && key.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(key);
function readCache(): { values: string[]; changes: Change[]; persistent: boolean } {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) || "[]");
    const pending: unknown = JSON.parse(window.localStorage.getItem(changesKey) || "[]");
    const changes = Array.isArray(pending) ? pending.filter((value): value is Change => !!value && typeof value === "object" && validKey(value.key) && typeof value.read === "boolean").slice(-limit) : [];
    return { values: Array.isArray(parsed) ? parsed.filter(validKey).slice(-limit) : [], changes, persistent: true };
  } catch { return { values: [], changes: [], persistent: false }; }
}
function apply(values: string[], changes: Iterable<Change>): string[] {
  const result = new Set(values);
  for (const { key, read } of changes) { result.delete(key); if (read) result.add(key); }
  return [...result].slice(-limit);
}
function serverKeys(value: NotificationReadState): string[] {
  if (!value || !Array.isArray(value.keys) || value.keys.length > limit || !value.keys.every(validKey)) throw new Error("阅读状态响应无效");
  return value.keys;
}

export function useNotificationReads(active = true) {
  const [state, setState] = useState(() => { const local = readCache(); return { ...local, values: apply(local.values, local.changes) }; });
  const [error, setError] = useState(""), [synced, setSynced] = useState(false);
  const values = useRef(state.values), sequence = useRef(0), busy = useRef<number | null>(null), live = useRef(false), generation = useRef(0);
  const changes = useRef(new Map(state.changes.map(change => [change.key, { ...change, version: 0 }])));
  function publish(next: string[]) {
    values.current = next;
    let persistent = true;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      window.localStorage.setItem(changesKey, JSON.stringify([...changes.current.values()].map(({ key, read }) => ({ key, read }))));
    } catch { persistent = false; }
    if (live.current) setState(previous => ({ ...previous, values: next, persistent }));
  }
  async function sync() {
    const owner = generation.current;
    if (busy.current === owner || !live.current || document.visibilityState === "hidden") return;
    busy.current = owner;
    const current = () => live.current && generation.current === owner;
    let followUp = false;
    try {
      const snapshot = [...changes.current.values()];
      let remote: string[] | undefined;
      for (const read of [false, true]) {
        const batch = snapshot.filter(change => change.read === read);
        if (!batch.length) continue;
        const patch: NotificationReadPatch = { keys: batch.map(change => change.key), read };
        const response = await request<NotificationReadState>("/api/notifications/reads", patch);
        if (!current()) return;
        remote = serverKeys(response);
        for (const change of batch) if (changes.current.get(change.key)?.version === change.version) changes.current.delete(change.key);
      }
      remote ??= serverKeys(await request<NotificationReadState>("/api/notifications/reads"));
      if (!current()) return;
      publish(apply(remote, changes.current.values()));
      followUp = changes.current.size > 0;
      setSynced(!followUp); setError("");
    } catch {
      if (current()) { publish(values.current); setSynced(false); setError("阅读标记同步失败，当前修改已在本地保留，恢复连接后重试。"); }
    } finally { if (busy.current === owner) busy.current = null; if (followUp && current()) void sync(); }
  }
  useEffect(() => {
    live.current = active;
    generation.current++;
    if (!active) return;
    const refreshLocal = () => {
      const cached = readCache();
      values.current = apply(apply(cached.values, cached.changes), changes.current.values());
      setState(previous => ({ ...previous, values: values.current, persistent: cached.persistent }));
    };
    const storage = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) {
        refreshLocal();
        void sync();
      }
    };
    refreshLocal();
    let timer: ReturnType<typeof setInterval> | undefined;
    const focus = () => { if (document.visibilityState !== "hidden") void sync(); };
    const resume = () => {
      clearInterval(timer); timer = undefined;
      if (document.visibilityState === "hidden") return;
      void sync();
      timer = setInterval(() => { void sync(); }, 30000);
    };
    window.addEventListener("storage", storage); window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", resume);
    resume();
    return () => { live.current = false; generation.current++; clearInterval(timer); window.removeEventListener("storage", storage); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", resume); };
  }, [active]);
  function mark(items: WorkspaceActivity[], read: boolean) {
    setSynced(false);
    for (const key of new Set(items.map(notificationRevision))) {
      changes.current.delete(key); changes.current.set(key, { key, read, version: ++sequence.current });
    }
    while (changes.current.size > limit) changes.current.delete(changes.current.keys().next().value!);
    publish(apply(values.current, [...new Set(items.map(notificationRevision))].map(key => ({ key, read }))));
    void sync();
  }
  return { isRead: (item: WorkspaceActivity) => state.values.includes(notificationRevision(item)), mark, persistent: state.persistent, synced, error };
}
