import type { Context } from "@earendil-works/chord";
import type { Extension, ModelRef, Conversation } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Meta } from "./documents.js";

export type RuntimeOptions = { dataDir: string; models: Models; agentModel: ModelRef; extensions: readonly Extension[]; onReport: (error: unknown) => void };
export async function openRuntime(options: RuntimeOptions, context: Context): Promise<Runtime> {
  await mkdir(options.dataDir, { recursive: true });
  const registry = createRegistry();
  for (const extension of options.extensions) registry.install(extension);
  const storage = await openNodeSqliteStorage(join(options.dataDir, "agent.sqlite"));
  const harness = await Harness.open(storage, { models: options.models, registry, onReport: options.onReport }, context);
  const root = await harness.root(context, { agent: { model: options.agentModel } });
  await root.commit(async (tx) => {
    const meta = await tx.doc(Meta);
    meta.boots += 1;
    meta.lastBootAt = new Date().toISOString();
  }, context);
  harness.resume();
  return { harness, root, agentModel: options.agentModel };
}
export type Runtime = { harness: Harness; root: Conversation; agentModel: ModelRef };
