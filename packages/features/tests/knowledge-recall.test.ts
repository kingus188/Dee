import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bestLine, clearKnowledgeCache, searchKnowledge } from "@assistant/features";
import { bestMatchingLine } from "../dist/search/index.js";

test("共享检索由调用方显式选择部分命中，知识默认保持严格", () => {
	assert.equal(bestMatchingLine("报销申请", "报销 审批").score, 0);
	const partial = bestMatchingLine("报销申请", "报销 审批", { requireAll: false });
	assert.ok(partial.score > 0);
	assert.equal(partial.matched, 1); assert.equal(partial.total, 2);
	assert.ok(bestMatchingLine("报销申请\n主管审批", "报销 审批", { requireAll: false }).score > partial.score);
	assert.equal(bestMatchingLine("没有相关业务", "报销 审批", { requireAll: false }).score, 0);
});

test("中文自然问句去除问法并按真实证据行命中", () => {
	assert.equal(bestLine("# 无关标题\n登录采用公司 SSO。\n报销申请需要主管审批。", "请问报销怎么审批？").line, 3);
	assert.ok(bestLine("报销申请需要主管审批。", "请问报销怎么审批？").score > 0);
	assert.equal(bestLine("这里没有业务证据", "请问怎么操作呢？").score, 0);
});

test("中英同义词、大小写和英文词边界保持可预测", () => {
	assert.ok(bestLine("用户通过单点登录进入后台。", "How does SSO login work?").score > 0);
	assert.ok(bestLine("发布前执行部署流程。", "怎样上线？").score > 0);
	assert.equal(bestLine("The concatenate helper changes a string.", "cat").score, 0);
	assert.ok(bestLine("服务支持 Deployment rollback.", "回滚 deployment").score > 0);
	assert.equal(bestLine("先发起报销。\n后提交发票。", "报销 发票").line, 1);
	assert.equal(bestLine("# 项目\n当前使用 PostgreSQL 数据库。", "How is PostgreSQL configured?").line, 2);
});

test("自然问句保留白名单、历史过滤、路径行号和原文证据", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-recall-"));
	const prefix = "My-VPS/我的VPS/AI学习", allow = join(root, prefix);
	try {
		await mkdir(join(allow, "归档"), { recursive: true });
		await mkdir(join(allow, "my-info"), { recursive: true });
		await writeFile(join(allow, "审批.md"), "# 现行流程\n\n报销申请需要主管审批，附发票。\n由财务复核。\n");
		await writeFile(join(allow, "归档", "旧.md"), "报销申请以前由前台审批。\n");
		await writeFile(join(allow, "my-info", "私密.md"), "报销申请审批与个人信息。\n");
		await writeFile(join(root, "外部.md"), "报销申请审批外部证据。\n");
		await symlink(join(root, "外部.md"), join(allow, "链接.md"));
		clearKnowledgeCache();
		const env = { OBSIDIAN_ROOT: root }, query = "请问报销怎么审批？";
		const found = await searchKnowledge(query, { env });
		assert.equal(found.query, query); assert.equal(found.hits.length, 1);
		assert.equal(found.hits[0].path, `${prefix}/审批.md`);
		assert.equal(found.hits[0].line, 3); assert.equal(found.hits[0].endLine, 5);
		assert.match(found.hits[0].excerpt, /^报销申请需要主管审批/);
		assert.match(found.hits[0].revision, /^\d+:\d+$/);
		const history = await searchKnowledge(query, { env, includeHistorical: true });
		assert.equal(history.hits.some(hit => hit.status === "archived"), true);
		assert.equal(history.hits.some(hit => /私密|外部|链接/.test(hit.path)), false);
	} finally { clearKnowledgeCache(); await rm(root, { recursive: true, force: true }); }
});

test("精确原句优先于同义命中，多主题问句要求每个主题有证据", () => {
	const exact = bestLine("报销怎么审批", "报销怎么审批");
	const synonym = bestLine("费用申请需要审核", "报销怎么审批");
	assert.ok(exact.score > synonym.score);
	assert.equal(bestLine("报销需要审批。", "报销 VPN").score, 0);
	assert.equal(bestLine("如何配置数据库", "不存在的产品名").score, 0);
});
