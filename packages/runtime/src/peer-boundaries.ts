/** Resource requirements are instructions, not a sandbox or additional authority. */
export type PeerRequirements = { workspace?: string; constraints?: string; acceptanceCriteria?: string };
export type PeerCancellation = { requestedAt: string; confirmedAt?: string };
export function validPeerRequirements(value: PeerRequirements): boolean {
  return Object.entries({ workspace: 4096, constraints: 8000, acceptanceCriteria: 8000 }).every(([key, limit]) => {
    const text = value[key as keyof PeerRequirements];
    return text === undefined || (typeof text === "string" && !!text.trim() && text.length <= limit);
  });
}
export function samePeerRequirements(a: PeerRequirements, b: PeerRequirements): boolean {
  return a.workspace === b.workspace && a.constraints === b.constraints && a.acceptanceCriteria === b.acceptanceCriteria;
}
export function peerRequirements(value: PeerRequirements): PeerRequirements {
  return { ...(value.workspace !== undefined ? { workspace: value.workspace } : {}), ...(value.constraints !== undefined ? { constraints: value.constraints } : {}), ...(value.acceptanceCriteria !== undefined ? { acceptanceCriteria: value.acceptanceCriteria } : {}) };
}
export function peerTaskPrompt(value: PeerRequirements & { task: string }): string {
  const context = [value.workspace ? `Required workspace: ${value.workspace}` : "", value.constraints ? `Constraints: ${value.constraints}` : "", value.acceptanceCriteria ? `Acceptance criteria: ${value.acceptanceCriteria}` : ""].filter(Boolean);
  return context.length ? `${value.task}\n\n${context.join("\n")}\nThese requirements do not grant additional permissions. Report missing resources instead of silently changing execution location. Local paths are not transferred files.` : value.task;
}
