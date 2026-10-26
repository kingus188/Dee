import type { Stats } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, opendir, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertDirectory, assertSameDirectory, importRoot, isWithin, readRegular, readSkill, sameFile } from "./filesystem.js";
import { parseMetadata } from "./metadata.js";
import { absoluteDirectory, errorCode, LIMITS } from "./model.js";

function excluded(name: string): boolean {
  return [".git", "node_modules", ".DS_Store", ".env"].includes(name) || name.startsWith(".env.");
}

async function cleanOwned(path: string, identity: Stats, root: string, rootIdentity: Stats) {
  await assertSameDirectory(root, rootIdentity);
  let current: Stats;
  try { current = await lstat(path); }
  catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
  if (!isWithin(root, path) || path === root || !sameFile(identity, current) || !current.isDirectory() || current.isSymbolicLink()) {
    throw new Error(`Import cleanup identity mismatch: ${path}`);
  }
  await rm(path, { recursive: true });
}

export async function copySkillFolder(home: string, input: string): Promise<string> {
  const selected = absoluteDirectory(input);
  await assertDirectory(selected);
  const source = await realpath(selected);
  const sourceIdentity = await assertDirectory(source);
  const original = await readSkill(source, true);
  const header = await readSkill(source, false);
  const metadata = parseMetadata(header.content, basename(source), header.truncated);
  if (metadata.issue) throw new Error(`Invalid skill metadata: ${metadata.issue}`);
  if (!metadata.description.trim()) throw new Error("Invalid skill metadata: description is required");
  const slug = metadata.name;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64 || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(slug)) {
    throw new Error("Invalid skill name: expected a lowercase slug of at most 64 characters");
  }
  const root = await importRoot(home);
  const rootIdentity = await assertDirectory(root);
  if (isWithin(source, root)) throw new Error("Import destination lies inside source directory");
  const destination = join(root, slug);
  try { await lstat(destination); throw new Error(`Skill destination already exists: ${slug}`); }
  catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  const stage = await mkdtemp(join(root, ".import-"));
  const stageIdentity = await assertDirectory(stage);
  let destinationIdentity: Stats | undefined;
  let published = false;
  let entries = 0;
  let total = 0;

  async function copy(sourceDirectory: string, targetDirectory: string, depth: number) {
    if (depth > LIMITS.importDepth) throw new Error(`Import depth limit ${LIMITS.importDepth} exceeded`);
    const identity = await assertDirectory(sourceDirectory);
    const handle = await opendir(sourceDirectory);
    for await (const entry of handle) {
      if (++entries > LIMITS.importEntries) throw new Error(`Import entry limit ${LIMITS.importEntries} exceeded`);
      const from = join(sourceDirectory, entry.name);
      const info = await lstat(from);
      if (info.isSymbolicLink()) throw new Error(`Import excludes every symlink: ${entry.name}`);
      if (excluded(entry.name)) continue;
      const target = join(targetDirectory, entry.name);
      await assertSameDirectory(sourceDirectory, identity);
      if (info.isDirectory()) {
        await mkdir(target, { mode: 0o700 });
        await copy(from, target, depth + 1);
      } else if (info.isFile()) {
        if (info.size > LIMITS.importFileBytes) throw new Error(`Import file size limit ${LIMITS.importFileBytes} exceeded: ${entry.name}`);
        total += info.size;
        if (total > LIMITS.importTotalBytes) throw new Error(`Import total size limit ${LIMITS.importTotalBytes} exceeded`);
        const data = await readRegular(from, LIMITS.importFileBytes);
        if (data.size !== info.size) throw new Error(`Import file changed: ${entry.name}`);
        const output = await open(target, "wx", 0o600 | (info.mode & 0o111));
        try { await output.writeFile(data.bytes); }
        finally { await output.close(); }
      } else throw new Error(`Import only accepts regular files and directories: ${entry.name}`);
    }
    await assertSameDirectory(sourceDirectory, identity);
  }

  try {
    await copy(source, stage, 0);
    await assertSameDirectory(source, sourceIdentity);
    const staged = await readSkill(stage, true);
    if (staged.content !== original.content) throw new Error("SKILL.md changed during import");
    await assertSameDirectory(root, rootIdentity);
    // mkdir is the exclusive no-overwrite reservation. Node's directory rename
    // can replace an existing empty directory, so it is unsuitable for publish.
    await mkdir(destination, { mode: 0o700 });
    destinationIdentity = await assertDirectory(destination);
    const handle = await opendir(stage);
    for await (const entry of handle) {
      if (entry.name === "SKILL.md") continue;
      await assertSameDirectory(root, rootIdentity);
      await assertSameDirectory(destination, destinationIdentity);
      await rename(join(stage, entry.name), join(destination, entry.name));
    }
    await assertSameDirectory(root, rootIdentity);
    await assertSameDirectory(destination, destinationIdentity);
    // The fixed marker appears atomically, after every asset is in place.
    // link() is exclusive even if another writer races to create SKILL.md.
    await link(join(stage, "SKILL.md"), join(destination, "SKILL.md"));
    published = true;
    await unlink(join(stage, "SKILL.md"));
    return destination;
  } finally {
    try {
      if (!published && destinationIdentity) await cleanOwned(destination, destinationIdentity, root, rootIdentity);
    } finally { await cleanOwned(stage, stageIdentity, root, rootIdentity); }
  }
}
