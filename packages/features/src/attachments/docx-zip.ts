import { AttachmentError } from "./error.js";
import { DOCUMENT_LIMITS } from "./process.js";

// Inspect central and local headers before asking unzip to inflate a single member.
// No archive-controlled path is ever written to disk.
export function validateDocxZip(bytes: Buffer, name: string) {
	const fail = (detail: string): never => { throw new AttachmentError(`附件「${name}」DOCX ${detail}`); };
	let end = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
		if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
	}
	if (end < 0) fail("压缩结构畸形");
	const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
	if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || !count || count > DOCUMENT_LIMITS.entries || offset + size !== end) fail("压缩结构或文件数超过限制");
	let cursor = offset, expanded = 0;
	const names = new Set<string>(), ranges: [number, number][] = [];
	for (let i = 0; i < count; i++) {
		if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail("目录畸形");
		const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
		const packed = bytes.readUInt32LE(cursor + 20), unpacked = bytes.readUInt32LE(cursor + 24);
		const nameSize = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
		const next = cursor + 46 + nameSize + extra + comment;
		if (next > end || !nameSize || bytes.readUInt16LE(cursor + 34)) fail("目录畸形");
		let member = "";
		try { member = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameSize)); } catch { fail("文件名编码畸形"); }
		if (names.has(member) || /[\\\u0000]/.test(member) || member.startsWith("/") || member.split("/").includes("..")) fail("重复或无效路径");
		names.add(member);
		if (flags & 0x41) fail("加密文档暂不支持");
		if (![0, 8].includes(method) || packed === 0xffffffff || unpacked === 0xffffffff || local === 0xffffffff) fail("压缩格式暂不支持");
		expanded += unpacked;
		if (expanded > DOCUMENT_LIMITS.expandedBytes || unpacked > Math.max(1, packed) * 200 || (member === "word/document.xml" && unpacked > DOCUMENT_LIMITS.xmlBytes)) fail("解压长度或压缩比例超过限制");
		if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) fail("本地文件头畸形");
		const localNameSize = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
		const dataStart = local + 30 + localNameSize + localExtra, dataEnd = dataStart + packed;
		if (dataEnd > offset || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || !bytes.subarray(local + 30, local + 30 + localNameSize).equals(bytes.subarray(cursor + 46, cursor + 46 + nameSize))) fail("本地文件头不一致");
		if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== bytes.readUInt32LE(cursor + 16) || bytes.readUInt32LE(local + 18) !== packed || bytes.readUInt32LE(local + 22) !== unpacked)) fail("压缩大小或校验码不一致");
		ranges.push([local, dataEnd]);
		cursor = next;
	}
	if (cursor !== end || !names.has("word/document.xml") || !names.has("[Content_Types].xml")) fail("缺少有效正文或内容类型");
	ranges.sort((a, b) => a[0] - b[0]);
	if (ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1][1])) fail("压缩数据重叠");
}
