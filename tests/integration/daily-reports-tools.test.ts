import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, startServer } from "../../apps/server/dist/index.js";
import { post, readView } from "./helpers.js";

test("聊天通过真实注册的工具保存日报，页面接口与重启后读取相同记录", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-reports-tools-"));
  const date = "2026-10-26";
  const original = "## 今日进展\n\n1. 添加 Gina 的 OKR 录入。\n2. 配合刘博文测试 PartterX License 的生成。\n3. 排查 Bai Ying 邮箱收信问题。\n4. 处理日常系统事务。";
  const updated = original + "\n5. 补充日报保存验证。";
  const available = new Set<string>();
  const reads: unknown[] = [], saves: { revision: number; markdown: string }[] = [];
  let turn = 0, providerError: unknown;
  const provider = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body) as { model: string; tools: { function: { name: string } }[]; messages: { role: string; content: string }[] };
      for (const tool of input.tools) available.add(tool.function.name);
      const phase = turn++ % 3, round = Math.floor((turn - 1) / 3);
      const last = input.messages.at(-1)!;
      if (phase === 1) {
        assert.equal(last.role, "tool");
        const report = JSON.parse(last.content);
        reads.push(report);
        assert.equal(report?.revision ?? null, round === 0 ? null : 1);
      }
      if (phase === 2) {
        assert.equal(last.role, "tool");
        const report = JSON.parse(last.content);
        saves.push(report);
        assert.equal(report.revision, round + 1);
      }
      const name = phase === 0 ? "get_daily_report" : "save_daily_report";
      const args = phase === 0 ? { date } : { date, markdown: round === 0 ? original : updated, revision: round === 0 ? null : 1 };
      const delta = phase === 2 ? { role: "assistant", content: `已保存日报 ${date}` } : { role: "assistant", tool_calls: [{ index: 0, id: `report-${turn}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
      const chunk = { id: `local-report-${turn}`, object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: null }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: phase === 2 ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      providerError = error;
      res.writeHead(500); res.end("Local mock assertion failed");
    }
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const address = provider.address(); assert.ok(address && typeof address === "object");
  const config = readConfig({ NODE_ENV: "test", PI_OFFLINE: "1", DATA_DIR: directory, PORT: "0", NOTIFY_MODE: "off", LLM_API: "openai-completions", LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`, LLM_MODEL: "local-report-test", LLM_API_KEY: "local-fixture-key" });
  let service: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    service = await startServer(config, "127.0.0.1");
    const { id } = await post(service.origin, "/api/conversations/direct");
    await post(service.origin, `/api/conversations/${id}/messages`, { text: "今天的日报：添加 Gina 的 OKR 录入；配合刘博文测试 PartterX License；排查 Bai Ying 邮箱收信；日常事务。" });
    await readView(service.origin, id, view => !view.busy && view.entries.some(entry => entry.kind === "assistant"));
    assert.equal(providerError, undefined);
    assert.ok(available.has("get_daily_report")); assert.ok(available.has("save_daily_report"));
    assert.deepEqual(reads, [null]);
    const getReport = async () => (await fetch(service!.origin + `/api/daily-reports/${date}`)).json();
    assert.equal((await getReport()).markdown, original);
    const list = await (await fetch(service.origin + "/api/daily-reports")).json();
    assert.equal(list[0].date, date);
    await post(service.origin, `/api/conversations/${id}/messages`, { text: "补充日报保存验证。" });
    await readView(service.origin, id, view => !view.busy && view.entries.filter(entry => entry.kind === "assistant" && entry.text.includes(`已保存日报 ${date}`)).length === 2);
    assert.equal(providerError, undefined);
    assert.deepEqual(saves.map(report => report.revision), [1, 2]);
    const saved = await getReport();
    assert.equal(saved.markdown, updated); assert.equal(saved.revision, 2);
    await service.close(); service = undefined;
    service = await startServer(config, "127.0.0.1");
    assert.deepEqual(await getReport(), saved);
  } catch (error) {
    throw new Error(`日报工具链验证失败：${JSON.stringify({ turn, tools: [...available], reads: reads.length, saves: saves.length })}`, { cause: providerError ?? error });
  } finally {
    await service?.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
