import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { bestLine, classifyStatus, sliceLines, hasSecret } from "@assistant/features";

class UnsupportedKnowledge extends Error {}
class SensitiveKnowledge extends Error {}

const MAX_ENTRIES = 2000, MAX_FILES = 200, MAX_BYTES = 256 * 1024;
const blocked = (name: string) => name.startsWith(".") || /^(?:node_modules|secrets?|credentials|id_rsa|id_ed25519)(?:\.|$)/i.test(name);
const supported = (name: string) => /\.(md|txt)$/i.test(name);
const inside = (root: string, file: string) => { const rel = relative(root, file); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const version = (bytes: Uint8Array, root: string) => createHash("sha256").update(root).update("\0").update(bytes).digest("hex");

// No index, cache, background scan or persistence. Each request uses only the explicitly selected directory.
export function createLocalKnowledge(configuration: () => { directory: string | null | undefined; revision: number }) {
  async function root() {
    const config = configuration();
    const selected = config.directory;
    if (!selected) throw new Error("请先选择资料目录；工作目录不会自动成为资料目录");
    const canonical = await realpath(selected);
    if (!(await lstat(canonical)).isDirectory()) throw new Error("资料目录不可访问");
    return { selected, canonical, revision: config.revision };
  }
  async function unchanged(value: Awaited<ReturnType<typeof root>>) {
    const canonical = await realpath(value.selected);
    const current = configuration();
    if (current.directory !== value.selected || current.revision !== value.revision || canonical !== value.canonical) throw new Error("资料目录已变更，请重新检索");
  }
  async function file(root: string, path: string) {
    if (!path || isAbsolute(path) || /[\\\0]/.test(path) || path.split("/").some(p => !p || p === "." || p === ".." || blocked(p)) || !supported(path)) throw new Error("资料路径不在允许范围");
    let location = root;
    for (const part of path.split("/")) {
      location = join(location, part);
      if ((await lstat(location)).isSymbolicLink()) throw new Error("资料路径不允许符号链接");
    }
    if (!inside(root, await realpath(location))) throw new Error("资料路径越界");
    const handle = await open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_BYTES) throw new UnsupportedKnowledge("仅支持不超过256KB的Markdown和文本文件");
      const data = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      const after = await handle.stat();
      if (bytesRead > MAX_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytesRead !== after.size) throw new Error("资料读取期间发生变化");
      if (!inside(root, await realpath(location))) throw new Error("资料路径越界");
      const current = await lstat(location);
      if (current.isSymbolicLink() || current.ino !== after.ino || current.dev !== after.dev) throw new Error("资料读取期间发生变化");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead)); } catch { throw new UnsupportedKnowledge("仅支持UTF-8文本资料"); }
      if (hasSecret(text)) throw new SensitiveKnowledge("资料包含敏感凭据，不返回片段");
      if (text.includes("\0")) throw new UnsupportedKnowledge("不支持二进制资料");
      return { text, revision: version(data.subarray(0, bytesRead), root) };
    } finally { await handle.close(); }
  }
  return {
    async search(query: string) {
      if (typeof query !== "string" || !query.trim() || query.length > 200) throw new Error("检索词必须为1至200字");
      const selected = await root();
      const scan = { entries: 0, files: 0, maxReadBytes: MAX_FILES * (MAX_BYTES + 1), inaccessible: 0, unsupported: 0, skipped: 0, sensitiveRejected: 0, limited: false };
      const hits: { path: string; status: "current" | "archived" | "draft"; revision: string; line: number; endLine: number; excerpt: string; truncated: boolean; score: number }[] = [];
      const pending = [""];
      while (pending.length && !scan.limited) {
        const rel = pending.pop()!;
        try {
          const dir = join(selected.canonical, rel);
          if ((await lstat(dir)).isSymbolicLink() || !inside(selected.canonical, await realpath(dir))) { scan.inaccessible++; continue; }
          for await (const entry of await opendir(dir)) {
            if (++scan.entries > MAX_ENTRIES || scan.files >= MAX_FILES) { scan.limited = true; break; }
            if (blocked(entry.name) || entry.isSymbolicLink()) { scan.skipped++; continue; }
            const path = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) { pending.push(path); continue; }
            if (!entry.isFile()) continue;
            if (!supported(path)) { scan.unsupported++; continue; }
            scan.files++;
            try {
              const data = await file(selected.canonical, path);
              const found = bestLine(data.text, query);
              if (found.score <= 0) continue;
              const remaining = sliceLines(data.text, found.line);
              const excerpt = remaining.text.split(/\r?\n/).slice(0, 8).join("\n").slice(0, 1200);
              hits.push({ path, status: classifyStatus(path), revision: `${selected.revision}:${data.revision}`, line: found.line, endLine: found.line + excerpt.split("\n").length - 1, excerpt, truncated: remaining.truncated || excerpt !== remaining.text, score: found.score });
            } catch (error) {
              if (error instanceof UnsupportedKnowledge) scan.unsupported++;
              else if (error instanceof SensitiveKnowledge) scan.sensitiveRejected++;
              else scan.inaccessible++;
            }
          }
        } catch { scan.inaccessible++; }
      }
      await unchanged(selected);
      hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      return { status: scan.limited || scan.inaccessible || scan.unsupported || scan.skipped || scan.sensitiveRejected ? "partial" : hits.length ? "matched" : "no_matches", hits: hits.slice(0, 5), scan, notice: "仅检索所选目录中的Markdown和文本；片段会交给当前模型，不是全部资料的完备检索。" };
    },
    async read(path: string, revision: string, line = 1) {
      if (!/^\d+:[a-f0-9]{64}$/.test(revision) || !Number.isSafeInteger(line) || line < 1) throw new Error("请使用检索返回的版本和有效行号");
      const selected = await root(), data = await file(selected.canonical, path);
      if (`${selected.revision}:${data.revision}` !== revision) throw new Error("资料版本已变化，请重新检索，不能用新内容替代旧引用");
      if (line > data.text.split(/\r?\n/).length) throw new Error("行号超出资料范围");
      await unchanged(selected);
      return { path, revision, ...sliceLines(data.text, line), contentVersion: "current_observed_snapshot" };
    },
  };
}
