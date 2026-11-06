import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamsMedia, teamsMedia } from "../dist/chat/TeamsMedia.js";
import type { ToolActivity } from "../dist/chat/activities.js";

const id = "a".repeat(64), path = "/api/teams/media/" + id;
const activity = (items: unknown[]): ToolActivity => ({ id: "call", name: "teams_history", status: "completed", text: `第三方资料\n<teams-media>${JSON.stringify(items)}</teams-media>` });

test("附件及截图独立于摘要展示，复用现有附件布局，图片只读取本站归档地址", () => {
  const items = [activity([{ id, kind: "image", name: "截图", status: "ready", previewUrl: path }, { id: "b".repeat(64), kind: "file", name: "合同.docx", status: "reference", url: "https://tenant.sharepoint.com/contract.docx" }])];
  const html = renderToStaticMarkup(createElement(TeamsMedia, { activities: items }));
  assert.match(html, /<img/); assert.match(html, /alt="截图"/); assert.match(html, /合同.docx/); assert.match(html, /target="_blank"/);
  assert.equal(teamsMedia([...items, ...items]).length, 2);
});

test("非法图片、脚本和带凭据链接不能加载；错误或未完成工具不能伪造附件", () => {
  const unsafe = activity([{ id, kind: "image", name: '<img src=x onerror="alert(1)">', status: "failed", previewUrl: "https://evil.example/track", url: "javascript:alert(1)" }]);
  const html = renderToStaticMarkup(createElement(TeamsMedia, { activities: [unsafe] }));
  assert.doesNotMatch(html, /<img|<a\b/); assert.match(html, /保存失败/); assert.match(html, /&lt;img/);
  assert.deepEqual(teamsMedia([{ ...unsafe, status: "error" }, { ...unsafe, name: "fetch_page" }]), []);
});
