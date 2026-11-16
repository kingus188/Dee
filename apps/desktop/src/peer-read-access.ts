import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { resolve } from "node:path";
import type { PeerJob } from "@assistant/runtime";

export function peerWorkspaceRoot(workspace: string | null | undefined): string | undefined {
  if (!workspace) return undefined;
  try { return realpathSync(workspace); } catch { return undefined; }
}

export function peerPathWithin(root: string, candidate: string, paths: Pick<typeof path, "relative" | "isAbsolute" | "sep"> = path): boolean {
  const relative = paths.relative(root, candidate);
  return relative === "" || !paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`);
}

/** A read boundary check, not an OS sandbox against concurrent filesystem mutation. */
export async function peerReadAllowed(job: PeerJob, call: { name: string; arguments: unknown }, workspace: string | null | undefined): Promise<boolean> {
  if (call.name !== "read") return true;
  const root = job.readScope?.resourceRoot;
  if (!root || !workspace || !call.arguments || typeof call.arguments !== "object" || !("path" in call.arguments) || typeof call.arguments.path !== "string") return false;
  try {
    if (await realpath(workspace) !== root || job.workspace && await realpath(job.workspace) !== root) return false;
    const candidate = await realpath(resolve(root, call.arguments.path));
    return peerPathWithin(root, candidate);
  } catch { return false; }
}
