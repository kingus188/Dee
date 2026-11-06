import { useLayoutEffect, useRef } from "react";
import type { SlashCommand } from "./commands.js";

export function CommandMenu({ commands, selected, busy, help, onSelect, onClose }: {
  commands: readonly SlashCommand[]; selected: number; busy: boolean; help: boolean;
  onSelect: (command: SlashCommand) => void; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = menu.current, option = container?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!container || !option) return;
    const viewport = container.getBoundingClientRect(), row = option.getBoundingClientRect();
    if (!viewport.height) return;
    // Scroll only this popup. scrollIntoView can move the composer/page while
    // keyboard focus is deliberately retained in the input's combobox.
    if (row.top < viewport.top) container.scrollTop += row.top - viewport.top;
    else if (row.bottom > viewport.bottom) container.scrollTop += row.bottom - viewport.bottom;
  }, [selected, commands]);
  return <div ref={menu} className="command-menu">
    <div className="command-menu-heading"><span>{help ? "快捷指令" : "选择指令"}</span><button type="button" aria-label="关闭快捷指令" onClick={onClose}>Esc</button></div>
    <div id="composer-commands" role="listbox" aria-label="快捷指令">
      {commands.map((command, index) => <button type="button" role="option" id={`command-${command.name}`} key={command.name}
        aria-selected={selected === index} aria-disabled={busy && !command.duringReply}
        onMouseDown={event => event.preventDefault()} onClick={() => onSelect(command)}>
        <code>/{command.name}</code><span>{busy && !command.duringReply ? "回复中，请先 /stop" : command.description}</span>
      </button>)}
    </div>
    <p>↑↓ 选择 · Tab 补全 · Enter 执行 · Shift + Enter 换行</p>
  </div>;
}
