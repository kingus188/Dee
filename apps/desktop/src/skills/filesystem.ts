import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";
import { errorCode, LIMITS } from "./model.js";

export async function optionalStat(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

export function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function isWithin(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !suffix.startsWith(sep));
}

// O_NOFOLLOW closes the final-component race; inode comparisons also protect
// platforms where this flag is absent. O_NONBLOCK prevents a replaced FIFO hang.
export async function readRegular(path: string, maxBytes: number, prefixOnly = false) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Expected a regular file, symlinks excluded: ${path}`);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error(`File changed during open: ${path}`);
    if (!prefixOnly && opened.size > maxBytes) throw new Error(`File size exceeds limit ${maxBytes}: ${path}`);
    const length = Math.min(opened.size, maxBytes + (prefixOnly ? 0 : 1));
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (!sameFile(opened, current) || current.isSymbolicLink() || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) {
      throw new Error(`File changed during read: ${path}`);
    }
    if (!prefixOnly && (after.size > maxBytes || offset > maxBytes)) throw new Error(`File size exceeds limit ${maxBytes}: ${path}`);
    return { bytes: buffer.subarray(0, offset), size: after.size, truncated: after.size > offset };
  } finally { await handle.close(); }
}

export function utf8(bytes: Uint8Array, partial = false): string {
  try {
    // A prefix may end inside a UTF-8 codepoint; retain strict validation of all
    // complete codepoints without reading beyond the header budget.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: partial });
  } catch { throw new Error("Invalid UTF-8 text"); }
}

export async function readSkill(directory: string, detail: boolean) {
  const filePath = join(directory, "SKILL.md");
  const data = await readRegular(filePath, detail ? LIMITS.detailBytes : LIMITS.headerBytes, !detail);
  return { content: utf8(data.bytes, data.truncated), filePath, size: data.size, truncated: data.truncated };
}

export async function assertDirectory(path: string): Promise<Stats> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Expected directory without symlink: ${path}`);
  return stat;
}

export async function assertSameDirectory(path: string, expected: Stats): Promise<void> {
  if (!sameFile(await assertDirectory(path), expected)) throw new Error(`Directory changed during operation: ${path}`);
}

// Create only these descendants of an already resolved home, rejecting links
// instead of allowing mkdir({recursive:true}) to redirect an import elsewhere.
export async function importRoot(home: string): Promise<string> {
  let directory = await realpath(home);
  await assertDirectory(directory);
  for (const segment of [".agents", "skills"]) {
    const parent = directory;
    const identity = await assertDirectory(parent);
    directory = join(parent, segment);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    await assertSameDirectory(parent, identity);
    await assertDirectory(directory);
  }
  return directory;
}
