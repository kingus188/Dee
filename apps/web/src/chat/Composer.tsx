import { useEffect, useRef, useState } from "react";
import type { ConversationView } from "@assistant/contracts";
import type { PendingAttachment } from "../types.js";
import { sendMessage, abortConversation } from "../api/chat.js";
import { processAttachmentFile } from "./attachments.js";
import { formatFileSize, generateUuid } from "../ui/format.js";
import { showToast } from "../ui/toast.js";
import { Icon } from "../ui/Icon.js";
import { commandSuggestions, parseCommand, slashCommands } from "./commands.js";
import { CommandMenu } from "./CommandMenu.js";

export function Composer({ draft, setDraft, view, connect, onSent, onNewConversation }: {
  draft: string; setDraft: (text: string) => void; view: ConversationView | null;
  connect: () => Promise<number>; onSent: () => void; onNewConversation: () => Promise<void>;
}) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [help, setHelp] = useState(false), [menuDismissed, dismissMenu] = useState(false), [selected, setSelected] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const files = useRef<PendingAttachment[]>([]), draftRef = useRef(draft);
  const composing = useRef(false), sendingRef = useRef(false), processingRef = useRef(false);
  const mounted = useRef(true);
  const retry = useRef<{ payload: string; requestId: string } | null>(null);
  draftRef.current = draft;
  useEffect(() => { const input = textarea.current!; input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; setSelected(0); dismissMenu(false); }, [draft]);
  useEffect(() => () => { mounted.current = false; for (const file of files.current) if (file.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(file.previewUrl); }, []);
  function updateFiles(next: PendingAttachment[]) { files.current = next; setAttachments(next); }
  function remove(file: PendingAttachment) {
    if (file.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(file.previewUrl);
    updateFiles(files.current.filter(item => item !== file));
  }
  async function addFiles(list: FileList | File[]) {
    if (processingRef.current) return;
    processingRef.current = true; setProcessing(true);
    try {
      for (const file of Array.from(list)) {
        if (files.current.length >= 5) { showToast("一次最多上传 5 个附件", "warning"); break; }
        const result = await processAttachmentFile(file);
        if (!mounted.current) {
          if (!("error" in result) && result.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(result.previewUrl);
          return;
        }
        if ("error" in result) { showToast(result.error, "warning"); continue; }
        if (files.current.reduce((sum, item) => sum + item.size, 0) + result.size > 10 * 1024 * 1024) {
          if (result.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(result.previewUrl);
          showToast("附件总大小不能超过 10MB", "warning"); continue;
        }
        updateFiles([...files.current, result]);
      }
    } catch (error) { showToast(error instanceof Error ? error.message : "文件处理失败", "error"); }
    finally { processingRef.current = false; if (mounted.current) setProcessing(false); }
  }
  const busy = !!view?.busy || !!Object.keys(view?.live ?? {}).length || !!view?.inbox;
  const suggestions = help && !draft.trim() ? slashCommands : commandSuggestions(draft);
  const menuVisible = !menuDismissed && suggestions.length > 0;
  const selectedIndex = Math.min(selected, suggestions.length - 1);
  async function stopReply() {
    if (!busy || !view) { showToast("当前没有正在生成的回复"); return; }
    await abortConversation(view.conversationId);
  }
  async function submit(commandText?: string) {
    const original = draftRef.current;
    const text = commandText ?? (menuVisible && original.trim() ? `/${suggestions[selectedIndex].name}` : original.trim());
    const sentFiles = [...files.current];
    if (sendingRef.current || processingRef.current || (!text && !sentFiles.length)) return;
    const command = parseCommand(text);
    sendingRef.current = true; setSending(true);
    try {
      if (command) {
        const definition = slashCommands.find(item => item.name === command.name);
        if (!definition) throw new Error("未知快捷指令，输入 /help 查看可用指令");
        if (command.args) throw new Error(`请单独输入 /${command.name}，这条指令不接受参数`);
        if (sentFiles.length) throw new Error("请先发送或移除附件，再执行快捷指令");
        if (busy && !definition.duringReply) throw new Error("小 D 正在回复，请先用 /stop 停止，再新建对话");
        if (command.name === "new") {
          await onNewConversation(); retry.current = null; setHelp(false);
          showToast("已开启新对话，旧记录仍保留");
        } else if (command.name === "help") setHelp(true);
        else await stopReply();
      } else {
        const body = { text, mode: "steer" as const, attachments: sentFiles.map(({ name, mimeType, data }) => ({ name, mimeType, data })) };
        const payload = JSON.stringify(body);
        if (retry.current?.payload !== payload) retry.current = { payload, requestId: generateUuid() };
        await sendMessage(await connect(), { ...body, requestId: retry.current.requestId });
        retry.current = null; onSent(); setHelp(false);
        for (const file of sentFiles) remove(file);
      }
      if (draftRef.current === original) setDraft("");
    } catch (error) { showToast((command ? "指令未完成：" : "发送未确认：") + (error instanceof Error ? error.message : String(error)), "error"); }
    finally { sendingRef.current = false; if (mounted.current) setSending(false); }
  }
  return <div className="input-box-wrapper" data-dragging={dragging} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) dismissMenu(true); }} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void addFiles(event.dataTransfer.files); }}>
    {menuVisible && <CommandMenu commands={suggestions} selected={selectedIndex} busy={busy} help={help && !draft.trim()} onSelect={command => { void submit(`/${command.name}`); textarea.current?.focus(); }} onClose={() => { dismissMenu(true); textarea.current?.focus(); }} />}
    {dragging && <p role="status">松开以添加图片或文本文件</p>}
    {!!attachments.length && <div className="attachments-preview">{attachments.map((file, i) => <div className="pending-chip" key={i}>
      {file.previewUrl && <img className="pending-thumb" src={file.previewUrl} alt={file.name} />}
      <div className="pending-meta"><span className="pending-name">{file.name}</span><span className="pending-size">{formatFileSize(file.size)}</span></div>
      <button type="button" className="btn-remove-pending" aria-label={`移除 ${file.name}`} onClick={() => remove(file)}>×</button>
    </div>)}</div>}
    <div className="composer-main"><textarea ref={textarea} className="chat-textarea" id="chat-textarea" aria-label="给小 D 发消息" role="combobox" aria-autocomplete="list" aria-expanded={menuVisible} aria-controls={menuVisible ? "composer-commands" : undefined} aria-activedescendant={menuVisible ? `command-${suggestions[selectedIndex].name}` : undefined} placeholder="说说你的想法，输入 / 查看快捷指令…" rows={1} value={draft} onChange={event => setDraft(event.target.value)}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (menuVisible && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault(); setSelected((selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
        } else if (menuVisible && event.key === "Escape") { event.preventDefault(); dismissMenu(true); }
        else if (menuVisible && event.key === "Tab" && !event.shiftKey) { event.preventDefault(); setDraft(`/${suggestions[selectedIndex].name}`); }
        else if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault(); void submit(menuVisible && draft.trim() ? `/${suggestions[selectedIndex].name}` : undefined);
        }
      }}
      onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void addFiles(event.clipboardData.files); } }} />
      <div className="composer-actions">{busy && <button type="button" className="btn-abort" id="btn-abort" style={{ display: "inline-flex" }} onClick={() => { void stopReply().catch(() => showToast("暂时没能停止回复，请重试。", "error")); }}>停止</button>}
        <button type="button" className="icon-button attach-button" disabled={processing} aria-label="添加图片或文件" onClick={() => { fileInput.current!.value = ""; fileInput.current!.click(); }}><Icon name="paperclip" /></button>
        <button type="button" className="btn-send" id="btn-send" aria-label={sending ? "正在发送" : "发送消息"} aria-busy={sending} disabled={sending || processing || (!draft.trim() && !attachments.length)} onClick={() => void submit()}><Icon name="send" /></button>
      </div>
    </div>
    <input ref={fileInput} type="file" multiple className="file-input-hidden" accept="image/png,image/jpeg,image/webp,image/gif,text/*,.md,.json,.ts,.tsx,.py,.yaml,.yml,.csv,.log" onChange={event => { if (event.target.files) void addFiles(event.target.files); }} />
    {!!view?.inbox && <span className="inbox-badge" role="status">收到，马上接着说</span>}
  </div>;
}
