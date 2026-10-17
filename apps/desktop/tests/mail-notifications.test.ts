import test from "node:test";
import assert from "node:assert/strict";
import { startMailNotifications } from "../dist/mail-notifications.js";

test("桌面邮件提醒跳过启动前历史、合并本批、停止后不再读取", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const cursors: number[] = [], sent: string[] = [];
  const stop = startMailNotifications(after => {
    cursors.push(after);
    return after === 0 ? { latest: 10, items: [] } : after === 10 ? { latest: 12, items: [11, 12].map(sequence => ({ sequence,
      message: { id: String(sequence), sender: "张三", subject: `主题${sequence}`, receivedAt: "", address: "", preview: "", isRead: false, hasAttachments: false } })) } : { latest: 12, items: [] };
  }, (title, body) => sent.push(title + "|" + body));
  t.mock.timers.tick(15000); assert.deepEqual(sent, ["Outlook · 2 封新邮件|张三：主题12"]);
  t.mock.timers.tick(15000); assert.deepEqual(cursors, [0, 10, 12]); assert.equal(sent.length, 1);
  stop(); t.mock.timers.tick(15000); assert.equal(cursors.length, 3);
});
