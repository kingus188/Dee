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
