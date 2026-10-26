import { execFile } from "node:child_process";
import { AttachmentError } from "./error.js";

export const DOCUMENT_LIMITS = { bytes: 5 * 1024 * 1024, chars: 100_000, timeoutMs: 5000, xmlBytes: 2 * 1024 * 1024, expandedBytes: 20 * 1024 * 1024, entries: 1000 };
export type DocumentParserOptions = {
	commands?: { pdftotext?: string; unzip?: string; xsltproc?: string };
	timeoutMs?: number;
	tempRoot?: string;
};

export function runParser(command: string, args: string[], name: string, timeout: number, maxBuffer: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { encoding: "buffer", timeout: Math.max(1, timeout), killSignal: "SIGKILL", maxBuffer, windowsHide: true }, (error, stdout) => {
			if (!error) { resolve(stdout); return; }
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") reject(new AttachmentError(`附件「${name}」解析器缺少：${command.split(/[\\/]/).pop()}`));
			else if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(new AttachmentError(`附件「${name}」提取长度超过限制`));
			else if (error.killed) reject(new AttachmentError(`附件「${name}」解析超时`));
			else reject(new AttachmentError(`附件「${name}」解析失败：文件畸形、加密或解析器异常`));
		});
	});
}
