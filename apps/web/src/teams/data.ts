import type { TeamsSyncSettings, TeamsTriageActionResult, TeamsTriageOverview } from "@assistant/contracts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: Record<string, unknown>, keys: string[]) { return keys.every(key => typeof value[key] === "string"); }
function timestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }

export function isTeamsSyncSettings(value: unknown): value is TeamsSyncSettings {
  return record(value) && typeof value.enabled === "boolean" && strings(value, ["timeZone", "workStart", "workEnd"]) &&
    Array.isArray(value.workDays) && value.workDays.every(day => Number.isInteger(day) && day >= 1 && day <= 7) &&
    ["workIntervalMinutes", "offHoursIntervalMinutes", "archiveIntervalMinutes", "normalDigestMinutes"].every(key => typeof value[key] === "number" && Number.isInteger(value[key]) && value[key] > 0);
}

export function isTeamsTriageOverview(value: unknown): value is TeamsTriageOverview {
  return record(value) && typeof value.enabled === "boolean" && typeof value.stale === "boolean" && typeof value.truncated === "boolean" &&
    (value.lastSuccessAt === null || timestamp(value.lastSuccessAt)) && isTeamsSyncSettings(value.settings) && Array.isArray(value.items) && value.items.every(item =>
      record(item) && strings(item, ["id", "chatId", "chatLabel", "senderName", "text", "reason", "uncertainty", "suggestedTitle"]) &&
      Number.isSafeInteger(item.revision) && (item.revision as number) >= 0 && timestamp(item.createdAt) &&
      ["now", "later", "unclear"].includes(String(item.attention)) && typeof item.suggestTodo === "boolean" &&
      (item.sourceUrl === undefined || typeof item.sourceUrl === "string"));
}

export function isTeamsTriageActionResult(value: unknown): value is TeamsTriageActionResult {
  return record(value) && value.ok === true && (value.taskId === undefined || (typeof value.taskId === "string" && value.taskId.length > 0));
}

export function teamsSourceUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && ["teams.microsoft.com", "teams.cloud.microsoft"].includes(url.hostname) && !url.username && !url.password && !url.port) return url.href;
  } catch { /* Invalid source links remain plain text, never navigable. */ }
}
