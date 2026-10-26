import { createHash } from "node:crypto";
import { isAbsolute, normalize, resolve } from "node:path";

export const LIMITS = {
  headerBytes: 16 * 1024,
  detailBytes: 1024 * 1024,
  scanDepth: 4,
  scanEntries: 10_000,
  customRoots: 64,
  stateBytes: 64 * 1024,
  importDepth: 16,
  importEntries: 2_000,
  importFileBytes: 10 * 1024 * 1024,
  importTotalBytes: 50 * 1024 * 1024,
} as const;

export interface SkillRoot {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  custom: boolean;
}
export interface SkillLocation { rootId: string; label: string; path: string }
export interface LocalSkill {
  id: string;
  name: string;
  description: string;
  locations: SkillLocation[];
  issue?: string;
}
export interface SkillSnapshot { roots: SkillRoot[]; skills: LocalSkill[]; warnings: string[] }
export interface SkillDetail extends LocalSkill { content: string; filePath: string }

export function pathId(kind: "root" | "skill", path: string): string {
  return `${kind}_${createHash("sha256").update(resolve(path)).digest("hex")}`;
}

export function checkedId(value: unknown, kind: "root" | "skill"): string {
  if (typeof value !== "string" || !new RegExp(`^${kind}_[a-f0-9]{64}$`).test(value)) {
    throw new Error(`Invalid ${kind} id`);
  }
  return value;
}

export function absoluteDirectory(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0") || !isAbsolute(value)) {
    throw new Error("Expected an absolute directory path");
  }
  return normalize(value);
}

export function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "";
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
