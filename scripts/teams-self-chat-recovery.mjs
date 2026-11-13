#!/usr/bin/env node
import { openSelfChatRecovery } from "../apps/server/dist/teams-self-chat-recovery.js";

const [dir, accountId, action, sourceId, expectedState] = process.argv.slice(2);
if (!dir || !accountId || !["status", "retry", "skip"].includes(action)
    || (action !== "status" && (!sourceId || !expectedState))) {
  console.error("用法: node scripts/teams-self-chat-recovery.mjs <DATA_DIR> <Graph用户ID> status|retry|skip [源消息ID] [当前状态]");
  process.exitCode = 1;
} else {
  try {
    const recovery = openSelfChatRecovery(dir, accountId);
    try {
      if (action !== "status") recovery.resolve(sourceId, expectedState, action);
      console.log(JSON.stringify(recovery.status(), null, 2));
    } finally { recovery.close(); }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "自聊恢复失败");
    process.exitCode = 1;
  }
}
