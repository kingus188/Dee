import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { createStaticHandler } from "../dist/http/static.js";

test("多模块静态资源可加载，路径穿越与目录外符号链接被拒绝", async () => {
 const dir = await mkdtemp(join(tmpdir(), "pi-static-"));
 await mkdir(join(dir, "public/chat"), { recursive: true });
 await writeFile(join(dir, "public/chat/render.js"), "export const ready = true;");
 await writeFile(join(dir, "private.js"), "private content");
 await symlink(join(dir, "private.js"), join(dir, "public/link.js"));
 const serve = createStaticHandler(pathToFileURL(join(dir, "public/") ));
 const server = createServer(async (req, res) => {
   try { if (!await serve(req.url!, res)) res.writeHead(404).end(); }
   catch { res.writeHead(400).end(); }
 });
 server.listen(0, "127.0.0.1"); await once(server, "listening");
 const address = server.address(); assert.ok(address && typeof address === "object");
 const origin = "http://127.0.0.1:" + address.port;
 try {
   const asset = await fetch(origin + "/chat/render.js");
   assert.equal(asset.status, 200); assert.match(asset.headers.get("content-type")!, /javascript/);
   assert.equal(await asset.text(), "export const ready = true;");
   for (const path of ["/%2e%2e%2fprivate.js", "/link.js", "/main.js.map", "/main.d.ts"]) assert.equal((await fetch(origin + path)).status, 404, path);
   assert.equal((await fetch(origin + "/%ZZ.js")).status, 400);
 } finally { await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); }
});
