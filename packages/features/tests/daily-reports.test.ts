import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { DailyReport, DailyReportInput } from "@assistant/contracts";
import { createDailyReportTools } from "@assistant/features";

function fixture() {
  let saved: DailyReport | null = null;
  const extension = createDailyReportTools({
    get: async date => saved?.date === date ? structuredClone(saved) : null,
    save: async (date, input: DailyReportInput) => {
      assert.equal(input.revision, saved?.revision ?? null, "日报版本冲突");
      saved = { date, markdown: input.markdown, revision: (saved?.revision ?? 0) + 1, updatedAt: "2026-10-26T00:00:00.000Z" };
      return structuredClone(saved);
    },
  });
  async function invoke(name: string, args: Record<string, unknown>) {
    const tool = extension.tools!.find(tool => tool.name === name);
    assert.ok(tool);
    const result = await tool.execute(args, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
    return JSON.parse((result.output ?? []).map(part => part.type === "text" ? part.text : "").join("")) as DailyReport | null;
  }
  return { invoke, extension };
}

test("聊天日报工具读取共享存储、按版本保存并返回实际记录", async () => {
  const { invoke } = fixture();
  const date = "2026-10-26", markdown = "## 今日进展\n\n1. 添加 Gina 的 OKR 录入。\n2. 配合测试 License 生成。";
  assert.equal(await invoke("get_daily_report", { date }), null);
  const created = await invoke("save_daily_report", { date, markdown, revision: null });
  assert.equal(created?.revision, 1);
  assert.deepEqual(await invoke("get_daily_report", { date }), created);
  const updated = await invoke("save_daily_report", { date, markdown: markdown + "\n3. 排查邮箱收信。", revision: created!.revision });
  assert.equal(updated?.revision, 2);
  assert.match(updated!.markdown, /Gina.*[\s\S]*邮箱收信/);
});

test("聊天日报版本冲突向上传递，不假报保存成功也不覆盖已有正文", async () => {
  const { invoke, extension } = fixture();
  const date = "2026-10-26";
  const created = await invoke("save_daily_report", { date, markdown: "保留", revision: null });
  await assert.rejects(invoke("save_daily_report", { date, markdown: "过期写入", revision: null }), /日报版本冲突/);
  assert.deepEqual(await invoke("get_daily_report", { date }), created);
  assert.equal(extension.tools!.find(tool => tool.name === "save_daily_report")!.replay, "unsafe");
});
