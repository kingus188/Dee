import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { assertDirectory, assertSameDirectory, optionalStat, readSkill, utf8 } from "./filesystem.js";
import { copySkillFolder } from "./importer.js";
import { parseMetadata } from "./metadata.js";
import { absoluteDirectory, checkedId, errorCode, LIMITS, pathId, type SkillDetail, type SkillSnapshot } from "./model.js";
import { defaultRoots, scanRoots } from "./scanner.js";
import { loadRoots, saveRoots } from "./state.js";

export class LocalSkillCatalog {
  private readonly home: string;
  private readonly stateFile: string;
  private mutation: Promise<void> = Promise.resolve();

  constructor(options: { home: string; stateFile: string }) {
    this.home = absoluteDirectory(options.home);
    this.stateFile = absoluteDirectory(options.stateFile);
  }

  async list(): Promise<SkillSnapshot> {
    return (await scanRoots(this.home, await loadRoots(this.stateFile))).snapshot;
  }

  async read(id: unknown): Promise<SkillDetail> {
    const { entry, directory } = await this.findSkill(id);
    const identity = await assertDirectory(directory);
    if (await realpath(directory) !== directory) throw new Error("Skill directory changed");
    const file = await readSkill(directory, true);
    await assertSameDirectory(directory, identity);
    if (await realpath(directory) !== directory) throw new Error("Skill directory changed");
    const bytes = Buffer.from(file.content, "utf8");
    const metadata = parseMetadata(utf8(bytes.subarray(0, LIMITS.headerBytes), bytes.length > LIMITS.headerBytes), basename(directory), bytes.length > LIMITS.headerBytes);
    return { ...entry, ...metadata, issue: metadata.issue, content: file.content, filePath: file.filePath };
  }

  async revealPath(id: unknown): Promise<string> {
    const { directory } = await this.findSkill(id);
    const identity = await assertDirectory(directory);
    if (await realpath(directory) !== directory) throw new Error("Skill directory changed");
    const file = await readSkill(directory, false);
    await assertSameDirectory(directory, identity);
    if (await realpath(directory) !== directory) throw new Error("Skill directory changed");
    return file.filePath;
  }

  async addRoot(directory: string): Promise<SkillSnapshot> {
    return this.mutate(async () => {
      const roots = await loadRoots(this.stateFile);
      const canonical = await realpath(absoluteDirectory(directory));
      await assertDirectory(canonical);
      const known = [...roots, ...defaultRoots(this.home).map((root) => root.path)];
      for (const path of known) {
        try {
          if (!roots.includes(path) && (await optionalStat(path))?.isSymbolicLink()) continue;
          if (await realpath(path) === canonical) return this.list();
        } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      }
      if (roots.length >= LIMITS.customRoots) throw new Error(`Custom root limit ${LIMITS.customRoots} reached`);
      const updated = [...roots, canonical];
      const { snapshot } = await scanRoots(this.home, updated);
      await saveRoots(this.stateFile, updated);
      return snapshot;
    });
  }

  async removeRoot(id: unknown): Promise<SkillSnapshot> {
    const checked = checkedId(id, "root");
    return this.mutate(async () => {
      const roots = await loadRoots(this.stateFile);
      const selected = roots.find((path) => pathId("root", path) === checked);
      if (!selected || defaultRoots(this.home).some((root) => root.id === checked)) throw new Error("Unknown custom root id");
      const updated = roots.filter((path) => path !== selected);
      const { snapshot } = await scanRoots(this.home, updated);
      await saveRoots(this.stateFile, updated);
      return snapshot;
    });
  }

  async importFolder(directory: string): Promise<{ snapshot: SkillSnapshot; skillId: string }> {
    return this.mutate(async () => {
      // A damaged state is a hard error before any import side effect.
      await this.list();
      const destination = await copySkillFolder(this.home, directory);
      const skillId = pathId("skill", await realpath(destination));
      const snapshot = await this.list();
      if (!snapshot.skills.some((skill) => skill.id === skillId)) throw new Error("Imported skill was published but is outside the bounded catalog scan");
      return { snapshot, skillId };
    });
  }

  private async findSkill(id: unknown) {
    const checked = checkedId(id, "skill");
    const scan = await scanRoots(this.home, await loadRoots(this.stateFile));
    const entry = scan.snapshot.skills.find((skill) => skill.id === checked);
    const directory = scan.directories.get(checked);
    if (!entry || !directory) throw new Error("Unknown or removed local skill id");
    return { entry, directory };
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}
