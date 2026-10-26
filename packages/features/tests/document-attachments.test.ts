import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import * as features from "@assistant/features";

type ParserOptions = { commands?: { pdftotext?: string; unzip?: string; xsltproc?: string }; timeoutMs?: number; tempRoot?: string };
type Parser = (raw: unknown, options?: ParserOptions) => Promise<features.Attachment[]>;
function parser(): Parser {
	assert.equal(typeof (features as unknown as { parseAttachmentsAsync?: Parser }).parseAttachmentsAsync, "function", "缺少异步文档附件解析入口");
	return (features as unknown as { parseAttachmentsAsync: Parser }).parseAttachmentsAsync;
}
const upload = (name: string, data: Buffer, mimeType = "") => ({ name, mimeType, data: data.toString("base64") });
function pdf(pages: string[]) {
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
	for (let i = 0; i < pages.length; i++) {
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
		const stream = `BT /F1 12 Tf 72 720 Td (${pages[i].replace(/[()\\]/g, "\\$&")}) Tj ET`;
		objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
	}
	let text = "%PDF-1.4\n";
	const offsets = [0];
	for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
	const start = Buffer.byteLength(text);
	text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${start}\n%%EOF\n`;
	return Buffer.from(text);
}
function crc32(bytes: Buffer) {
	let crc = 0xffffffff;
	for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
	return (crc ^ 0xffffffff) >>> 0;
}
function docx(xml: string, opts: { encrypted?: boolean; inflatedSize?: number; corrupt?: boolean } = {}) {
	const entries = [["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'], ["word/document.xml", xml]];
	const local: Buffer[] = [], central: Buffer[] = [];
	let offset = 0;
	for (const [name, text] of entries) {
		const data = Buffer.from(text), packed = deflateRawSync(data), filename = Buffer.from(name);
		const flag = opts.encrypted ? 1 : 0, size = name === "word/document.xml" ? opts.inflatedSize ?? data.length : data.length;
		const checksum = crc32(data) ^ (opts.corrupt ? 1 : 0);
		const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(flag, 6); head.writeUInt16LE(8, 8); head.writeUInt32LE(checksum >>> 0, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(size, 22); head.writeUInt16LE(filename.length, 26);
		local.push(head, filename, packed);
		const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(flag, 8); dir.writeUInt16LE(8, 10); dir.writeUInt32LE(checksum >>> 0, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(size, 24); dir.writeUInt16LE(filename.length, 28); dir.writeUInt32LE(offset, 42);
		central.push(dir, filename); offset += head.length + filename.length + packed.length;
	}
	const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;

test("PDF 文本按真实页码进入模型，旧图文和摘要兼容", async () => {
	const bytes = pdf(["First page evidence", "Second page evidence"]);
	const files = await parser()([upload("../report.pdf", bytes, "application/pdf"), upload("note.md", Buffer.from("原有文本"))]);
	assert.equal(files[0].kind, "text"); assert.equal(files[0].mimeType, "application/pdf");
	const content = features.buildUserContent("请总结", files);
	assert.ok(Array.isArray(content));
	const model = JSON.stringify(content);
	assert.match(model, /report\.pdf.*第 1 页/); assert.match(model, /第 2 页/);
	assert.match(model, /First page evidence/); assert.match(model, /Second page evidence/);
	assert.equal(features.splitUserContent(content).text, "请总结");
	assert.equal(features.splitUserContent(content).attachments[0].size, bytes.length);
	assert.equal(files[1].kind === "text" && files[1].text, "原有文本");
	const [sparse] = await parser()([upload("blank-page.pdf", pdf(["First", "", "Third"]))]);
	assert.equal(sparse.kind, "text");
	if (sparse.kind === "text") { assert.match(sparse.text, /第 3 页/); assert.doesNotMatch(sparse.text, /第 2 页/); }
});

test("DOCX 保留原始段序、分散文字、实体、制表符和表格段落", async () => {
	const bytes = docx(xml('<w:p><w:r><w:t>审批 &amp; 流程</w:t></w:r><w:r><w:t>第一段</w:t></w:r></w:p><w:p/><w:tbl><w:tr><w:tc><w:p><w:r><w:t>第二处</w:t><w:tab/><w:t>证据</w:t><w:br/><w:t>下一行</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'));
	const [file] = await parser()([upload("policy.docx", bytes)]);
	assert.equal(file.kind, "text");
	if (file.kind !== "text") return;
	assert.match(file.text, /policy\.docx · 第 1 段/); assert.match(file.text, /审批 & 流程第一段/);
	assert.match(file.text, /第 3 段/); assert.match(file.text, /第二处\t证据\n下一行/);
	assert.doesNotMatch(file.text, /<w:/);
});

test("文档伪装、畸形、加密、空提取、压缩炸弹与 CRC 失败均显式报错", async () => {
	const parse = parser();
	for (const item of [upload("bad.pdf", Buffer.from("text"), "application/pdf"), upload("bad.docx", Buffer.from("text")), upload("bad.pdf", Buffer.from("%PDF-1.7\nbroken")), upload("empty.pdf", pdf([""])), upload("empty.docx", docx(xml("<w:p/>"))), upload("encrypted.docx", docx(xml("<w:p/>"), { encrypted: true })), upload("bomb.docx", docx(xml("<w:p/>"), { inflatedSize: 30 * 1024 * 1024 })), upload("crc.docx", docx(xml("<w:p/>"), { corrupt: true })), upload("xml.docx", docx(xml("<w:p>")))]) {
		await assert.rejects(() => parse([item]), error => error instanceof features.AttachmentError && /附件/.test(error.message));
	}
	await assert.rejects(() => parse([upload("encrypted.pdf", Buffer.from("%PDF-1.7\ntrailer << /Encrypt 5 0 R >>"))]), /加密 PDF/);
	await assert.rejects(() => parse([upload("xxe.docx", docx('<!DOCTYPE document [<!ENTITY bad SYSTEM "file:///not-read">]>' + xml('<w:p><w:r><w:t>&bad;</w:t></w:r></w:p>')))]), /XML|声明|实体/);
});

test("保留文件数、大小、UTF-8 和总量限制，另有限制提取长度", async () => {
	const parse = parser();
	await assert.rejects(() => parse([upload("large.pdf", Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.alloc(5 * 1024 * 1024)]))]), /5MB/);
	await assert.rejects(() => parse([upload("large.pdf", pdf(Array(1500).fill("bounded evidence ".repeat(8))))]), /提取|长度/);
	await assert.rejects(() => parse([upload("bad.txt", Buffer.from([0xff]))]), /UTF-8/);
	const many = Array(6).fill(upload("a.txt", Buffer.from("a")));
	await assert.rejects(() => parse(many), /最多/);
	const total = Array(3).fill(upload("large.pdf", Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.alloc(4 * 1024 * 1024)])));
	await assert.rejects(() => parse(total), /总大小/);
});

test("解析器缺失、超时及成功失败路径都清理临时文件", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-document-test-"));
	try {
		const parse = parser(), item = upload("report.pdf", pdf(["evidence"]));
		await assert.rejects(() => parse([item], { tempRoot: root, commands: { pdftotext: join(root, "missing") } }), /附件.*解析器.*缺少/);
		assert.deepEqual(await readdir(root), []);
		const slow = join(root, "slow-parser");
		await writeFile(slow, '#!/bin/sh\nexec /bin/sleep 10\n', { mode: 0o700 });
		await assert.rejects(() => parse([item], { tempRoot: root, timeoutMs: 50, commands: { pdftotext: slow } }), /附件.*超时/);
		assert.deepEqual(await readdir(root), ["slow-parser"]);
		await parse([item], { tempRoot: root });
		assert.deepEqual(await readdir(root), ["slow-parser"]);
	} finally { await rm(root, { recursive: true, force: true }); }
});
