import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalKnowledge } from "../dist/local-knowledge.js";

// Deterministic filesystem fixtures, not a language-model relevance benchmark.
test("固定资料语料从未知文件名找到正文并按内容版本读取精确行", async t => {
  const root = await mkdtemp(join(tmpdir(), "dee-knowledge-eval-"));
  try {
    await mkdir(join(root, "notes"));
    const path = "notes/a7.md";
    const source = "# 日常记录\n普通事项\n星图校验需要双人签字。\n其他记录\n";
    await writeFile(join(root, path), source);
    await writeFile(join(root, "b8.txt"), "服务在中断后能够自动恢复。\n");
    const knowledge = createLocalKnowledge(() => ({ directory: root, revision: 1 }));
    const found = await knowledge.search("星图校验");
    assert.equal(found.status, "matched"); assert.equal(found.hits.length, 1);
    const hit = found.hits[0]!;
    assert.equal(hit.path, path); assert.equal(hit.line, 3);
    assert.ok(!hit.path.includes("星图"));
    const page = await knowledge.read(hit.path, hit.revision, hit.line);
    assert.equal(page.startLine, 3);
    assert.equal(page.text, source.split(/\r?\n/).slice(page.startLine - 1, page.endLine).join("\n"));
    assert.equal(page.revision, hit.revision); assert.equal(page.truncated, false);
    const lexicalGap = await knowledge.search("故障自愈");
    assert.equal(lexicalGap.hits.length, 0, "未覆盖词义不能虚称语义检索命中");
    // Same byte length and restored modification time defeat metadata-only versions.
    const file = join(root, path);
    await utimes(file, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    const before = await stat(file);
    const changed = source.replace("双人", "单人");
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(source));
    await writeFile(file, changed); await utimes(file, before.atime, before.mtime);
    const after = await stat(file);
    assert.equal(after.size, before.size); assert.equal(Math.trunc(after.mtimeMs), Math.trunc(before.mtimeMs));
    await assert.rejects(knowledge.read(hit.path, hit.revision, hit.line), /版本|变化/);
    const refreshed = await knowledge.search("星图校验");
    assert.notEqual(refreshed.hits[0]!.revision, hit.revision);
    assert.match((await knowledge.read(path, refreshed.hits[0]!.revision, 3)).text, /单人签字/);
    t.diagnostic(JSON.stringify({ version: "synthetic-local-knowledge-v1", lexicalHits: 1, lexicalTruth: 1, expectedLine: 3, sameMetadataMutationRejected: true,
      semanticQueryHits: lexicalGap.hits.length, semanticTruth: 1, returnedExcerptChars: hit.excerpt.length, scan: found.scan,
      limitations: "Exact source identity and lexical retrieval only; broad semantic recall/model accuracy/tokens/fees not measured." }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("资料截断报告保留行号和预算，符号链接与穿越不能替代授权内容", async () => {
  const root = await mkdtemp(join(tmpdir(), "dee-knowledge-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "dee-knowledge-outside-"));
  try {
    const long = "长行标记 " + "甲".repeat(9000);
    await writeFile(join(root, "long.txt"), long);
    await writeFile(join(outside, "outside.txt"), "外部记录不可泄漏");
    await symlink(join(outside, "outside.txt"), join(root, "link.txt"));
    await symlink(outside, join(root, "linked-folder"));
    const knowledge = createLocalKnowledge(() => ({ directory: root, revision: 1 })), found = await knowledge.search("长行标记");
    const hit = found.hits[0]!;
    assert.equal(hit.line, 1); assert.equal(hit.endLine, 1); assert.ok(hit.excerpt.length <= 1200);
    const page = await knowledge.read(hit.path, hit.revision, 1);
    assert.equal(page.startLine, 1); assert.equal(page.endLine, 1); assert.equal(page.truncated, true);
    assert.ok(page.text.length <= 6200); assert.equal(page.text, long.slice(0, page.text.length));
    for (const path of ["../outside.txt", join(outside, "outside.txt"), "link.txt", "linked-folder/outside.txt"]) {
      await assert.rejects(knowledge.read(path, hit.revision, 1), /路径|符号链接|范围|越界/);
    }
    assert.equal((await knowledge.search("外部记录不可泄漏")).hits.length, 0);
    await assert.rejects(knowledge.read(hit.path, hit.revision, 2), /行号/);
    assert.equal(await readFile(join(outside, "outside.txt"), "utf8"), "外部记录不可泄漏");
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("无命中和扫描受限、格式不支持、目录不可访问保持可区分", async t => {
  const root = await mkdtemp(join(tmpdir(), "dee-knowledge-coverage-"));
  try {
    const knowledge = createLocalKnowledge(() => ({ directory: root, revision: 1 }));
    await writeFile(join(root, "plain.txt"), "普通短文");
    const empty = await knowledge.search("独特不存在关键词");
    assert.equal(empty.status, "no_matches"); assert.equal(empty.scan.limited, false); assert.equal(empty.scan.inaccessible, 0);
    await writeFile(join(root, "document.pdf"), "未实现PDF解析的模拟资料");
    await writeFile(join(root, "binary.txt"), Buffer.from([0, 1, 255, 2]));
    await writeFile(join(root, "oversize.md"), "甲".repeat(100000));
    const unsupported = await knowledge.search("独特不存在关键词");
    assert.equal(unsupported.hits.length, 0);
    assert.ok(unsupported.scan.unsupported > 0);
    assert.notDeepEqual(unsupported.scan, empty.scan, "跳过资料必须显式反映覆盖差异");
    assert.equal(unsupported.status, "partial");
    for (let i = 0; i < 205; i++) await writeFile(join(root, `n${i}.txt`), "普通短文");
    const budget = await knowledge.search("独特不存在关键词");
    assert.equal(budget.status, "partial"); assert.equal(budget.scan.limited, true); assert.ok(budget.scan.files <= 200);
    await assert.rejects(createLocalKnowledge(() => ({ directory: join(root, "missing"), revision: 1 })).search("关键词"));
    await assert.rejects(createLocalKnowledge(() => ({ directory: null, revision: 1 })).search("关键词"), /选择资料目录/);
    t.diagnostic(JSON.stringify({ completeNoHit: empty.scan, excludedContent: unsupported.scan, boundedScan: budget.scan,
      inaccessibleRoot: "explicit rejection", limitation: "No match under a scan cap is not evidence of absence; unsupported bytes are not searched." }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
