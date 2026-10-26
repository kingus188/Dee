import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentError } from "./error.js";
import { validateDocxZip } from "./docx-zip.js";
import { DOCUMENT_LIMITS, runParser, type DocumentParserOptions } from "./process.js";

export { DOCUMENT_LIMITS, type DocumentParserOptions } from "./process.js";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export function documentType(name: string, mimeType: string): "pdf" | "docx" | undefined {
	const ext = name.split(".").pop()?.toLowerCase();
	if (ext === "pdf" || mimeType === "application/pdf") return "pdf";
	if (ext === "docx" || mimeType === DOCX_MIME) return "docx";
}
const stylesheet = `<?xml version="1.0"?><xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:s="http://purl.oclc.org/ooxml/wordprocessingml/main"><xsl:output method="text" encoding="UTF-8"/><xsl:param name="name"/><xsl:template match="/"><xsl:for-each select="//w:p|//s:p"><xsl:if test=".//w:t[normalize-space(.)!=''] or .//s:t[normalize-space(.)!='']"><xsl:text>[</xsl:text><xsl:value-of select="$name"/><xsl:text> · 第 </xsl:text><xsl:value-of select="position()"/><xsl:text> 段]&#10;</xsl:text><xsl:apply-templates select="node()" mode="inline"/><xsl:text>&#10;&#10;</xsl:text></xsl:if></xsl:for-each></xsl:template><xsl:template match="w:t|s:t" mode="inline"><xsl:value-of select="."/></xsl:template><xsl:template match="w:tab|s:tab" mode="inline"><xsl:text>&#9;</xsl:text></xsl:template><xsl:template match="w:br|w:cr|s:br|s:cr" mode="inline"><xsl:text>&#10;</xsl:text></xsl:template><xsl:template match="w:p|s:p|text()" mode="inline"/></xsl:stylesheet>`;

export async function extractDocument(bytes: Buffer, name: string, type: "pdf" | "docx", options: DocumentParserOptions = {}) {
	if (bytes.length > DOCUMENT_LIMITS.bytes) throw new AttachmentError(`附件「${name}」超过 5MB`);
	if (type === "pdf") {
		if (!bytes.subarray(0, 8).toString("ascii").startsWith("%PDF-")) throw new AttachmentError(`附件「${name}」不是有效 PDF`);
		if (/\/Encrypt\b/.test(bytes.toString("latin1"))) throw new AttachmentError(`附件「${name}」为加密 PDF，暂不支持`);
	} else validateDocxZip(bytes, name);
	const deadline = Date.now() + Math.min(DOCUMENT_LIMITS.timeoutMs, Math.max(1, options.timeoutMs ?? DOCUMENT_LIMITS.timeoutMs));
	let dir: string | undefined;
	try {
		dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), "pi-attachment-"));
		const input = join(dir, `document.${type}`);
		await writeFile(input, bytes, { mode: 0o600 });
		let text: string;
		if (type === "pdf") {
			const command = options.commands?.pdftotext ?? (existsSync("/opt/homebrew/bin/pdftotext") ? "/opt/homebrew/bin/pdftotext" : "pdftotext");
			const raw = await runParser(command, ["-enc", "UTF-8", "-layout", input, "-"], name, deadline - Date.now(), DOCUMENT_LIMITS.chars * 4);
			text = raw.toString("utf8").split("\f").map((page, i) => page.trim() ? `[${name} · 第 ${i + 1} 页]\n${page.trim()}` : "").filter(Boolean).join("\n\n");
		} else {
			const rawXml = await runParser(options.commands?.unzip ?? "/usr/bin/unzip", ["-p", input, "word/document.xml"], name, deadline - Date.now(), DOCUMENT_LIMITS.xmlBytes);
			const encoding = (rawXml[0] === 0xff && rawXml[1] === 0xfe) || (rawXml[0] === 0x3c && rawXml[1] === 0) ? "utf-16le" : (rawXml[0] === 0xfe && rawXml[1] === 0xff) || (rawXml[0] === 0 && rawXml[1] === 0x3c) ? "utf-16be" : "utf-8";
			let xml: string;
			try { xml = new TextDecoder(encoding, { fatal: true }).decode(rawXml); }
			catch { throw new AttachmentError(`附件「${name}」XML 编码畸形`); }
			// XML entity expansion and external references are excluded before invoking libxml.
			if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || xml.includes("\u0000")) throw new AttachmentError(`附件「${name}」XML 声明或实体暂不支持`);
			await writeFile(join(dir, "document.xml"), rawXml, { mode: 0o600 });
			await writeFile(join(dir, "paragraphs.xsl"), stylesheet, { mode: 0o600 });
			text = (await runParser(options.commands?.xsltproc ?? "/usr/bin/xsltproc", ["--nonet", "--novalid", "--maxdepth", "128", "--stringparam", "name", name, join(dir, "paragraphs.xsl"), join(dir, "document.xml")], name, deadline - Date.now(), DOCUMENT_LIMITS.chars * 4)).toString("utf8").trim();
		}
		if (!text.trim()) throw new AttachmentError(`附件「${name}」未提取到文本（扫描 PDF 需要 OCR；DOCX 需包含正文段落）`);
		if (text.length > DOCUMENT_LIMITS.chars) throw new AttachmentError(`附件「${name}」提取长度超过 ${DOCUMENT_LIMITS.chars} 字符`);
		return text;
	} catch (error) {
		if (error instanceof AttachmentError) throw error;
		throw new AttachmentError(`附件「${name}」解析失败：临时文件处理异常`);
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true });
	}
}
