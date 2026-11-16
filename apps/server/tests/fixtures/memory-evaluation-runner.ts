import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, openRuntime, Index } from "@assistant/runtime";
import { Goals, selectMemoryForPrompt } from "@assistant/features";
import type { Goal } from "@assistant/contracts";
import { openEpisodeStore } from "../../dist/episode-store.js";
import { createEpisodeReader } from "../../dist/episode-reader.js";
import { createEpisodeOpenItems } from "../../dist/episode-open-items.js";
import { MEMORY_EVAL_VERSION, MEMORY_EVAL_NOW, MEMORY_EVAL_CASES, PERSONAL_EVAL_ITEMS } from "./memory-evaluation.js";

export async function runMemoryEvaluation() {
  const dir = await mkdtemp(join(tmpdir(), "dee-memory-eval-"));
  const store = openEpisodeStore(dir);
  const { models, agentModel } = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("已记录"));
  const runtime = await openRuntime({ dataDir: dir, models, agentModel, extensions: [], onReport: error => { throw error; } }, ctx);
  try {
    const caller = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: agentModel } }, ctx);
    const denied = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    const revoked = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    await caller.commit(async tx => {
      (await tx.doc(Index)).items.push(...[caller, denied, revoked].map(owner => ({ id: owner.id, title: "synthetic", createdAt: MEMORY_EVAL_NOW, ...(owner === denied ? { channel: "teams" } : {}) })));
    }, ctx);
    const add = (label: string, summary: string, source = `conv:${caller.id}`, channel = "web", at = MEMORY_EVAL_NOW, openItems: string[] = [], messageIds: string[] = []) => store.add({ label, summary, source, channel, periodStart: at, periodEnd: at, openItems, messageIds });
    add("old-important", "事故处置必须保留回滚窗口24小时。", undefined, undefined, "2026-01-01T00:00:00.000Z");
    add("allowed-evidence", "发布依据必须保留审核记录。", undefined, undefined, "2026-02-01T00:00:00.000Z");
    for (let i = 0; i < 230; i++) add(`noise-${i}`, "近期讨论午餐安排，与发布操作无关。");
    for (let i = 0; i < 12; i++) add(`denied-${i}`, "发布依据：外部渠道的不可访问记录。", `conv:${denied.id}`, "teams");
    add("beyond-budget", "扫描预算之后的合法依据。", undefined, undefined, "2026-03-01T00:00:00.000Z");
    for (let i = 0; i < 90; i++) add(`budget-denied-${i}`, "扫描预算内的不可访问资料。", `conv:${denied.id}`, "teams");
    add("revoked", "撤回资料不可检索。", `conv:${revoked.id}`); store.revokeSource(`conv:${revoked.id}`);
    add("remote-denied", "远端资料不能离线兜底。", "teams:denied", "teams");
    let probes = 0, pageReads = 0, matchedRowsVisited = 0;
    const searchPage = store.searchPage;
    store.searchPage = (...args) => { const page = searchPage(...args); pageReads++; matchedRowsVisited += page.items.length; return page; };
    const reader = createEpisodeReader(runtime, ctx, store, { offline: () => false, teams: { canReadEpisodeSource: async () => { probes++; return false; } } });
    const known = new Set(["old-important", "allowed-evidence", "beyond-budget", ...Array.from({ length: 230 }, (_, i) => `noise-${i}`)]);
    const metrics = (rows: { label: string; summary: string; source: string; sourceRevision: number; messageIds: string[] }[], truth: readonly string[]) => {
      const retrieved = new Set(rows.map(row => row.label));
      return { relevantRetrieved: truth.filter(id => retrieved.has(id)).length, relevantTotal: truth.length, returned: rows.length,
        unauthorizedReturned: rows.filter(row => !known.has(row.label)).length,
        summaryChars: rows.reduce((sum, row) => sum + row.summary.length, 0),
        evidenceMessageIdsPresent: rows.filter(row => row.messageIds.length > 0).length,
        sourceLocatorPresent: rows.filter(row => !!row.source && Number.isSafeInteger(row.sourceRevision) && Array.isArray(row.messageIds)).length };
    };
    const cases = [];
    for (const scenario of MEMORY_EVAL_CASES) {
      // Old strategy simulation, not an execution of an old commit. Both paths
      // use the real host reader for authorization, never an invented ACL.
      const before = probes;
      const candidates = store.search([...scenario.tokens], scenario.limit);
      const baseline = (await Promise.all(candidates.map(row => reader.read(caller.id, row.id)))).filter(row => row !== undefined);
      const baselineProbes = probes - before;
      const currentStart = probes, pagesBefore = pageReads, rowsBefore = matchedRowsVisited;
      const current = await reader.search(caller.id, [...scenario.tokens], scenario.limit);
      cases.push({ name: scenario.name, baseline: { ...metrics(baseline, scenario.relevant), permissionProbes: baselineProbes }, current: { ...metrics(current, scenario.relevant), permissionProbes: probes - currentStart, searchPages: pageReads - pagesBefore, matchingCandidatesVisited: matchedRowsVisited - rowsBefore, scan: (current as typeof current & { scan?: { scanned: number; limited: boolean } }).scan ?? null } });
    }
    const selected = selectMemoryForPrompt(PERSONAL_EVAL_ITEMS, 100);
    const goalId = "11111111-1111-4111-8111-111111111111";
    const submitted = await caller.submit({ type: "input", content: `核对委托 ${goalId}` }, ctx); await submitted.wait(ctx);
    const entry = (await caller.entries({}, 20, undefined, ctx)).items.find(row => row.kind === "pi.user")!;
    await caller.commit(async tx => { (await tx.doc(Goals)).items.push({ id: goalId, conversationId: caller.id, status: "completed", text: "核对", criteria: "核对", revision: 1, round: 0, usedTokens: 0, workers: [], maxRounds: 1, deadlineAt: 1, createdAt: 1, updatedAt: 1, summary: "完成", wakeAt: null, updates: [], history: [] } satisfies Goal); }, ctx);
    add("completed-target", "委托已结束但摘要事项尚未验证。", undefined, undefined, MEMORY_EVAL_NOW, [`核对委托 ${goalId}`], [String(entry.id)]);
    const enrichment = createEpisodeOpenItems({ harness: runtime.harness, ctx, daylight: {} as Parameters<typeof createEpisodeOpenItems>[0]["daylight"], sourceAllowed: row => store.sourceAllowed(row.source, row.sourceRevision, row.messageIds) });
    const open = await enrichment.items(store.all().find(row => row.label === "completed-target")!);
    return { corpusVersion: MEMORY_EVAL_VERSION, corpusSize: store.all().length, syntheticSourceEvidence: "retrieval rows have locators only; task-reference case uses real SDK entry", baselineKind: "pre-authorization-top-k simulation; not old-commit measurement", cases,
      personal: { budgetChars: 100, selectedChars: selected.reduce((sum, item) => sum + item.text.length, 0), selected: selected.map(item => item.id), relevantRetrieved: selected.filter(item => item.relevant).length, relevantTotal: 1, unapprovedReturned: selected.filter(item => item.status !== "approved").length },
      taskReference: { returned: open.length, status: open[0]?.taskStatus, verification: open[0]?.verification, reference: open[0]?.taskReference?.kind },
      answerCitationErrorRate: "not measured: no model answers evaluated", realTokens: "not measured", monetaryCost: "not measured", contextMetric: "summary characters only, not rendered full prompt or tokens" };
  } finally { await runtime.harness.close(ctx); store.close(); await rm(dir, { recursive: true, force: true }); }
}
