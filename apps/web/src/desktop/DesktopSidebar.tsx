import { useEffect, useRef, useState } from "react";
import type { DesktopAgentSnapshot } from "@assistant/contracts";
import { Icon } from "../ui/Icon.js";
import { ConversationHistoryContent } from "../ui/ConversationHistoryContent.js";
import { ConversationHistoryRow } from "../ui/ConversationHistoryRow.js";
import { agentNames } from "./AgentPicker.js";

export function useDesktopSidebar() {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.("(max-width: 900px)").matches ?? false);
  const [expanded, setExpanded] = useState(() => {
    try { return (window.localStorage.getItem("dee.history.collapsed") ?? window.localStorage.getItem("dee.sidebar.collapsed")) !== "true"; }
    catch { return true; }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null), toggle = useRef<HTMLButtonElement>(null);
  const open = narrow ? mobileOpen : expanded;
  function setOpen(value: boolean) {
    if (narrow) setMobileOpen(value);
    else {
      setExpanded(value);
      try { window.localStorage.setItem("dee.history.collapsed", String(!value)); } catch { /* Optional preference. */ }
    }
  }
  function close() { setOpen(false); toggle.current?.focus(); }
  function toggleOpen() {
    setOpen(!open);
    if (!open) requestAnimationFrame(() => panel.current?.querySelector<HTMLInputElement>("input")?.focus());
  }
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 900px)");
    if (!media) return;
    const resize = () => { setNarrow(media.matches); setMobileOpen(false); };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    if (!open) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (narrow || panel.current?.contains(document.activeElement))) { event.preventDefault(); close(); return; }
      if (event.key !== "Tab" || !narrow) return;
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input, select, summary") ?? [])].filter(element => !element.closest("[hidden]") && !element.closest("details:not([open]) > :not(summary)"));
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [narrow, open]);
  useEffect(() => {
    const search = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      const focus = () => panel.current?.querySelector<HTMLInputElement>(".history-search input")?.focus();
      if (open) focus();
      else { setOpen(true); requestAnimationFrame(focus); }
    };
    document.addEventListener("keydown", search);
    return () => document.removeEventListener("keydown", search);
  }, [narrow, open]);
  return { narrow, open, panel, toggle, close, toggleOpen };
}

export function DesktopSidebar({ sidebar, snapshot, onOpen, onTeams, onNew, newDisabled }: { sidebar: ReturnType<typeof useDesktopSidebar>; snapshot: DesktopAgentSnapshot | null; onOpen: () => void; onTeams: () => void; onNew?: () => void; newDisabled?: boolean }) {
  const [query, setQuery] = useState("");
  const title = snapshot?.messages.find(message => message.role === "user")?.text.split("\n")[0]?.slice(0, 80) || (snapshot?.agent && snapshot.agent !== "pi" ? agentNames[snapshot.agent] : "与小 D 对话");
  const source = agentNames[snapshot?.agent ?? "pi"];
  const detail = snapshot?.workspace?.split(/[\\/]/).filter(Boolean).at(-1) || "本机";
  const status = snapshot?.external?.status === "waiting" ? "waiting" : snapshot?.busy ? "running" : snapshot?.external?.status === "idle" ? undefined : snapshot?.external?.status;
  const found = `${title} ${source} ${detail}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const row = <ConversationHistoryRow href="#chat" title={title} source={source} detail={detail} current status={status}
    onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); if (sidebar.narrow) sidebar.close(); onOpen(); }} />;
  const working = !query.trim() && (status === "running" || status === "waiting");
  return <>
    {sidebar.narrow && sidebar.open && <button className="history-backdrop" aria-label="关闭本机对话遮罩" onClick={sidebar.close} />}
    <div className="conversation-sidebar" data-expanded={sidebar.open} ref={sidebar.panel} role={sidebar.narrow && sidebar.open ? "dialog" : undefined} aria-modal={sidebar.narrow && sidebar.open ? true : undefined} aria-label="本机对话侧栏">
      <aside id="conversation-history" className="conversation-history" hidden={!sidebar.open} aria-label="本机对话">
        <ConversationHistoryContent query={query} onQuery={setQuery} onClose={sidebar.close} onTeams={onTeams} onNew={onNew} newDisabled={newDisabled} searchLabel="搜索本机会话" closeLabel="关闭本机对话"
          bottom={working && <details className="history-working" open><summary>{status === "waiting" ? "等待确认" : "运行中"}<span>1</span><Icon name="chevron-right" /></summary>{row}</details>}>
          {found ? !working && <section aria-label={query.trim() ? "搜索结果" : "当前对话"}><h2 className="history-heading">{query.trim() ? "搜索结果" : "当前对话"}</h2>{row}</section> : <p className="workspace-muted">没有匹配的本机会话。</p>}
        </ConversationHistoryContent>
      </aside>
      <button ref={sidebar.toggle} className="sidebar-toggle" type="button" aria-label={sidebar.open ? "收起历史对话" : "展开历史对话"} title={sidebar.open ? "收起历史对话" : "展开历史对话"} aria-expanded={sidebar.open} aria-controls="conversation-history" onClick={sidebar.toggleOpen}><Icon name={sidebar.open ? "chevron-left" : "chevron-right"} /></button>
    </div>
  </>;
}
