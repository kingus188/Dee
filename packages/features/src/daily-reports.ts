import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { DailyReport, DailyReportInput } from "@assistant/contracts";
import { resultText } from "./results.js";

export interface DailyReportsPort {
  get(date: string): Promise<DailyReport | null>;
  save(date: string, input: DailyReportInput): Promise<DailyReport>;
}

const date = Type.String({ pattern: "^[1-9]\\d{3}-\\d{2}-\\d{2}$", description: "日报日期，YYYY-MM-DD；今天等相对日期先用 current_time 确认。" });

export function createDailyReportTools(reports: DailyReportsPort) {
  return defineExtension({
    name: "daily-reports",
    tools: [
      defineTool({
        name: "get_daily_report", replay: "safe",
        description: "读取日报页面中指定日期的日报和版本。返回 null 表示尚未记录。保存前先读取，保留已有内容。",
        parameters: Type.Object({ date }, { additionalProperties: false }),
        execute: async args => resultText(JSON.stringify(await reports.get(args.date))),
      }),
      defineTool({
        name: "save_daily_report", replay: "unsafe",
        description: "把 Markdown 日报持久化到每日日报页面。revision 必须使用 get_daily_report 返回的版本；不存在时传 null。版本冲突时重新读取并合并，勿覆盖其他修改。",
        parameters: Type.Object({ date, markdown: Type.String({ maxLength: 16000 }), revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]) }, { additionalProperties: false }),
        // A CAS write is not replay-safe: after interruption, read the report before trying again.
        execute: async args => resultText(JSON.stringify(await reports.save(args.date, { markdown: args.markdown, revision: args.revision }))),
      }),
    ],
    sections: [section("daily-reports", () => "用户口述今天的日报、要求生成/记录/更新日报时，先用 current_time 确认日期，用 get_daily_report 读取当天记录，再整理用户提供的工作事项并用 save_daily_report 保存到日报页面。已有内容需保留并合并，不能编造完成状态或明日计划。仅要求润色、预览、拟稿或明确不要保存时只返回草稿。工具成功后才告知已保存及日期；保存失败时说明原因并保留正文，不要声称已保存。版本冲突先重新读取，无法确定合并方式时展示正文请用户选择。")],
  });
}
