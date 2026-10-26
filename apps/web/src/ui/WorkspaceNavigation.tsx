import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import { workspaceHash } from "./navigation.js";
import type { WorkspaceRoute } from "./navigation.js";

const primary = [
  { page: "home", label: "今日", aria: "首页", icon: "calendar-days" },
  { page: "chat", label: "对话", aria: "继续对话", icon: "message-circle" },
  { page: "daylight", label: "待办", aria: "Daylight 待办", icon: "check-check" },
  { page: "activity", label: "通知", aria: "全部任务动态", icon: "bell" },
] as const;
const personal = [
  { page: "data", group: "memory", label: "长期记忆", icon: "brain" },
  { page: "data", group: "skills", label: "本机技能", icon: "sparkles" },
  { page: "data", group: "notes", label: "笔记", icon: "notebook-pen" },
  { page: "reports", group: null, label: "每日日报", icon: "calendar-days" },
  { page: "data", group: "tasks", label: "任务与提醒", icon: "list-todo" },
] as const;

export function WorkspaceNavigation({ route, onNavigate, onHelp }: { route: WorkspaceRoute; onNavigate: (route: WorkspaceRoute) => void; onHelp: () => void }) {
  const [more, setMore] = useState(false);
  const panel = useRef<HTMLElement>(null), toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => { setMore(false); }, [route]);
  useEffect(() => {
    if (!more) return;
    const close = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !toggle.current?.contains(event.target as Node)) setMore(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMore(false); toggle.current?.focus(); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [more]);
  function link(next: WorkspaceRoute, label: string, icon: string, aria = label) {
    const active = route.page === next.page && route.group === next.group;
    return <a key={label} className="workspace-nav-link" href={workspaceHash(next)} aria-label={aria} aria-current={active ? "page" : undefined} onClick={event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); onNavigate(next);
    }}><Icon name={icon} /><span>{label}</span>{active && <span className="workspace-nav-current" aria-hidden="true" />}</a>;
  }
  return <aside className="sidebar" aria-label="主导航">
    <a className="workspace-brand" href="#today" onClick={event => { event.preventDefault(); onNavigate({ page: "home", group: null }); }} aria-label="小 D 首页">小 D<span>:</span><small>你的个人助手</small></a>
    <nav className="workspace-primary-nav" aria-label="个人工作空间">{primary.map(item => link({ page: item.page, group: null }, item.label, item.icon, item.aria))}<button ref={toggle} className="workspace-more-button" type="button" aria-label="更多菜单" aria-expanded={more} aria-controls="workspace-personal-nav" onClick={() => setMore(value => !value)}><Icon name="more-horizontal" /><span>更多</span></button></nav>
    <section ref={panel} id="workspace-personal-nav" className="workspace-personal-nav" data-open={more} aria-label="个人内容与设置"><p className="workspace-nav-caption">个人空间</p><nav aria-label="个人内容">{personal.map(item => link({ page: item.page, group: item.group }, item.label, item.icon))}</nav><div className="workspace-nav-footer">{link({ page: "settings", group: null }, "连接与设置", "settings")}<button className="workspace-nav-link" type="button" onClick={onHelp}><Icon name="circle-help" /><span>使用指南</span></button><div className="workspace-identity"><span className="workspace-avatar">D</span><div><strong>我的空间</strong><small>记忆与行动，持续相连</small></div></div></div></section>
  </aside>;
}
