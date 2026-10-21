export type ImportantRules = { dm?: boolean; mention?: boolean; senders?: string[]; keywords?: string[] };
export type RuleInput = { chatType: string; senderId?: string; senderName?: string; text: string; mentionsMe: boolean };

// 命中任一规则即重要；规则为空时默认只转发私聊。
export function isImportant(rules: ImportantRules | undefined, input: RuleInput): boolean {
  const { dm, mention, senders = [], keywords = [] } = rules ?? { dm: true };
  if (dm && input.chatType === "oneOnOne") return true;
  if (mention && input.mentionsMe) return true;
  const sender = [input.senderId, input.senderName].filter(Boolean).map(value => value!.toLowerCase());
  if (senders.some(item => sender.includes(item.toLowerCase()))) return true;
  const text = input.text.toLowerCase();
  return keywords.some(word => word && text.includes(word.toLowerCase()));
}
