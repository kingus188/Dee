import type { DaylightSnapshot, PersonalData, WorkspaceActivities, WorkspaceMail } from "@assistant/contracts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function fields(value: Record<string, unknown>, names: string[]): boolean { return names.every(name => typeof value[name] === "string"); }
function nullableTime(value: unknown): boolean { return value === null || finite(value); }
function decision(value: unknown): value is Record<string, unknown> {
  return record(value) && typeof value.id === "string" && ["pending", "approved", "rejected"].includes(String(value.status)) && ["user", "agent"].includes(String(value.source)) && finite(value.createdAt) && nullableTime(value.decidedAt);
}

export function isDaylightSnapshot(value: unknown): value is DaylightSnapshot {
  if (!record(value) || !Array.isArray(value.projects) || !Array.isArray(value.tasks)) return false;
  return value.projects.every(item => record(item) && fields(item, ["id", "name", "description", "color"])) && value.tasks.every(item =>
    record(item) && fields(item, ["id", "projectId", "title", "description", "priority", "color"]) && ["todo", "doing", "review", "done"].includes(String(item.status)) &&
    (item.dueDate === null || (typeof item.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate))) && strings(item.tags) && finite(item.createdAt) && finite(item.position) &&
    Array.isArray(item.checklist) && item.checklist.every(check => record(check) && fields(check, ["id", "title"]) && typeof check.done === "boolean"));
}

export function isPersonalData(value: unknown): value is PersonalData {
  return record(value) && Array.isArray(value.memory) && value.memory.every(item => decision(item) && typeof item.text === "string") &&
    Array.isArray(value.skills) && value.skills.every(item => decision(item) && fields(item, ["name", "description", "body"])) &&
    record(value.knowledge) && typeof value.knowledge.enabled === "boolean" && strings(value.knowledge.allow);
}

export function isWorkspaceActivities(value: unknown): value is WorkspaceActivities {
  return record(value) && Array.isArray(value.items) && finite(value.total) && value.total >= value.items.length && typeof value.truncated === "boolean" && value.items.every(item =>
    record(item) && fields(item, ["id", "conversationTitle", "text", "status"]) && ["reminder", "schedule", "background"].includes(String(item.kind)) &&
    finite(item.conversationId) && Number.isSafeInteger(item.conversationId) && item.conversationId > 0 && nullableTime(item.at) && finite(item.createdAt) &&
    (item.result === undefined || item.result === null || typeof item.result === "string"));
}

export function isWorkspaceMail(value: unknown): value is WorkspaceMail {
  if (!record(value) || !record(value.status) || !Array.isArray(value.messages)) return false;
  const status = value.status;
  return ["enabled", "connected", "offline", "syncing"].every(key => typeof status[key] === "boolean") && typeof status.error === "string" &&
    (status.lastSuccessAt === null || typeof status.lastSuccessAt === "string") && value.messages.every(item =>
      record(item) && fields(item, ["id", "subject", "sender", "address", "receivedAt", "preview"]) && typeof item.isRead === "boolean" && typeof item.hasAttachments === "boolean");
}
