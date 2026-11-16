import test from "node:test";
import assert from "node:assert/strict";
import { MEMORY_EVAL_NOW } from "./fixtures/memory-evaluation.js";
import { readStrength, SHADOW_POLICY } from "./fixtures/memory-shadow.js";
import { runShadowEvaluation } from "./fixtures/memory-shadow-runner.js";

test("离线影子评分使用同一真实授权候选池并保留失败与消融结果", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(MEMORY_EVAL_NOW) });
  const result = await runShadowEvaluation();
  assert.deepEqual(await runShadowEvaluation(), result, "固定时钟与语料重复运行结果一致");
  t.diagnostic(JSON.stringify(result));
  assert.deepEqual(result.evidence, { genuine: "recorded", replay: "replayed", retired: "outside_window", simulated: ["fact-a", "fact-b", "257 watermark-history calls"], exposureCountsAsRead: false });
  for (const item of result.cases) {
    assert.deepEqual(item.baseline.labels, item.sharedPool.labels.slice(0, SHADOW_POLICY.topK));
    assert.equal(item.baseline.sourceErrors, 0);
    for (const metrics of Object.values(item.variants)) {
      assert.equal(metrics.sourceErrors, 0);
      assert.ok(metrics.labels.every(label => item.sharedPool.labels.includes(label)));
      assert.equal(metrics.scoredCandidates, item.sharedPool.candidates);
    }
  }
  assert.equal(result.cases.find(row => row.name === "old-important")!.variants.full.hits, 1);
  const contradiction = result.cases.find(row => row.name === "updated-contradiction")!;
  assert.equal(contradiction.baseline.hits, 1);
  assert.equal(contradiction.variants.full.hits, 0, "读过旧事实不意味着它仍正确，保留本次退化");
  assert.deepEqual(contradiction.variants.full.labels, ["budget-old", "budget-noise"]);
  assert.equal(result.cases.find(row => row.name === "historical-time")!.variants.full.reciprocalRank, 0.5, "新近加分不能回答历史日期语义");
  assert.equal(result.cases.find(row => row.name === "unanswerable-no-match")!.sharedPool.candidates, 0);
  assert.ok(result.cases.find(row => row.name === "unanswerable-with-noisy-match")!.unanswerableCandidates! > 0);
});
test("影子读取分量有界且replay、retired及曝光不能增加信号", () => {
  const row = { id: "episode", sourceRevision: 2 };
  const original = { episodeId: row.id, revision: 2, taskId: 9, callId: "read", kind: "explicit_read" as const, status: "recorded" as const, observedAt: MEMORY_EVAL_NOW };
  assert.equal(readStrength([original], row), 1);
  assert.equal(readStrength([original, { ...original, status: "replayed" }, { ...original, status: "outside_window" }], row), 1);
  assert.equal(readStrength([{ ...original, status: "replayed" }, { ...original, status: "unverified" }], row), 0);
  assert.equal(readStrength([{ ...original, revision: 1 }, { ...original, observedAt: "not-a-date" }, { ...original, observedAt: "2030-01-01" }], row), 0);
  const old = { ...original, observedAt: "2026-09-02T12:00:00.000Z" };
  assert.equal(readStrength([old, old], row), 0.25);
  assert.equal(readStrength([old, { ...old, callId: "another" }], row), 0.5);
  assert.ok(SHADOW_POLICY.timeWeight + SHADOW_POLICY.readWeight < SHADOW_POLICY.relevanceWeight);
});
