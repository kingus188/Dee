export type LocalSkillRoot = { id: string; label: string; path: string; exists: boolean; custom: boolean };
export type LocalSkillLocation = { rootId: string; label: string; path: string };
export type LocalSkillSummary = { id: string; name: string; description: string; locations: LocalSkillLocation[]; issue?: string };
export type LocalSkillsSnapshot = { roots: LocalSkillRoot[]; skills: LocalSkillSummary[]; warnings: string[] };
export type LocalSkillDetail = LocalSkillSummary & { content: string; filePath: string };
export type LocalSkillsBridge = {
  version: 1;
  list(): Promise<LocalSkillsSnapshot>;
  read(id: string): Promise<LocalSkillDetail>;
  reveal(id: string): Promise<void>;
  addDirectory(): Promise<LocalSkillsSnapshot | null>;
  removeDirectory(id: string): Promise<LocalSkillsSnapshot>;
  importSkill(): Promise<{ snapshot: LocalSkillsSnapshot; skillId: string } | null>;
};
