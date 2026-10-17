import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
export type Attachment = { name: string; mimeType: string; size: number } & (
  { kind: "image"; data: string } | { kind: "text"; text: string }
);
export type AttachmentSummary = { kind: "image" | "text"; name: string; mimeType: string; size: number; index?: number; url?: string };
// 消息附件：图片原样交给模型，文本类文件解码成文字；其他类型直接拒绝，不让模型假装看过
// 每个附件在消息内容里先放一段 <附件 …> 标记文本，模型能看到文件名，前端也靠它还原附件列表

export const ATTACHMENT_LIMITS = {
	files: 5,
	imageBytes: 5 * 1024 * 1024,
	textBytes: 200 * 1024,
	totalBytes: 10 * 1024 * 1024,
};

// 图片按文件头核对类型，不信任浏览器给的 MIME；不收 SVG（可带脚本）
const IMAGE_SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
	"image/png": (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47,
	"image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
	"image/gif": (b) => b.length > 6 && b.toString("ascii", 0, 4) === "GIF8",
	"image/webp": (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
};
const TEXT_EXTENSIONS = new Set([
	"txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html", "htm", "css",
	"js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp",
	"cs", "rb", "php", "sh", "zsh", "bash", "sql", "toml", "ini", "conf", "log", "srt", "vtt",
]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MARK = /^<附件 name="([^"]*)" type="([^"]*)" size="(\d+)"(\/?)>/;
// 第三方引用（如微信「引用回复」）单独成一段，不算用户原话：授权判定只看 text。
// 产出方在 @assistant/channel-wechat 的 validateInbound，两边格式必须一致。
const QUOTE = /^<引用>\n([\s\S]*)\n<\/引用>$/;

export class AttachmentError extends Error {}

function cleanName(raw: unknown) {
	const name = String(raw ?? "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"<>]/g, "").trim().slice(0, 100);
	if (!name) throw new AttachmentError("附件缺少文件名");
	return name;
}

function decodeBase64(data: unknown, name: string) {
	if (typeof data !== "string" || !data || data.length % 4 !== 0 || !BASE64.test(data)) {
		throw new AttachmentError(`附件「${name}」不是合法的 base64 数据`);
	}
	return Buffer.from(data, "base64");
}

// 校验浏览器传来的 attachments 数组，返回 [{ kind, name, mimeType, size, data | text }]
export function parseAttachments(raw: unknown): Attachment[] {
	if (raw == null) return [];
	if (!Array.isArray(raw)) throw new AttachmentError("attachments 必须是数组");
	if (raw.length > ATTACHMENT_LIMITS.files) throw new AttachmentError(`一次最多上传 ${ATTACHMENT_LIMITS.files} 个附件`);
	let total = 0;
	return raw.map((item) => {
		const name = cleanName(item?.name);
		const mimeType = String(item?.mimeType ?? "").toLowerCase().split(";")[0].trim();
		const bytes = decodeBase64(item?.data, name);
		total += bytes.length;
		if (total > ATTACHMENT_LIMITS.totalBytes) throw new AttachmentError("附件总大小超过 10MB");
		if (IMAGE_SIGNATURES[mimeType]) {
			if (!IMAGE_SIGNATURES[mimeType](bytes)) throw new AttachmentError(`「${name}」的内容和 ${mimeType} 不符`);
			if (bytes.length > ATTACHMENT_LIMITS.imageBytes) throw new AttachmentError(`图片「${name}」超过 5MB`);
			return { kind: "image", name, mimeType, size: bytes.length, data: item.data };
		}
		const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
		if (mimeType.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) {
			if (bytes.length > ATTACHMENT_LIMITS.textBytes) throw new AttachmentError(`文本文件「${name}」超过 200KB`);
			let text;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				throw new AttachmentError(`「${name}」不是 UTF-8 文本`);
			}
			if (text.includes("\u0000")) throw new AttachmentError(`「${name}」不是文本文件`);
			// 浏览器常把 .ts 报成 video/mp2t 之类，非 text/* 一律按 text/plain 告诉模型
			return { kind: "text", name, mimeType: mimeType.startsWith("text/") ? mimeType : "text/plain", size: bytes.length, text };
		}
		throw new AttachmentError(`暂不支持「${name}」这种文件，目前只支持图片（PNG/JPEG/WebP/GIF）和文本类文件`);
	});
}

// 组装成 pi-ai 的用户消息内容；没有附件时保持纯字符串，和原来一样
export function buildUserContent(text: string, files: readonly Attachment[]): string | (TextContent | ImageContent)[] {
	if (!files.length) return text;
	const parts: (TextContent | ImageContent)[] = [];
	if (text) parts.push({ type: "text", text });
	for (const f of files) {
		const head = `<附件 name="${f.name}" type="${f.mimeType}" size="${f.size}"`;
		if (f.kind === "text") {
			parts.push({ type: "text", text: `${head}>\n${f.text}\n</附件>` });
		} else {
			parts.push({ type: "text", text: `${head}/>` });
			parts.push({ type: "image", data: f.data, mimeType: f.mimeType });
		}
	}
	return parts;
}

// 从用户消息内容拆出正文、附件清单和第三方引用；图片按出现顺序编号，供 imageUrl 取回
export function splitUserContent(content: Message["content"] | undefined) {
	if (typeof content === "string") return { text: content, attachments: [], quote: "" };
	const texts = [];
	const attachments: AttachmentSummary[] = [];
	let quote = "";
	let imageIndex = 0;
	for (const part of content ?? []) {
		if (part.type === "image") {
			const last = attachments.at(-1);
			if (last?.kind === "image" && last.index === undefined) last.index = imageIndex;
			imageIndex += 1;
			continue;
		}
		if (part.type !== "text") continue;
		const q = QUOTE.exec(part.text);
		if (q) {
			quote ||= q[1];
			continue;
		}
		const m = MARK.exec(part.text);
		if (!m) {
			texts.push(part.text);
			continue;
		}
		attachments.push({ kind: m[4] ? "image" : "text", name: m[1], mimeType: m[2], size: Number(m[3]) });
	}
	return { text: texts.join(""), attachments, quote };
}

// 展示和索引用的正文：引用是第三方内容，标回原来的 [引用：…] 形式，不参与授权判定。
export const withQuote = ({ text, quote }: { text: string; quote: string }) => quote ? `[引用：${quote}]\n${text}` : text;

// 取用户消息里第 index 张图片
export function imageAt(content: Message["content"] | undefined, index: number) {
	if (!Array.isArray(content)) return undefined;
	return content.filter((p) => p.type === "image")[index];
}
