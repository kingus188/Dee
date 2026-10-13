import type { PersonalData } from "@assistant/contracts";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

async function freePort() {
	return new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			server.close(() => resolve(port));
		});
	});
}
async function launch(dataDir: string, port: number, overrides: NodeJS.ProcessEnv = {}) {
	let logs = "";
	const child = spawn(process.execPath, [fileURLToPath(new URL("../../apps/server/dist/main.js", import.meta.url))], {
		cwd: process.cwd(),
		env: {
			...process.env, LLM_API: "faux", DATA_DIR: dataDir, PORT: String(port), NODE_ENV: "test",
			DEMO_PASSWORD: "", NOTIFY_MODE: "off", OBSIDIAN_ROOT: "", OBSIDIAN_ALLOW: "", ...overrides,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
	child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
	const origin = "http://127.0.0.1:" + port;
	for (let i = 0; i < 100; i++) {
		if (child.exitCode !== null) throw new Error("服务启动失败：" + logs);
		try { const response = await fetch(origin + "/api/info"); if (response.ok || response.status === 401) return { child, origin, logs: () => logs }; } catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	child.kill("SIGKILL");
	throw new Error("服务启动超时：" + logs);
}
async function stop(child: ChildProcess) {
	if (child.exitCode !== null) return;
	await new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.kill("SIGTERM");
		setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000).unref();
	});
}
async function post(origin: string, path: string, data: unknown = {}) {
	const response = await fetch(origin + path, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
	});
	const body = await response.json();
	assert.equal(response.status < 400, true, JSON.stringify(body));
	return body;
}

test("记忆、技能和知识库接口", { timeout: 30000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-personal-"));
	const note = join(dir, "vault/My-VPS/我的VPS/AI学习");
	await mkdir(join(note, "归档"), { recursive: true });
	await writeFile(join(note, "现行.md"), "现行写作规则是先核对来源。\n");
	await writeFile(join(note, "归档", "旧.md"), "归档里的旧写作规则。\n");
	let app;
	try {
		app = await launch(join(dir, "data"), await freePort(), { OBSIDIAN_ROOT: join(dir, "vault") });
		const created = await post(app.origin, "/api/personal/memory", { text: "回复用简体中文", requestId: "mem-1" });
		assert.equal(created.item.status, "approved");
		const again = await post(app.origin, "/api/personal/memory", { text: "另一条", requestId: "mem-1" });
		assert.equal(again.item.id, created.item.id);
		await post(app.origin, "/api/personal/memory/" + created.item.id + "/reject");
		const skill = await post(app.origin, "/api/personal/skills", {
			name: "发布前检查", description: "准备部署时", body: "先跑 pnpm test。", requestId: "skill-1",
		});
		assert.equal(skill.item.status, "approved");
		const duplicate = await fetch(app.origin + "/api/personal/skills", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "发布前检查", description: "另一条", body: "别的步骤", requestId: "skill-2" }),
		});
		assert.equal(duplicate.status, 400);
		const reserved = await fetch(app.origin + "/api/personal/memory", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "坏键", requestId: "__proto__" }),
		});
		assert.equal(reserved.status, 400);
		const listed: PersonalData = await (await fetch(app.origin + "/api/personal")).json();
		assert.equal(listed.memory.find((item) => item.id === created.item.id)!.status, "rejected");
		assert.equal(listed.skills[0].name, "发布前检查");
		assert.equal(listed.knowledge.enabled, true);
		const current = await (await fetch(app.origin + "/api/knowledge/search?q=" + encodeURIComponent("现行写作规则"))).json();
		assert.equal(current.hits[0].path, "My-VPS/我的VPS/AI学习/现行.md");
		const hidden = await (await fetch(app.origin + "/api/knowledge/search?q=" + encodeURIComponent("旧写作规则"))).json();
		assert.equal(hidden.hits.length, 0);
		const past = await (await fetch(app.origin + "/api/knowledge/search?q=" + encodeURIComponent("旧写作规则") + "&history=1")).json();
		assert.equal(past.hits[0].status, "archived");
		const denied = await fetch(app.origin + "/api/knowledge/read?path=" + encodeURIComponent("../vault/外面.md"));
		assert.equal(denied.status, 400);
	} finally {
		if (app) await stop(app.child);
		await rm(dir, { recursive: true, force: true });
	}
});
