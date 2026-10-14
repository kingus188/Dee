import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearMaterialsCache, loadMaterials, readMaterial, searchMaterials } from "@assistant/features";

test("生产资料：状态、两字中文词、关键词排序与读取安全", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-materials-"));
	try {
		await mkdir(join(root, "流程/归档"), { recursive: true });
		await mkdir(join(root, "待确认"), { recursive: true });
		await writeFile(join(root, "流程/报销.md"), "# 报销\n先提交申请单，再由财务审批。\n");
		await writeFile(join(root, "流程/归档/旧报销.md"), "旧版报销流程。\n");
		await writeFile(join(root, "待确认/出差.md"), "出差报销标准待定。\n");
		await writeFile(join(root, "外面.md"), "仓库外内容\n");
		await symlink(join(root, "外面.md"), join(root, "链接.md"));
		clearMaterialsCache();
		const files = await loadMaterials(root);
		assert.equal(files.some((file) => file.path === "链接.md"), false, "符号链接不进入语料");
		const hits = searchMaterials(files, "报销 审批");
		assert.deepEqual(hits.map((hit) => [hit.path, hit.status]), [["流程/报销.md", "current"], ["待确认/出差.md", "draft"]], "两字中文词可命中；归档默认隐藏；命中关键词多的靠前");
		assert.match(hits[0].excerpt, /审批/);
		assert.equal(searchMaterials(files, "旧版", true)[0].status, "archived");
		assert.equal(searchMaterials(files, "不存在的词").length, 0);

		assert.equal((await readMaterial(root, "待确认/出差.md")).status, "draft");
		await assert.rejects(readMaterial(root, "../x.md"), /跳出/);
		await assert.rejects(readMaterial(root, "链接.md"), /符号链接/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("对话写入：先进待确认，确认后成为现行，同名旧资料归档，路径和凭据受限", async () => {
	const { approveMaterial, discardMaterial, saveMaterial } = await import("@assistant/features");
	const root = await mkdtemp(join(tmpdir(), "pi-materials-write-"));
	try {
		const draft = await saveMaterial(root, { category: "流程", title: "报销流程", content: "# 报销流程\n\n单笔 500 元以下部门负责人审批。", source: "用户口述" });
		assert.equal(draft, "待确认/流程/报销流程.md");
		clearMaterialsCache();
		let files = await loadMaterials(root);
		assert.deepEqual(files.map((file) => [file.path, file.status]), [[draft, "draft"]], "刚保存的资料是草稿，不是现行依据");
		assert.equal(files[0].text.match(/^# 报销流程$/gm)?.length, 1, "标题不重复");
		assert.match(files[0].text, /更新日期：\d{4}-\d{2}-\d{2}\n来源：用户口述/);

		assert.deepEqual(await approveMaterial(root, draft), { path: "流程/报销流程.md", archived: null });
		assert.deepEqual(await approveMaterial(root, draft), { path: "流程/报销流程.md", archived: null }, "重复确认不报错");
		files = await loadMaterials(root);
		assert.deepEqual(files.map((file) => [file.path, file.status]), [["流程/报销流程.md", "current"]]);

		const next = await saveMaterial(root, { category: "流程", title: "报销流程", content: "单笔 800 元以下部门负责人审批。", source: "用户口述" });
		const done = await approveMaterial(root, next);
		assert.match(done.archived ?? "", /^流程\/归档\/报销流程-\d{14}\.md$/);
		clearMaterialsCache();
		files = await loadMaterials(root);
		assert.deepEqual(files.map((file) => file.status).sort(), ["archived", "current"], "旧版归档，新版现行");
		assert.match(files.find((file) => file.status === "current")!.text, /800 元/);

		const unwanted = await saveMaterial(root, { category: "常见问答", title: "不要的", content: "错误内容", source: "测试" });
		await discardMaterial(root, unwanted);
		await discardMaterial(root, unwanted);
		clearMaterialsCache();
		assert.equal((await loadMaterials(root)).some((file) => file.path === unwanted), false);

		await assert.rejects(saveMaterial(root, { category: "流程", title: "密钥", content: "token: abcdef1234567890", source: "测试" }), /不能包含/);
		await assert.rejects(saveMaterial(root, { category: "../外面", title: "x", content: "x", source: "测试" }), /跳出/);
		await assert.rejects(saveMaterial(root, { category: "待确认", title: "x", content: "x", source: "测试" }), /分类/);
		await assert.rejects(approveMaterial(root, "流程/报销流程.md"), /待确认/);
		await assert.rejects(discardMaterial(root, "流程/报销流程.md"), /待确认/, "不能删除现行资料");
		await assert.rejects(approveMaterial(root, "待确认/不存在.md"), /找不到/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
