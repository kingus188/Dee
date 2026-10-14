import type { Context } from "@earendil-works/chord";
import type { Extension, ModelRef, Conversation, Cursor } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AgentDoc, configure, Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Meta } from "./documents.js";

export type RuntimeOptions = { dataDir: string; models: Models; agentModel: ModelRef; extensions: readonly Extension[]; onReport: (error: unknown) => void; resume?: boolean };
export async function openRuntime(options: RuntimeOptions, context: Context): Promise<Runtime> {
  await mkdir(options.dataDir, { recursive: true });
  const registry = createRegistry();
  for (const extension of options.extensions) registry.install(extension);
  const storage = await openNodeSqliteStorage(join(options.dataDir, "agent.sqlite"));
  const harness = await Harness.open(storage, { models: options.models, registry, onReport: options.onReport }, context);
  try {
    const root = await harness.root(context, { agent: { model: options.agentModel } });
    await root.commit(async (tx) => {
      const meta = await tx.doc(Meta);
      meta.boots += 1;
      meta.lastBootAt = new Date().toISOString();
    }, context);
    // The app has one configured provider. Rebind its persisted chats before resuming work.
    // shortcut: pending generation checkpoints retain their model ID; switch models after replies finish.
    if (options.resume !== false && options.agentModel.provider === "demo") {
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanConversations({}, 100, cursor, context);
        await root.commit(async tx => {
          for (const conversation of page.items) {
            const model = (await tx.doc(AgentDoc, conversation.id)).model;
            if (model?.provider === "demo" && model.modelId !== options.agentModel.modelId) {
              await configure(tx, conversation.id, { model: options.agentModel });
            }
          }
        }, context);
        cursor = page.next;
      } while (cursor !== undefined);
    }
    if (options.resume !== false) harness.resume();
    return { harness, root, agentModel: options.agentModel };
  } catch (error) {
    await harness.close(context);
    throw error;
  }
}
export type Runtime = { harness: Harness; root: Conversation; agentModel: ModelRef };
