import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalSkillsBridge, LocalSkillsSnapshot } from "@assistant/contracts";

declare global { interface Window { localSkills?: LocalSkillsBridge } }
export function localSkillsBridge() {
  const bridge = window.localSkills;
  return bridge?.version === 1 ? bridge : undefined;
}
export function localSkillError(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "本机技能读取失败，请重试。";
}

export function useLocalSkills(active: boolean) {
  const bridge = localSkillsBridge();
  const [snapshot, setSnapshot] = useState<LocalSkillsSnapshot>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const changing = useRef(false), version = useRef(0);
  const refresh = useCallback(async () => {
    if (!bridge || changing.current) return;
    const current = ++version.current;
    setLoading(true); setError("");
    try { const value = await bridge.list(); if (current === version.current) setSnapshot(value); }
    catch (cause) { if (current === version.current) setError(localSkillError(cause)); }
    finally { if (current === version.current) setLoading(false); }
  }, [bridge]);
  useEffect(() => {
    if (!active || !bridge) return;
    void refresh();
    return () => { version.current++; };
  }, [active, bridge, refresh]);
  async function change<T>(action: () => Promise<T>, apply: (value: T) => void) {
    if (changing.current) return;
    changing.current = true; version.current++;
    setBusy(true); setLoading(false); setError(""); setFeedback("");
    try { const value = await action(); apply(value); return value; }
    catch (cause) { setError(localSkillError(cause)); return undefined; }
    finally { changing.current = false; setBusy(false); }
  }
  return { bridge, snapshot, loading, busy, error, feedback, refresh,
    addDirectory: () => bridge && change(() => bridge.addDirectory(), value => { if (value) { setSnapshot(value); setFeedback("已添加扫描目录。"); } }),
    removeDirectory: (id: string) => bridge && change(() => bridge.removeDirectory(id), value => { setSnapshot(value); setFeedback("已移除扫描目录。"); }),
    importSkill: () => bridge && change(() => bridge.importSkill(), value => { if (value) { setSnapshot(value.snapshot); setFeedback("技能已导入共享 Agents 目录。"); } }),
  };
}
