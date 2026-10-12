import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Both the root build and the web workspace use the same asset source.
const root = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../" : "../../", import.meta.url));
const target = resolve(root, "apps/web/dist");
await mkdir(target, { recursive: true });
for (const name of ["index.html", "style.css"]) {
  await copyFile(resolve(root, "apps/web/public", name), resolve(target, name));
}
