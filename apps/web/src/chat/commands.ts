export const slashCommands = [
  { name: "new", description: "新建对话，保留旧记录", duringReply: false },
  { name: "help", description: "显示快捷指令说明", duringReply: true },
  { name: "stop", description: "停止当前回复", duringReply: true },
] as const;

export type SlashCommand = typeof slashCommands[number];

// 只识别独占一行的指令；粘贴的多行文本和 /path/to/file 仍是普通消息。
export function parseCommand(text: string) {
  const match = /^\/([a-z][a-z0-9-]*)(?:[ \t]+(.*))?$/i.exec(text.trim());
  return match ? { name: match[1].toLowerCase(), args: match[2] ?? "" } : null;
}

export function commandSuggestions(text: string): readonly SlashCommand[] {
  const input = text.trim();
  if (!/^\/[a-z]*$/i.test(input)) return [];
  return slashCommands.filter(command => command.name.startsWith(input.slice(1).toLowerCase()));
}
