import test from "node:test";
import assert from "node:assert/strict";
import { buildUserContent, imageAt, parseAttachments, splitUserContent, withQuote } from "@assistant/features";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

test("图片按文件头核对类型，文本按 UTF-8 解码", () => {
  const files = parseAttachments([
    { name: "../截图.png", mimeType: "image/png", data: PNG },
    { name: "笔记.md", mimeType: "", data: b64("# 标题\n内容") },
  ]);
  assert.equal(files[0].kind, "image");
  assert.equal(files[0].name, "截图.png");
  assert.equal(files[1].kind, "text");
  assert.equal(files[1].text, "# 标题\n内容");
  assert.deepEqual(parseAttachments(undefined), []);
});

test("拒绝伪装类型、不支持的格式、非 UTF-8 和超限", () => {
  assert.throws(() => parseAttachments([{ name: "a.png", mimeType: "image/png", data: b64("not png") }]), /不符/);
  assert.throws(() => parseAttachments([{ name: "a.svg", mimeType: "image/svg+xml", data: b64("<svg/>") }]), /暂不支持/);
  assert.throws(() => parseAttachments([{ name: "a.pdf", mimeType: "application/pdf", data: b64("%PDF") }]), /暂不支持/);
  assert.throws(() => parseAttachments([{ name: "a.txt", mimeType: "text/plain", data: Buffer.from([0xff, 0xfe]).toString("base64") }]), /UTF-8/);
  assert.throws(() => parseAttachments([{ name: "a.txt", mimeType: "text/plain", data: "@@@@" }]), /base64/);
  assert.throws(() => parseAttachments([{ name: "a.txt", mimeType: "text/plain", data: b64("x".repeat(200 * 1024 + 1)) }]), /200KB/);
  assert.throws(() => parseAttachments(Array(6).fill({ name: "a.txt", data: b64("x") })), /最多/);
  assert.throws(() => parseAttachments([{ name: "", data: b64("x") }]), /文件名/);
});

test("组装后能还原正文、附件清单和图片", () => {
  const files = parseAttachments([
    { name: "a.txt", mimeType: "text/plain", data: b64("hello") },
    { name: "b.png", mimeType: "image/png", data: PNG },
  ]);
  const content = buildUserContent("看看这些", files);
  const { text, attachments } = splitUserContent(content);
  assert.equal(text, "看看这些");
  assert.deepEqual(attachments, [
    { kind: "text", name: "a.txt", mimeType: "text/plain", size: 5 },
    { kind: "image", name: "b.png", mimeType: "image/png", size: 16, index: 0 },
  ]);
  assert.equal(imageAt(content, 0)!.data, PNG);
  assert.equal(imageAt(content, 1), undefined);
  assert.equal(buildUserContent("纯文字", []), "纯文字");
  assert.deepEqual(splitUserContent("纯文字"), { text: "纯文字", attachments: [], quote: "" });
});

// 引用从授权用的 text 里剥掉，但展示和 recall 仍要看得见它。
test("引用不进用户原话，展示文本把它标回来", () => {
  const content = [{ type: "text" as const, text: "<引用>\n草稿 1 私聊「小周」\n</引用>" }, { type: "text" as const, text: "确认发送" }];
  const split = splitUserContent(content);
  assert.equal(split.text, "确认发送");
  assert.equal(split.quote, "草稿 1 私聊「小周」");
  assert.equal(withQuote(split), "[引用：草稿 1 私聊「小周」]\n确认发送");
  assert.equal(withQuote(splitUserContent("确认发送")), "确认发送");
});

test("扩展名是文本但浏览器报了别的 MIME 时按 text/plain 处理", () => {
  const [f] = parseAttachments([{ name: "main.ts", mimeType: "video/mp2t", data: b64("const a = 1;") }]);
  assert.equal(f.kind, "text");
  assert.equal(f.mimeType, "text/plain");
});
