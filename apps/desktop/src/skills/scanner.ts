import { opendir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { optionalStat, readSkill } from "./filesystem.js";
import { parseMetadata } from "./metadata.js";
import { errorText, LIMITS, pathId, type LocalSkill, type SkillRoot, type SkillSnapshot } from "./model.js";

export interface CatalogScan { snapshot: SkillSnapshot; directories: Map<string, string> }

export function defaultRoots(home: string): SkillRoot[] {
  return [
    ["Agents", ".agents/skills"], ["Claude Code", ".claude/skills"],
    ["Codex", ".codex/skills"], ["DSH", ".dsh/skills"],
    ["Pi", ".pi/agent/skills"], ["OpenCode", ".config/opencode/skills"],
  ].map(([label, suffix]) => {
    const path = join(home, suffix);
    return { id: pathId("root", path), label, path, exists: false, custom: false };
  });
}

export async function scanRoots(home: string, custom: string[]): Promise<CatalogScan> {
  const roots = defaultRoots(home);
  for (const path of custom) {
    if (!roots.some((root) => root.path === path)) roots.push({ id: pathId("root", path), label: basename(path) || path, path, exists: false, custom: true });
  }
  const warnings: string[] = [];
  const skills = new Map<string, LocalSkill>();
  const directories = new Map<string, string>();
  let entries = 0;
  let stopped = false;

  async function walk(directory: string, depth: number, root: SkillRoot, ancestors: Set<string>) {
    if (stopped) return;
    const info = await optionalStat(directory);
    if (!info) return;
    const link = info.isSymbolicLink();
    if (!info.isDirectory() && !link) return;
    const canonical = await realpath(directory);
    const marker = await optionalStat(join(canonical, "SKILL.md"));
    if (marker) {
      if (marker.isSymbolicLink() || !marker.isFile()) {
        warnings.push(`SKILL.md must be a regular file without symlink: ${directory}`);
        return;
      }
      const id = pathId("skill", canonical);
      let entry = skills.get(id);
      if (!entry) {
        let metadata: Pick<LocalSkill, "name" | "description" | "issue">;
        try {
          const file = await readSkill(canonical, false);
          metadata = parseMetadata(file.content, basename(canonical), file.truncated);
          if (file.size > LIMITS.detailBytes) metadata.issue = [metadata.issue, "SKILL.md exceeds 1 MiB detail size limit"].filter(Boolean).join("; ");
        } catch (error) { metadata = { name: basename(canonical), description: "", issue: errorText(error) }; }
        entry = { id, ...metadata, locations: [] };
        skills.set(id, entry);
        directories.set(id, canonical);
        if (entry.issue) warnings.push(`${directory}: ${entry.issue}`);
      }
      entry.locations.push({ rootId: root.id, label: root.label, path: directory });
      return;
    }
    if (link) {
      warnings.push(`Skipped symlink directory without ordinary SKILL.md: ${directory}`);
      return;
    }
    if (ancestors.has(canonical)) {
      warnings.push(`Skipped directory cycle: ${directory}`);
      return;
    }
    const nextAncestors = new Set(ancestors).add(canonical);
    const handle = await opendir(directory);
    for await (const child of handle) {
      if (++entries > LIMITS.scanEntries) {
        stopped = true;
        warnings.push(`Scan entry limit ${LIMITS.scanEntries} reached; results are partial`);
        break;
      }
      if (child.name.startsWith(".") || child.name === "node_modules" || (!child.isDirectory() && !child.isSymbolicLink())) continue;
      if (depth >= LIMITS.scanDepth) {
        warnings.push(`Scan depth limit ${LIMITS.scanDepth} reached: ${directory}`);
        break;
      }
      try { await walk(join(directory, child.name), depth + 1, root, nextAncestors); }
      catch (error) { warnings.push(`Scan failed for ${join(directory, child.name)}: ${errorText(error)}`); }
      if (stopped) break;
    }
  }

  for (const root of roots) {
    try {
      const info = await optionalStat(root.path);
      if (!info) {
        if (root.custom) warnings.push(`Custom skill root is missing: ${root.path}`);
        continue;
      }
      root.exists = info.isDirectory() || (info.isSymbolicLink() && (await stat(root.path)).isDirectory());
      if (!root.exists) throw new Error(`Skill root is not a directory: ${root.path}`);
      await walk(root.path, 0, root, new Set());
    } catch (error) {
      if (root.custom) throw new Error(`Custom skill root error: ${errorText(error)}`, { cause: error });
      warnings.push(`Default skill root error (${root.label}): ${errorText(error)}`);
    }
  }
  return { snapshot: { roots, skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), warnings }, directories };
}
