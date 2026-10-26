import { useEffect, useRef, useState } from "react";
import type { LocalSkillDetail } from "@assistant/contracts";
import { renderMarkdown } from "../chat/markdown.js";
import { Icon } from "../ui/Icon.js";
import { PersonalPage } from "./PersonalPage.js";
import { localSkillError, useLocalSkills } from "./useLocalSkills.js";

type Props = { active: boolean };
export function LocalSkillsPage({ active }: Props) {
  const [legacy, setLegacy] = useState(false), [legacyOpened, setLegacyOpened] = useState(false);
  const resource = useLocalSkills(active && !legacy);
  const { bridge, snapshot, loading, busy, error, feedback } = resource;
  const [query, setQuery] = useState(""), [source, setSource] = useState("all"), [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<LocalSkillDetail>(), [reading, setReading] = useState(false), [readError, setReadError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!active || legacy || !bridge || !selected) return;
    let disposed = false;
    setReading(true); setDetail(undefined); setReadError("");
    bridge.read(selected).then(value => { if (!disposed) setDetail(value); }).catch(cause => { if (!disposed) setReadError(localSkillError(cause)); }).finally(() => { if (!disposed) setReading(false); });
    return () => { disposed = true; };
  }, [active, legacy, bridge, selected, snapshot]);
  useEffect(() => { if (detail) heading.current?.focus(); }, [detail]);
  const legacyPage = <section className="workspace-content-page" hidden={!active || !legacy}>
    <button type="button" className="text-button workspace-back" onClick={() => setLegacy(false)}><Icon name="arrow-left" />返回本机技能</button>
    <p className="workspace-local-note">远程小 D 的技能记录</p>
    <PersonalPage kind="skills" active={active && legacy} />
  </section>;
  const skills = snapshot?.skills ?? [];
  const search = query.trim().toLocaleLowerCase();
  const filtered = skills.filter(skill => (source === "all" || skill.locations.some(location => location.rootId === source)) && (!search || `${skill.name} ${skill.description} ${skill.locations.map(location => location.label).join(" ")}`.toLocaleLowerCase().includes(search)));
  const back = () => { setSelected(undefined); setDetail(undefined); setReadError(""); };
  return <>{legacyOpened && legacyPage}<section className="workspace-content-page workspace-local-skills" hidden={!active || legacy}>
    <div className="workspace-library-toolbar"><div><strong>这台电脑的技能</strong><span className="workspace-library-count">{snapshot ? `${skills.length} 项技能 · ${snapshot.roots.filter(root => root.exists).length} 个目录` : "SKILL.md 技能目录"}</span></div>
      {bridge && <div className="workspace-library-actions"><button type="button" className="header-button workspace-outline-button" disabled={loading || busy} onClick={() => void resource.refresh()}><Icon name="refresh-cw" />刷新</button><button type="button" className="header-button workspace-outline-button" disabled={busy || loading} onClick={() => void resource.addDirectory()}><Icon name="folder-plus" />添加目录</button><button type="button" className="settings-save" disabled={busy || loading} onClick={async () => { const value = await resource.importSkill(); if (value) setSelected(value.skillId); }}><Icon name="download" />导入本地技能</button></div>}
    </div>
    <p className="workspace-local-note">按来源浏览本机技能文件。导入会复制到共享 Agents 目录；远程小 D 的技能加载配置独立管理。</p>
    {feedback && <p className="workspace-content-feedback" role="status">{feedback}</p>}
    {error && <p className="workspace-error" role="alert">{error}</p>}
    {!bridge ? <div className="workspace-content-empty"><Icon name="monitor" /><h2>在桌面客户端中管理本机技能</h2><p>当前浏览器连接的是远程服务。请打开更新后的桌面客户端，读取这台电脑上的技能目录。</p></div> : selected ? <section className="workspace-reading" aria-label="本机技能详情">
      <button type="button" className="text-button workspace-back" onClick={back}><Icon name="arrow-left" />返回技能列表</button>
      {reading && <p role="status">正在读取技能文件…</p>}
      {readError && <p className="workspace-error" role="alert">{readError}</p>}
      {detail && <><div className="workspace-detail-heading"><div><h2 ref={heading} tabIndex={-1}>{detail.name}</h2><p>{detail.description || "这个技能尚未填写简介。"}</p></div><button type="button" className="header-button workspace-outline-button" disabled={busy || loading} onClick={async () => { try { await bridge.reveal(detail.id); } catch (cause) { setReadError(localSkillError(cause)); } }}><Icon name="folder-open" />在文件夹中显示</button></div>
        <p className="workspace-local-path">{detail.filePath}</p>
        <div className="workspace-local-sources">{detail.locations.map(location => <span key={`${location.rootId}:${location.path}`} className="workspace-local-source">{location.label}</span>)}</div>
        {detail.issue && <p className="workspace-content-feedback" role="status">{detail.issue}</p>}
        <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "")) }} />
      </>}
    </section> : <>
      <div className="workspace-library-controls"><label className="workspace-content-search"><Icon name="search" /><input aria-label="搜索本机技能" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、用途或来源" /></label><label className="workspace-local-filter">来源<select aria-label="技能来源" value={source} onChange={event => setSource(event.target.value)}><option value="all">全部目录</option>{snapshot?.roots.filter(root => root.exists).map(root => <option key={root.id} value={root.id}>{root.label}</option>)}</select></label></div>
      {loading && !snapshot ? <p role="status">正在扫描本机技能目录…</p> : !snapshot && error ? <p className="workspace-content-loading">请根据提示修正后刷新目录。</p> : filtered.length ? <div className="workspace-library-list">{filtered.map(skill => <button type="button" className="workspace-library-item" key={skill.id} onClick={() => setSelected(skill.id)}><span className="workspace-library-item-icon"><Icon name="sparkles" /></span><span className="workspace-library-item-copy"><strong>{skill.name}</strong><span>{skill.description || "打开查看技能说明"}</span><small>{[...new Set(skill.locations.map(location => location.label))].join(" · ")}{skill.issue ? " · 元数据需要检查" : ""}</small></span><Icon name="chevron-right" /></button>)}</div> : <div className="workspace-content-empty"><Icon name="sparkles" /><h2>{skills.length ? "没有匹配的技能" : "还没有发现本机技能"}</h2><p>{skills.length ? "尝试其他关键词或来源目录。" : "把已有的技能目录加入扫描，或导入一个包含 SKILL.md 的本地文件夹。"}</p>{skills.length > 0 && <button type="button" className="header-button workspace-outline-button" onClick={() => { setQuery(""); setSource("all"); }}>清除筛选</button>}</div>}
    </>}
    {snapshot && <details className="workspace-local-roots"><summary>技能目录 · {snapshot.roots.filter(root => root.exists).length} 个可用</summary><ul>{snapshot.roots.map(root => <li key={root.id}><div><strong>{root.label}</strong><span>{root.exists ? "已发现" : "尚未创建"}</span><code>{root.path}</code></div>{root.custom && <button type="button" className="text-button" disabled={busy || loading} onClick={() => void resource.removeDirectory(root.id)}>移除扫描</button>}</li>)}</ul></details>}
    {snapshot?.warnings.length ? <details className="workspace-local-warnings"><summary>扫描提示 · {snapshot.warnings.length}</summary><ul>{snapshot.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
    <div className="workspace-local-legacy"><button type="button" className="text-button" onClick={() => { setLegacyOpened(true); setLegacy(true); }}>查看远程小 D 的技能记录<Icon name="arrow-up-right" /></button></div>
  </section></>;
}
