import { useEffect, useState, type ReactNode } from "react";
import type { CardGroup } from "../chat/cards.js";
import { PersonalPage } from "./PersonalPage.js";
import { LocalSkillsPage } from "./LocalSkillsPage.js";
import { NotesPage } from "./NotesPage.js";
import { TasksPage } from "./TasksPage.js";

export function WorkspaceData({ group, owner, connect, headerActions }: { group: CardGroup | null; owner: number | null; connect: () => Promise<number>; headerActions?: ReactNode }) {
  const [opened, setOpened] = useState<Partial<Record<CardGroup, true>>>({});
  const [context, setContext] = useState<number | null>(owner), [error, setError] = useState("");
  useEffect(() => { if (group) setOpened(old => ({ ...old, [group]: true })); }, [group]);
  useEffect(() => { if (owner !== null) setContext(owner); }, [owner]);
  useEffect(() => {
    if ((group !== "notes" && group !== "tasks") || context !== null) return;
    let current = true;
    void connect().then(id => { if (current) { setContext(id); setError(""); } }).catch(error => { if (current) setError(error instanceof Error ? error.message : "无法读取当前会话"); });
    return () => { current = false; };
  }, [group, context]);
  return <>
    {opened.memory && <div hidden={group !== "memory"}><PersonalPage kind="memory" active={group === "memory"} /></div>}
    {opened.skills && <div hidden={group !== "skills"}><LocalSkillsPage active={group === "skills"} /></div>}
    {(["notes", "tasks"] as const).map(kind => opened[kind] && <div className={kind === "notes" ? "notes-page-host" : undefined} hidden={group !== kind} key={kind}>
      {context === null ? error ? <p role="alert" className="workspace-error">{error}</p> : <p role="status">正在读取数据空间…</p> : kind === "notes" ? <NotesPage key={context} owner={context} active={group === kind} headerActions={headerActions} /> : <TasksPage key={context} owner={context} active={group === kind} />}
    </div>)}
  </>;
}
