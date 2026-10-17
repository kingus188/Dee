export type DailyReport = {
  date: string;
  markdown: string;
  revision: number;
  updatedAt: string;
};
export type DailyReportSummary = Omit<DailyReport, "markdown">;
export type DailyReportInput = { markdown: string; revision: number | null };
