import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { serveWebStatic } from "../dist/http/static.js";
import { createBrowserSessions } from "../dist/http/browser-sessions.js";

async function fixture(t: TestContext, password = "") {
  const directory = await mkdtemp(join(tmpdir(), "pi-api-static-"));
  const dist = join(directory, "dist");
  for (const folder of ["assets", "vendor/katex/fonts", "ui", "tests"]) await mkdir(join(dist, folder), { recursive: true });
  for (const [name, contents] of Object.entries({
    "index.html": "<!doctype html><title>小 D</title>", "app.js": "console.log('bundle')", "style.css": "body{}",
    "assets/icons.svg": "<svg></svg>", "assets/orb-reference.png": "image", "vendor/katex/katex.min.css": "@font-face{}",
    "vendor/katex/fonts/KaTeX_Main-Regular.woff2": "font", "ui/App.js": "private module", "tests/example.test.js": "private test",
    "assets/example.test.js": "private test", "assets/private.json": "private configuration", ".hidden": "hidden",
    "assets/.hidden.svg": "hidden", "app.js.map": "source map", "assets/icons.svg.map": "source map",
  })) await writeFile(join(dist, name), contents);
  await writeFile(join(directory, "outside.svg"), "outside");
  await symlink(join(directory, "outside.svg"), join(dist, "assets/outside.svg"));
  await symlink(join(dist, "ui/App.js"), join(dist, "assets/source.js"));
  await symlink(join(dist, "assets/.hidden.svg"), join(dist, "assets/hidden.svg"));
  const sessions = createBrowserSessions(password);
  const server = createServer(async (req, res) => {
    if (!sessions.authenticate(req)) { res.writeHead(401, { "www-authenticate": 'Basic realm="test"' }); res.end(); return; }
    if (await serveWebStatic(req, res, dist)) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ route: req.url, method: req.method }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  // Preserve dot segments for traversal checks instead of allowing fetch to normalize them.
  const get = (path: string, method = "GET") => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(origin, { path, method }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", value => { body += value; });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject); req.end();
  });
  return { origin, dist, get };
}

test("API origin serves only the built public frontend, including HEAD", async t => {
  const { origin } = await fixture(t);
  for (const [path, mime] of [["/", "text/html"], ["/index.html", "text/html"], ["/app.js", "text/javascript"], ["/style.css", "text/css"], ["/assets/icons.svg", "image/svg+xml"], ["/vendor/katex/katex.min.css", "text/css"], ["/vendor/katex/fonts/KaTeX_Main-Regular.woff2", "font/woff2"]]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path); assert.ok(response.headers.get("content-type")!.startsWith(mime!), mime);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(response.headers.get("referrer-policy"), "same-origin");
    const head = await fetch(origin + path, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(await head.text(), "");
    assert.equal(head.headers.get("content-length"), response.headers.get("content-length"));
  }
});

test("private modules, tests, maps, hidden files and traversal never become public", async t => {
  const { get } = await fixture(t);
  for (const path of ["/missing", "/missing.js", "/ui/App.js", "/tests/example.test.js", "/assets/example.test.js", "/assets/private.json", "/.hidden", "/assets/.hidden.svg", "/app.js.map", "/assets/icons.svg.map", "/assets/../index.html", "/assets/%2e%2e/index.html", "/%2e/index.html", "/assets%5coutside.svg", "/assets/%00.png", "/%zz", "//index.html"]) {
    const response = await get(path); assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.body, /private module|private test|configuration|outside/);
  }
});

test("symlinks cannot expose outside files or private paths within dist", async t => {
  const { get } = await fixture(t);
  for (const path of ["/assets/outside.svg", "/assets/source.js", "/assets/hidden.svg"]) assert.equal((await get(path)).status, 404, path);
});

test("missing frontend returns 404 without falling back to source or an SPA route", async t => {
  const { origin, dist } = await fixture(t);
  await rm(dist, { recursive: true });
  for (const path of ["/", "/app.js", "/settings"]) assert.equal((await fetch(origin + path)).status, 404);
});

test("static GET/HEAD retain Basic login and reserve API and channel routes", async t => {
  const { origin, get } = await fixture(t, "static-fixture-password");
  for (const path of ["/", "/app.js", "/assets/icons.svg"]) {
    assert.equal((await fetch(origin + path)).status, 401);
    const response = await fetch(origin + path, { headers: { authorization: "Basic " + Buffer.from("demo:static-fixture-password").toString("base64") } });
    assert.equal(response.status, 200);
  }
  assert.equal((await get("/api/info")).status, 401);
  const open = await fixture(t);
  for (const path of ["/api", "/api/info", "/api/socket", "/api?x=1", "/channels/wechat/incoming"]) {
    const response = await fetch(open.origin + path); assert.equal(response.status, 200);
    assert.equal((await response.json() as { route: string }).route, path);
  }
  assert.deepEqual(JSON.parse((await open.get("/app.js", "POST")).body), { route: "/app.js", method: "POST" });
});
