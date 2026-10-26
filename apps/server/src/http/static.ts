import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const webDist = fileURLToPath(new URL("../../../web/dist/", import.meta.url));
// tsc also emits source modules and declarations into dist; only ship the browser entry and public resources.
const publicFiles = new Set([
  "index.html", "app.js", "style.css", "tasks.css", "workspace.css", "chat.css", "daily-reports.css", "daylight.css",
  "task-workspace.css", "today.css", "inbox.css", "notifications.css", "notes.css", "editor.css",
  "assets/lucide-LICENSE", "vendor/katex/LICENSE",
]);
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};
function publicPath(path: string) {
  const segments = path.split("/");
  if (segments.some(segment => !segment || segment.startsWith(".") || /[\\\x00-\x1f\x7f]/.test(segment))) return false;
  if (publicFiles.has(path)) return true;
  return ["assets", "vendor"].includes(segments[0]!) && !segments.some(segment => /^(?:tests?|__tests__)$/i.test(segment))
    && !/\.(?:test|spec)\./i.test(path) && contentTypes[extname(path)] !== undefined && extname(path) !== ".html";
}
function inside(root: string, target: string) {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}
function notFound(res: ServerResponse) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
  res.end("Not found");
  return true;
}

/** Called after the existing HTTP authentication. API/channel routes always retain their router. */
export async function serveWebStatic(req: IncomingMessage, res: ServerResponse, directory = webDist): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let pathname: string;
  try { pathname = decodeURIComponent((req.url || "/").split("?")[0]!); }
  catch { return notFound(res); }
  if (/^\/(?:api|channels)(?:\/|$)/.test(pathname)) return false;
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return notFound(res);
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!publicPath(requested)) return notFound(res);
  let target: string;
  let size: number;
  try {
    const root = await realpath(directory);
    target = await realpath(resolve(root, requested));
    if (!inside(root, target) || !publicPath(relative(root, target).split(sep).join("/"))) return notFound(res);
    const info = await stat(target);
    if (!info.isFile()) return notFound(res);
    size = info.size;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code || "")) return notFound(res);
    throw error;
  }
  res.writeHead(200, {
    "content-type": contentTypes[extname(target)] || "text/plain; charset=utf-8", "content-length": size,
    "cache-control": "private, no-cache", "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin", "x-frame-options": "SAMEORIGIN",
  });
  if (req.method === "HEAD") res.end();
  else {
    const stream = createReadStream(target);
    stream.on("error", error => res.destroy(error));
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }
  return true;
}
