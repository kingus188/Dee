import type { DatabaseSync } from "node:sqlite";
import type { TeamsSyncSettings, TeamsTriageItem } from "@assistant/contracts";
import { createSourceLifecycle } from "./source-lifecycle.js";
import { defaultTeamsSyncSettings, validateTeamsSyncSettings } from "./teams-sync-policy.js";

export function safeTeamsSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && ["teams.microsoft.com", "teams.cloud.microsoft"].includes(url.hostname) && !url.username && !url.password && !url.port) return url.href;
  } catch { /* A missing or unsafe link does not hide the locally verified source. */ }
}

/** Rules suggest a review, never infer ownership, a deadline or task completion. */
export function classifyTeamsRequest(text: string, directed: boolean, priority?: string) {
  const request = /(?:请|麻烦|帮忙|需要你|能否|可以.{0,8}吗|你.{0,8}(?:能|负责|处理)|\b(?:please|could you|can you|would you|need you to)\b)/i.test(text);
  const action = /确认|检查|核对|审批|评审|审核|处理|提交|提供|整理|回复|修复|排查|完成|发给|发送|更新|看一下|看看|\b(?:review|check|approve|send|fix|investigate|update|reply|confirm|submit|provide)\b/i.test(text);
  const negative = /无需|不用|不必|不要|不用回复|仅供参考|供参考|\b(?:fyi|no action|no need|do not|don't)\b/i.test(text);
  const suggestTodo = directed && request && action && !negative;
  const urgent = suggestTodo && priority === "urgent";
  const timeSignal = /马上|立即|尽快|截止|之前|今天|明天|紧急|\b(?:asap|urgent|deadline|today|tomorrow|immediately|before|by\s+\d)\b/i.test(text);
  return {
    attention: urgent ? "now" as const : suggestTodo && !timeSignal ? "later" as const : "unclear" as const,
    suggestTodo,
    reason: urgent ? "对方标记了高优先级，且消息中有面向你的行动请求，建议优先核对。"
      : suggestTodo && timeSignal ? "消息中有行动请求和时效词，但紧迫程度或具体截止尚未核实，请先核对原文。"
      : suggestTodo ? "消息中有面向你的行动请求，可以确认后记为待办；规则未找到可靠的即时处理依据，不代表一定不急。"
      : "尚不能确认这条消息需要你采取行动，不自动记为待办。",
    uncertainty: "规则初筛，不是确定的紧急度或责任判断；未回复不代表未完成，截止时间请核对原文。",
  };
}

/** Stores only review decisions and identifiers; suggestion text stays source-bound. */
export function createTeamsTriageStore(db: DatabaseSync) {
  const sources = createSourceLifecycle(db);
  db.exec(`CREATE TABLE IF NOT EXISTS teams_triage_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS teams_triage_actions (message_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, until_at INTEGER, task_id TEXT);
    CREATE TABLE IF NOT EXISTS teams_chat_access (chat_id TEXT PRIMARY KEY, available INTEGER NOT NULL);`);
  const settings = (): TeamsSyncSettings => {
    const saved = db.prepare("SELECT value FROM teams_triage_settings WHERE id=1").get();
    return validateTeamsSyncSettings(saved ? JSON.parse(String(saved.value)) : defaultTeamsSyncSettings);
  };
  const candidates = `SELECT m.*,COALESCE(s.revision,0) AS revision FROM visible_teams_messages m
    LEFT JOIN source_lifecycle s ON s.source='teams:'||m.chat_id
    WHERE m.direction='in' AND m.important=1 AND m.replied_at IS NULL AND m.notification_cancelled_at IS NULL
      AND m.created_at>=? AND m.created_at<=?
      AND NOT EXISTS (SELECT 1 FROM teams_chat_access a WHERE a.chat_id=m.chat_id AND a.available=0)
      AND NOT EXISTS (SELECT 1 FROM teams_triage_actions a WHERE a.message_id=m.id AND
        (a.state IN ('created','dismissed') OR a.until_at>?))`;
  const item = (row: Record<string, unknown>): TeamsTriageItem => ({
    id: String(row.id), revision: Number(row.revision), chatId: String(row.chat_id),
    chatLabel: row.chat_type === "oneOnOne" ? `私聊「${row.sender_name}」` : `群聊「${row.chat_topic || "未命名"}」`,
    senderName: String(row.sender_name), createdAt: String(row.created_at), text: String(row.text).slice(0, 1600),
    sourceUrl: safeTeamsSourceUrl(row.source_url),
    ...classifyTeamsRequest(String(row.text), row.chat_type === "oneOnOne" || row.addressed_to_me === 1, String(row.notification_priority)),
    // Do not copy third-party text into an independently retained task. The user
    // can add their own description after confirmation in Daylight.
    suggestedTitle: `跟进 Teams 请求（${String(row.created_at).slice(0, 16).replace("T", " ")} UTC）`,
  });
  function list() {
    const now = Date.now();
    const rows = db.prepare(candidates + " ORDER BY m.created_at DESC,m.id LIMIT 101")
      .all(new Date(now - 86400_000).toISOString(), new Date(now).toISOString(), now);
    const items = rows.slice(0, 100).map(item);
    const order = { now: 0, later: 1, unclear: 2 };
    items.sort((a, b) => order[a.attention] - order[b.attention] || b.createdAt.localeCompare(a.createdAt));
    return { items, truncated: rows.length > 100 };
  }
  const access = (chatId: string, available: boolean) => {
    const old = db.prepare("SELECT available FROM teams_chat_access WHERE chat_id=?").get(chatId);
    if (!available && old?.available !== 0) sources.invalidate(`teams:${chatId}`);
    db.prepare("INSERT INTO teams_chat_access(chat_id,available) VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET available=excluded.available").run(chatId, available ? 1 : 0);
  };
  return {
    settings,
    saveSettings(input: unknown) {
      const value = validateTeamsSyncSettings(input);
      db.prepare("INSERT INTO teams_triage_settings(id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
      return value;
    },
    list,
    find(id: string) { return list().items.find(item => item.id === id); },
    created(id: string) { const row = db.prepare("SELECT task_id FROM teams_triage_actions WHERE message_id=? AND state='created'").get(id); return row?.task_id ? String(row.task_id) : undefined; },
    decide(id: string, revision: number, state: "created" | "dismissed" | "snoozed", taskId?: string) {
      db.prepare(`INSERT INTO teams_triage_actions(message_id,revision,state,until_at,task_id) VALUES (?,?,?,?,?)
        ON CONFLICT(message_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,until_at=excluded.until_at,task_id=excluded.task_id
        WHERE teams_triage_actions.state!='created'`).run(id, revision, state, state === "snoozed" ? Date.now() + 2 * 3600_000 : null, taskId ?? null);
    },
    access,
    reconcileChats(ids: readonly string[]) {
      const visible = new Set(ids);
      for (const row of db.prepare("SELECT DISTINCT chat_id FROM teams_messages").all()) {
        if (!visible.has(String(row.chat_id))) access(String(row.chat_id), false);
      }
    },
  };
}
