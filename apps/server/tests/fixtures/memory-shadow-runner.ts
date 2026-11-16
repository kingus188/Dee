import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createModelCatalog, openRuntime, Index } from "@assistant/runtime";
import type { EpisodeRecord } from "@assistant/features";
import { openEpisodeStore } from "../../dist/episode-store.js";
import { createEpisodeReader } from "../../dist/episode-reader.js";
import { MEMORY_EVAL_NOW } from "./memory-evaluation.js";
import { SHADOW_POLICY, SHADOW_QUERIES, SHADOW_ROWS, shadowRank, type ReadSignal } from "./memory-shadow.js";

export async function runShadowEvaluation() {
  const dir = await mkdtemp(join(tmpdir(), "dee-memory-shadow-"));
  const store = openEpisodeStore(dir);
  let reader: ReturnType<typeof createEpisodeReader>, targetId = "";
  let call: { taskId: number; callId: string } | undefined;
  let genuine: EpisodeRecord | undefined;
  const extension = defineExtension({ name: "shadow-evidence-test", tools: [defineTool({ name: "shadow_read", replay: "safe", description: "read test record", parameters: Type.Object({}), execute: async (_args, api) => {
    call = { taskId: api.taskId, callId: api.callId };
    genuine = await reader.read(api.conversationId, targetId, call);
    return { output: [{ type: "text" as const, text: "read" }] };
  } })] });
  const { models, agentModel } = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => transcript.messages.at(-1)?.role === "user"
    ? fauxAssistantMessage(fauxToolCall("shadow_read", {}), { stopReason: "toolUse" }) : fauxAssistantMessage("done"));
  const runtime = await openRuntime({ dataDir: dir, models, agentModel, extensions: [extension], onReport: error => { throw error; } }, ctx);
  try {
    const owner = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: agentModel } }, ctx);
    const denied = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    const revoked = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    await owner.commit(async tx => { (await tx.doc(Index)).items.push(...[owner, denied, revoked].map(item => ({ id: item.id, title: "shadow", createdAt: MEMORY_EVAL_NOW, ...(item.id === denied.id ? { channel: "teams" } : {}) }))); }, ctx);
    for (const row of SHADOW_ROWS) store.add({ label: row.label, summary: row.summary, source: `conv:${row.access === "denied" ? denied.id : row.access === "revoked" ? revoked.id : owner.id}`, channel: row.access === "denied" ? "teams" : "web", periodStart: row.date + "T00:00:00.000Z", periodEnd: row.date + "T00:00:00.000Z", openItems: [] });
    store.revokeSource(`conv:${revoked.id}`);
    reader = createEpisodeReader(runtime, ctx, store, { offline: () => false, teams: { canReadEpisodeSource: async () => false } });
    targetId = store.all().find(row => row.label === "budget-old")!.id;
    const submission = await owner.submit({ type: "input", content: "Read the synthetic old budget record for the offline evidence test." }, ctx); await submission.wait(ctx);
    if (!call || genuine?.readEvidence?.status !== "recorded") throw new Error("real SDK read was not recorded");
    const replay = await reader.read(owner.id, targetId, call);
    const evidence = new Map<string, ReadSignal[]>([["budget-old", [genuine, replay!].map(row => ({ ...row.readEvidence!, episodeId: row.id, revision: row.sourceRevision, ...call! }))]]);
    // Other signals are explicitly synthetic fixed fixtures, not observed usage.
    for (const label of ["fact-a", "fact-b"]) {
      const row = store.all().find(item => item.label === label)!;
      evidence.set(label, [{ episodeId: row.id, revision: row.sourceRevision, taskId: 99999, callId: `synthetic-${label}`, kind: "explicit_read", status: "recorded", observedAt: MEMORY_EVAL_NOW }]);
    }
    const allowed = new Set<string>(SHADOW_ROWS.filter(row => row.access === "private").map(row => row.label));
    const metrics = (rows: EpisodeRecord[], relevant: readonly string[]) => ({ labels: rows.map(row => row.label), hits: rows.filter(row => relevant.includes(row.label)).length, relevantTotal: relevant.length, recall: relevant.length ? rows.filter(row => relevant.includes(row.label)).length / relevant.length : null,
      reciprocalRank: relevant.length ? (rows.findIndex(row => relevant.includes(row.label)) < 0 ? 0 : 1 / (rows.findIndex(row => relevant.includes(row.label)) + 1)) : null,
      sourceErrors: rows.filter(row => !allowed.has(row.label)).length, summaryChars: rows.reduce((sum, row) => sum + row.summary.length, 0), returned: rows.length });
    type Metrics = ReturnType<typeof metrics>;
    const cases: Array<{ name: string; question: string; answerable: boolean; baseline: Metrics;
      variants: Record<string, Metrics & { scoredCandidates: number; tokenChecks: number }>;
      smallPool: Metrics & { scanned?: number }; sharedPool: { labels: string[]; scanned?: number; limited?: boolean; candidates: number }; unanswerableCandidates: number | null }> = [];
    for (const query of SHADOW_QUERIES) {
      const small = await reader.search(owner.id, [...query.tokens], SHADOW_POLICY.topK);
      const pool = await reader.search(owner.id, [...query.tokens], SHADOW_POLICY.candidateLimit);
      const variants = Object.fromEntries((["full", "no-time", "no-read", "lexical-only"] as const).map(variant => {
        const ranked = shadowRank(pool, query.tokens, evidence, variant);
        return [variant, { ...metrics(ranked.slice(0, SHADOW_POLICY.topK).map(item => item.row), query.relevant), scoredCandidates: ranked.length, tokenChecks: ranked.length * query.tokens.length }];
      }));
      cases.push({ name: query.name, question: query.question, answerable: query.answerable, baseline: metrics(pool.slice(0, SHADOW_POLICY.topK), query.relevant), variants,
        smallPool: { ...metrics(small, query.relevant), scanned: small.scan?.scanned }, sharedPool: { labels: pool.map(row => row.label), scanned: pool.scan?.scanned, limited: pool.scan?.limited, candidates: pool.length },
        // Returning candidates on an unanswerable question is not an answer or
        // a successful refusal. Report the risk without assigning model accuracy.
        unanswerableCandidates: query.answerable ? null : pool.length });
    }
    // A watermark transition is simulated storage history, explicitly not 257
    // real model calls. It checks that the same real call becomes retired.
    for (let i = 1; i <= 257; i++) store.read(targetId, 0, { callerId: owner.id, taskId: call.taskId + i, callId: `simulated-history-${i}` });
    const retired = await reader.read(owner.id, targetId, call);
    const answerable = cases.filter(item => item.answerable);
    const aggregate = Object.fromEntries(["baseline", "full", "no-time", "no-read", "lexical-only"].map(name => {
      const results = cases.map(item => name === "baseline" ? item.baseline : item.variants[name]);
      const measured = answerable.map(item => name === "baseline" ? item.baseline : item.variants[name]);
      return [name, { answerableQueries: measured.length, meanRecallAt2: measured.reduce((sum, item) => sum + (item.recall ?? 0), 0) / measured.length,
        mrrAt2: measured.reduce((sum, item) => sum + (item.reciprocalRank ?? 0), 0) / measured.length,
        sourceErrors: results.reduce((sum, item) => sum + item.sourceErrors, 0), returned: results.reduce((sum, item) => sum + item.returned, 0),
        summaryChars: results.reduce((sum, item) => sum + item.summaryChars, 0) }];
    }));
    return { aggregate, corpusVersion: "synthetic-shadow-v1", policy: SHADOW_POLICY, corpusRows: SHADOW_ROWS.length, cases,
      evidence: { genuine: genuine.readEvidence.status, replay: replay?.readEvidence?.status, retired: retired?.readEvidence?.status, simulated: ["fact-a", "fact-b", "257 watermark-history calls"], exposureCountsAsRead: false },
      limitations: ["same authorized candidate pool only; cannot recover excluded matches", "lexical relevance only; no semantic expansion", "read activity is not correctness or importance", "summary characters, not complete context tokens", "answer accuracy/citation errors/refusal accuracy/real tokens/cost: not measured", "synthetic corpus, not a model benchmark"] };
  } finally { await runtime.harness.close(ctx); store.close(); await rm(dir, { recursive: true, force: true }); }
}
