import type { SlashCommand } from "./commands.js";

export function CommandMenu({ commands, selected, busy, help, onSelect, onClose }: {
  commands: readonly SlashCommand[]; selected: number; busy: boolean; help: boolean;
  onSelect: (command: SlashCommand) => void; onClose: () => void;
}) {
  return <div className="command-menu">
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
