import { lazy, useEffect, useState, type ReactNode } from "react";
import type { CardGroup } from "../chat/cards.js";
import { PageLoad } from "../ui/PageLoad.js";
const PersonalPage = lazy(() => import("./PersonalPage.js").then(module => ({ default: module.PersonalPage })));
const LocalSkillsPage = lazy(() => import("./LocalSkillsPage.js").then(module => ({ default: module.LocalSkillsPage })));
const NotesPage = lazy(() => import("./NotesPage.js").then(module => ({ default: module.NotesPage })));
const TasksPage = lazy(() => import("./TasksPage.js").then(module => ({ default: module.TasksPage })));

export function WorkspaceData({ group, owner, connect, headerActions, skillSource, onSkillSourceChange }: { group: CardGroup | null; owner: number | null; connect: () => Promise<number>; headerActions?: ReactNode; skillSource?: "remote"; onSkillSourceChange?: (remote: boolean) => void }) {
  const [opened, setOpened] = useState<Partial<Record<CardGroup, true>>>({});
  const [context, setContext] = useState<number | null>(owner), [error, setError] = useState("");
  useEffect(() => { if (group) setOpened(old => ({ ...old, [group]: true })); }, [group]);
  useEffect(() => { if (owner !== null) setContext(owner); }, [owner]);
  useEffect(() => {
    if (group !== "tasks" || context !== null) return;
    let current = true;
    void connect().then(id => { if (current) { setContext(id); setError(""); } }).catch(error => { if (current) setError(error instanceof Error ? error.message : "无法读取当前会话"); });
    return () => { current = false; };
  }, [group, context]);
  return <>
    {opened.memory && <div hidden={group !== "memory"}><PageLoad><PersonalPage kind="memory" active={group === "memory"} /></PageLoad></div>}
    {opened.skills && <div hidden={group !== "skills"}><PageLoad><LocalSkillsPage active={group === "skills"} remote={skillSource === "remote"} onRemoteChange={onSkillSourceChange} /></PageLoad></div>}
    {opened.notes && <div className="notes-page-host" hidden={group !== "notes"}>
      <PageLoad><NotesPage owner="global" active={group === "notes"} headerActions={headerActions} /></PageLoad>
    </div>}
    {opened.tasks && <div hidden={group !== "tasks"}>
      <PageLoad>{context === null ? error ? <p role="alert" className="workspace-error">{error}</p> : <p role="status">正在读取数据空间…</p> : <TasksPage key={context} owner={context} active={group === "tasks"} />}</PageLoad>
    </div>}
  </>;
}
