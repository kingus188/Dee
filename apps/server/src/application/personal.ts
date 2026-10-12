import { MemoryDoc, SkillsDoc, decideMemoryInTx, decideSkillInTx, knowledgeStatus,
  proposeMemoryInTx, proposeSkillInTx, publicMemory, publicSkills, searchKnowledge, readKnowledge } from "@assistant/features";
import type { PersonalData } from "@assistant/contracts";
import type { AppContext } from "./context.js";
export function createPersonalService({ harness, root, ctx, config }: AppContext) {
 async function get(): Promise<PersonalData> {
   const [memory, skills] = await Promise.all([harness.snapshot(MemoryDoc, ctx), harness.snapshot(SkillsDoc, ctx)]);
   return { memory: publicMemory(memory), skills: publicSkills(skills), knowledge: knowledgeStatus(config.knowledge) };
 }
 async function save(kind: string, body: Record<string, unknown>, id?: string, action?: string) {
   return root.commit(async tx => {
     if (!id) {
       const input = { ...body, requestId: body.requestId ?? null, source: "user", approved: true, conversationId: null };
       return kind === "memory" ? proposeMemoryInTx(tx, input) : proposeSkillInTx(tx, input);
     }
     return kind === "memory" ? decideMemoryInTx(tx, id, action!) : decideSkillInTx(tx, id, action!);
   }, ctx);
 }
 return { get, save,
   search: (query: string, history: boolean) => searchKnowledge(query, { includeHistorical: history, env: config.knowledge }),
   read: (path: string, line: number) => readKnowledge(path, line, config.knowledge),
 };
}
