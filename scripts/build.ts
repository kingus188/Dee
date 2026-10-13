import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Both the root build and the web workspace use the same asset source.
const root = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../" : "../../", import.meta.url));
const target = resolve(root, "apps/web/dist");
await mkdir(target, { recursive: true });
for (const name of ["index.html", "style.css", "tasks.css"]) {
  await copyFile(resolve(root, "apps/web/public", name), resolve(target, name));
}

// tsc 的增量构建不会删除已移除源码的产物。
async function removeStaleModules(output: string, source: string): Promise<void> {
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const file = resolve(output, entry.name);
    if (entry.isDirectory()) await removeStaleModules(file, resolve(source, entry.name));
    else if (/\.(?:js|d\.ts)(?:\.map)?$/.test(entry.name)) {
      const original = entry.name.replace(/\.(?:js|d\.ts)(?:\.map)?$/, ".ts");
      if (!existsSync(resolve(source, original))) await rm(file);
    }
  }
}
await removeStaleModules(target, resolve(root, "apps/web/src"));
