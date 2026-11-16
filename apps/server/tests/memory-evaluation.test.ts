import test from "node:test";
import assert from "node:assert/strict";
import { MEMORY_EVAL_NOW } from "./fixtures/memory-evaluation.js";
import { runMemoryEvaluation } from "./fixtures/memory-evaluation-runner.js";

test("固定合成语料离线评测报告真实召回、来源边界和未测指标", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(MEMORY_EVAL_NOW) });
  const report = await runMemoryEvaluation();
  assert.deepEqual(await runMemoryEvaluation(), report, "同分语料与重复运行应产生相同指标，不受随机持久ID影响");
  t.diagnostic(JSON.stringify(report));
  assert.equal(report.corpusVersion, "synthetic-memory-v1");
  assert.ok(report.corpusSize > 240);
  for (const row of report.cases) {
    assert.equal(row.current.unauthorizedReturned, 0, row.name);
    assert.equal(row.baseline.unauthorizedReturned, 0, row.name);
    assert.equal(row.current.sourceLocatorPresent, row.current.returned, row.name);
  }
  const old = report.cases.find(row => row.name === "old-important-after-230-noise")!;
  assert.equal(old.current.relevantRetrieved, 1, "不能以最新200条截断漏掉旧重要记录");
  const filtered = report.cases.find(row => row.name === "authorized-after-denied-top-k")!;
  assert.equal(filtered.baseline.relevantRetrieved, 0);
  assert.equal(filtered.current.relevantRetrieved, 1);
  const exhausted = report.cases.find(row => row.name === "bounded-scan-exhausted")!;
  assert.equal(exhausted.current.relevantRetrieved, 0, "预算耗尽要如实记录漏检");
  assert.equal(exhausted.current.scan?.limited, true);
  assert.ok(exhausted.current.matchingCandidatesVisited <= 80);
  assert.equal(report.personal.unapprovedReturned, 0);
  assert.ok(report.personal.selectedChars <= report.personal.budgetChars);
  assert.deepEqual(report.taskReference, { returned: 1, status: "completed", verification: "unverified", reference: "goal" });
  assert.match(report.answerCitationErrorRate, /not measured/);
});
