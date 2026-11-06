/** Background collection is independent from notification delivery and task creation. */
export type TeamsSyncSettings = {
  enabled: boolean;
  timeZone: string;
  workDays: number[];
  workStart: string;
  workEnd: string;
  workIntervalMinutes: number;
  offHoursIntervalMinutes: number;
  archiveIntervalMinutes: number;
  normalDigestMinutes: number;
};

export type TeamsTriageItem = {
  id: string;
  revision: number;
  chatId: string;
  chatLabel: string;
  senderName: string;
  createdAt: string;
  text: string;
  sourceUrl?: string;
  attention: "now" | "later" | "unclear";
  reason: string;
  uncertainty: string;
  suggestTodo: boolean;
  suggestedTitle: string;
};

export type TeamsTriageOverview = {
  enabled: boolean;
  lastSuccessAt: string | null;
  stale: boolean;
  settings: TeamsSyncSettings;
  items: TeamsTriageItem[];
  truncated: boolean;
};

export type TeamsTriageAction = { id: string; revision: number; action: "create" | "dismiss" | "snooze" };
export type TeamsTriageActionResult = { ok: true; taskId?: string };
