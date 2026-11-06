import type { TeamsArchive, ArchivedChat, ArchivedMessage } from "./teams-archive-store.js";
import type { TeamsReadPort } from "@assistant/features";

// 与微信提醒分开调度，每轮有页数上限；只有已入库的页才持久推进进度。
export function createTeamsArchiveSync(archive: TeamsArchive, read: TeamsReadPort, signal?: AbortSignal) {
  let running: Promise<void> | undefined;
  async function collect() {
    signal?.throwIfAborted();
    const discovery = await read({ kind: "chats", cursor: archive.discoveryCursor() });
    const chats = discovery.data as { items: ArchivedChat[]; nextCursor: string | null };
    archive.chats(chats.items);
    archive.discoveryCursor(chats.nextCursor);
    const visited: string[] = [];
    for (let pages = 0; pages < 20; pages++) {
      signal?.throwIfAborted();
      const chat = archive.nextChat(visited);
      if (!chat) break;
      visited.push(chat.id);
      try {
        const result = await read({ kind: "history", chatId: chat.id, cursor: chat.cursor ?? undefined, archiveSync: true });
        const page = result.data as { items: ArchivedMessage[]; nextCursor: string | null };
        let newest = chat.newest;
        for (const message of page.items) {
          const time = message.lastModifiedDateTime || message.createdDateTime;
          if (!newest || time > newest) newest = time;
        }
        const since = chat.cursor ? chat.scan_floor : chat.newest;
        const caughtUp = !!chat.complete && !!since && page.items.every(m => Date.parse(m.lastModifiedDateTime || m.createdDateTime) < Date.parse(since) - 5 * 60_000);
        archive.progress(chat.id, caughtUp ? null : page.nextCursor, newest);
      } catch (error) {
        signal?.throwIfAborted();
        archive.failure(chat.id, "聊天归档尚未完成，等待重试或检查权限");
        if (error && typeof error === "object" && "retryAfterMs" in error) throw error;
      }
    }
  }
  return { refresh: () => running ??= collect().finally(() => { running = undefined; }) };
}
