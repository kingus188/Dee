import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { optionalStat, readRegular, utf8 } from "./filesystem.js";
import { absoluteDirectory, errorCode, errorText, LIMITS } from "./model.js";

export async function loadRoots(stateFile: string): Promise<string[]> {
  try {
    if (!await optionalStat(stateFile)) return [];
    const { bytes } = await readRegular(stateFile, LIMITS.stateBytes);
    const data: unknown = JSON.parse(utf8(bytes));
    if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("roots" in data) || !Array.isArray(data.roots)) {
      throw new Error("Expected version 1 and roots array");
    }
    if (data.roots.length > LIMITS.customRoots) throw new Error(`Root count exceeds limit ${LIMITS.customRoots}`);
    const roots: string[] = [];
    for (const root of data.roots) {
      if (typeof root !== "string" || !isAbsolute(root)) throw new Error("Root must be an absolute path");
      roots.push(absoluteDirectory(root));
    }
    return [...new Set(roots)];
  } catch (error) { throw new Error(`Local skills state error: ${errorText(error)}`, { cause: error }); }
}

export async function saveRoots(stateFile: string, roots: string[]): Promise<void> {
  const directory = dirname(stateFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const current = await optionalStat(stateFile);
  if (current && (current.isSymbolicLink() || !current.isFile())) throw new Error("Local skills state must be a regular file without symlink");
  const temporary = join(directory, `.local-skills-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let published = false;
  try {
    await handle.writeFile(JSON.stringify({ version: 1, roots }) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, stateFile);
    published = true;
  } finally {
    await handle.close();
    if (!published) {
      try { await unlink(temporary); }
      catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    }
  }
}
