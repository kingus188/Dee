export type InsertKind = "link" | "image" | "inline-math";
interface Props {
  blocked: boolean;
  source: boolean;
  imageFiles: boolean;
  command: (action: string) => void;
  insert: (kind: InsertKind) => void;
  imageFile: () => void;
  toggleSource: () => void;
}
export function LaneToolbar({ blocked, source, imageFiles, command, insert, imageFile, toggleSource }: Props) {
  const locked = blocked || source;
  function button(label: string, action: string) {
    return <button type="button" key={action} disabled={locked} onMouseDown={event => event.preventDefault()} onClick={() => command(action)}>{label}</button>;
  }
  return <div hidden className="markdown-editor-toolbar lane-toolbar" role="toolbar" aria-label="Markdown 格式">
    {button("撤销", "undo")}{button("重做", "redo")}
    <select aria-label="段落格式" value="" disabled={locked} onChange={event => command(event.target.value)}>
      <option value="">段落</option><option value="heading-0">正文</option>{[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={`heading-${level}`}>标题 {level}</option>)}
    </select>
    {[["粗体", "bold"], ["斜体", "italic"], ["删除线", "strike"], ["行内代码", "inline-code"], ["引用", "quote"], ["无序列表", "unordered-list"], ["有序列表", "ordered-list"], ["任务列表", "task-list"]].map(([label, action]) => button(label!, action!))}
    <details className="lane-insert-menu"><summary aria-label="插入内容">＋</summary><div>
      {([ ["链接", "link"], ["图片地址", "image"], ["行内公式", "inline-math"] ] as const).map(([label, kind]) => <button key={kind} type="button" disabled={locked} onMouseDown={event => event.preventDefault()} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); insert(kind); }}>{label}</button>)}
      {[["表格", "table"], ["代码块", "code"], ["公式", "math-block"], ["分隔线", "hr"], ["脚注", "footnote"], ["文档元信息", "yaml"]].map(([label, action]) => button(label!, action!))}
      {imageFiles && <button type="button" disabled={blocked} onClick={imageFile}>本机图片</button>}
    </div></details>
    <span className="lane-toolbar-spacer" />
    <button type="button" disabled={blocked} aria-pressed={source} onClick={toggleSource}>{source ? "返回文档" : "Markdown 源码"}</button>
  </div>;
}
