import type { TeamsReadPort } from "@assistant/features";
import type { TeamsStore } from "./teams-store.js";
import type { TeamsSender } from "./teams-reply-port.js";
import { readArchivedMedia } from "./teams-media.js";
import { teamsRecords } from "./teams-records.js";

export function createTeamsReadPort(store: TeamsStore, sender: TeamsSender, offline: boolean): TeamsReadPort {
  return async query => {
    if (query.kind === "media") return readArchivedMedia(store.archive, query.id);
    if (query.kind === "archiveStatus") return { data: store.archive.status() };
    if (query.kind === "archive") {
      const data = store.archive.search({ ...query, limit: Math.min(50, Math.max(1, query.limit ?? 20)) });
      return { data: { ...data, sync: store.archive.status() }, media: data.items.flatMap(item => item.archiveMedia), records: teamsRecords(store.archive, data.items) };
    }
    if (offline || !sender.read) throw new Error("Teams 在线读取未启用，仍可用 teams_archive 查询数据库归档");
    return sender.read(query);
  };
}
