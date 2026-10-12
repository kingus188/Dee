import type { ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "../errors.js";

const mime: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
export function createStaticHandler(root: URL) {
  const directory = fileURLToPath(root);
  return async (path: string, res: ServerResponse) => {
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { throw new HttpError(400, "路径编码不合法"); }
    const aliases: Record<string, string> = { "/": "/index.html", "/app.js": "/main.js", "/v3.js": "/tasks/center.js" };
    decoded = aliases[decoded] ?? decoded;
    const type = mime[extname(decoded)];
    if (!type || decoded.includes("\\") || decoded.includes("\0")) return false;
    const file = resolve(directory, "." + decoded);
    if (!file.startsWith(directory.replace(/[/\\]$/, "") + sep)) return false;
    try {
      const actual = await realpath(file);
      if (!actual.startsWith((await realpath(directory)) + sep)) return false;
      const body = await readFile(actual);
      res.writeHead(200, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && ["ENOENT", "EISDIR", "ENOTDIR"].includes(String(error.code))) return false;
      throw error;
    }
  };
}
