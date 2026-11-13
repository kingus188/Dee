import { existsSync } from "node:fs";
import { build } from "esbuild";
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Both the root build and the web workspace use the same asset source.
const root = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../" : "../../", import.meta.url));
const target = resolve(root, "apps/web/dist");
await mkdir(target, { recursive: true });
for (const name of ["index.html", "style.css", "tasks.css", "workspace.css", "chat.css", "teams-conversations.css", "daily-reports.css", "daylight.css", "task-workspace.css", "today.css", "inbox.css", "notifications.css", "notes.css", "editor.css", "desktop-agent.css", "lane-editor.css", "prototype.css", "code-card.css", "code-reader.css"]) {
  const source = await readFile(resolve(root, "apps/web/public", name), "utf8");
  // Keep authored sizes intact while allowing one font preference across all pages.
  const content = name.endsWith(".css") ? source
    .replace(/\bfont-size\s*:\s*([^;}]+)/g, declaration => declaration.replace(/\b(\d*\.?\d+)px\b/g, "calc($1px * var(--ui-font-scale, 1))"))
    .replace(/\bfont\s*:\s*([^;}]+)/g, declaration => declaration.replace(/\b(\d*\.?\d+)px\b/, "calc($1px * var(--ui-font-scale, 1))")) : source;
  await writeFile(resolve(target, name), content);
}
await cp(resolve(root, "apps/web/public/assets"), resolve(target, "assets"), { recursive: true });
const katexTarget = resolve(target, "vendor/katex");
await mkdir(katexTarget, { recursive: true });
await copyFile(resolve(root, "apps/web/node_modules/katex/dist/katex.min.css"), resolve(katexTarget, "katex.min.css"));
await cp(resolve(root, "apps/web/node_modules/katex/dist/fonts"), resolve(katexTarget, "fonts"), { recursive: true });
await copyFile(resolve(root, "apps/web/node_modules/katex/LICENSE"), resolve(katexTarget, "LICENSE"));
const html = await readFile(resolve(target, "index.html"), "utf8");
async function sourceText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sourceText(resolve(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? readFile(resolve(directory, entry.name), "utf8") : ""))).join("\n");
}
const sources = html + "\n" + await sourceText(resolve(root, "apps/web/src"));
const icons = new Set([...sources.matchAll(/(?:\/assets\/icons\.svg#|<Icon name="|icon: ")([a-z0-9-]+)/g)].map(match => match[1]));
const symbols: string[] = [];
for (const name of icons) {
  const source = await readFile(resolve(root, "node_modules/lucide-static/icons", name + ".svg"), "utf8");
  const body = source.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/)?.[1];
  if (!body) throw new Error("Invalid Lucide icon: " + name);
  symbols.push(`<symbol id="${name}" viewBox="0 0 24 24">${body}</symbol>`);
}
await writeFile(resolve(target, "assets/icons.svg"), `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join("")}</svg>`);
await copyFile(resolve(root, "node_modules/lucide-static/LICENSE"), resolve(target, "assets/lucide-LICENSE"));

// tsc 的增量构建不会删除已移除源码的产物。
async function removeStaleModules(output: string, source: string): Promise<void> {
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const file = resolve(output, entry.name);
    if (entry.isDirectory()) await removeStaleModules(file, resolve(source, entry.name));
    // Open pages can request an older lazy chunk after a new release.
    else if (output === resolve(target, "assets") && /^(?:app|chunk)-[A-Z0-9]{8}\.js$/.test(entry.name)) continue;
    else if (/\.(?:js|d\.ts)(?:\.map)?$/.test(entry.name)) {
      const original = entry.name.replace(/\.(?:js|d\.ts)(?:\.map)?$/, ".ts");
      if (!existsSync(resolve(source, original)) && !existsSync(resolve(source, original.replace(/\.ts$/, ".tsx")))) await rm(file);
    }
  }
}
await removeStaleModules(target, resolve(root, "apps/web/src"));
const testOutput = resolve(root, "apps/web/dist-tests");
if (existsSync(testOutput)) await removeStaleModules(testOutput, resolve(root, "apps/web/tests"));

// Keep upstream TypeScript separate from the host type-checking contract.
const laneKernel = resolve(root, "apps/web/vendor/open-markdown-lane/kernel.ts");
await build({
  entryPoints: [laneKernel], outfile: resolve(target, "editor/lane/kernel.js"),
  bundle: true, packages: "external", format: "esm", platform: "browser", target: "es2023",
});
await copyFile(resolve(root, "apps/web/vendor/open-markdown-lane/LICENSE"), resolve(target, "assets/open-markdown-lane-LICENSE"));
const result = await build({
  plugins: [{ name: "lane-kernel", setup(context) {
    context.onResolve({ filter: /^\.\/kernel\.js$/ }, args => args.importer.endsWith("/lane/LaneMarkdownEditor.tsx") ? { path: laneKernel } : undefined);
  } }],
  entryPoints: { app: resolve(root, "apps/web/src/main.tsx") }, outdir: resolve(target, "assets"),
  entryNames: "[name]-[hash]", chunkNames: "chunk-[hash]", splitting: true, metafile: true,
  bundle: true, format: "esm", platform: "browser", target: "es2023", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' }, minify: true,
});
const entry = Object.entries(result.metafile.outputs).find(([, output]) => output.entryPoint?.endsWith("/main.tsx"))?.[0];
if (!entry) throw new Error("Browser entry was not emitted");
await writeFile(resolve(target, "index.html"), html.replace('src="/app.js"', `src="/assets/${entry.split(/[\\/]/).at(-1)}"`));
