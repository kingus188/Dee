import { parseSummary, rollupPrompt, summaryHasSecret, summaryPrompt } from "@assistant/features";
import type { Summary } from "@assistant/features";
import type { Collect } from "./episode-sources.js";
import type { EpisodeStore } from "./episode-store.js";

const MIN_CHARS = 600; // 太短的内容先攒着
const QUIET_MS = 2 * 3_600_000; // 对话安静这么久才整理，避免总结到一半的话题
const ROLLUP_AFTER_MS = 14 * 86_400_000; // 超过两周的单次摘要合并为周摘要
const MAX_CALLS_PER_PASS = 10; // 每轮最多调用模型的次数，限制首次回灌的花费
const INTERVAL_MS = 3_600_000;
const FIRST_RUN_DELAY_MS = 60_000;

export type EpisodeJobDeps = {
  store: EpisodeStore; collect: Collect; summarize: (prompt: string) => Promise<string>; log: (message: string) => void; now?: () => number;
};

async function summarized(summarize: EpisodeJobDeps["summarize"], prompt: string): Promise<Summary | null> {
  const result = parseSummary(await summarize(prompt));
  return result && !summaryHasSecret(result) ? result : null;
}

// 一轮整理：新内容 → 摘要；旧摘要 → 周摘要；最后遗忘。单个来源失败只记日志，下一轮再试。
export async function runEpisodePass({ store, collect, summarize, log, now = Date.now }: EpisodeJobDeps) {
  let calls = 0;
  for (const batch of await collect(source => store.cursor(source))) {
    if (calls >= MAX_CALLS_PER_PASS) break;
    const ready = batch.chars >= MIN_CHARS && now() - Date.parse(batch.periodEnd) >= QUIET_MS;
    if (!ready) continue;
    calls += 1;
    try {
      const result = await summarized(summarize, summaryPrompt(batch.label, batch.text));
      if (result) store.add({ source: batch.source, label: batch.label, channel: batch.channel, periodStart: batch.periodStart, periodEnd: batch.periodEnd, ...result });
      else log(`skip ${batch.source}: empty or contains secret`);
      store.setCursor(batch.source, batch.cursor);
    } catch (error) { log(`summarize failed ${batch.source}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const group of store.rollupGroups(new Date(now() - ROLLUP_AFTER_MS).toISOString())) {
    if (calls >= MAX_CALLS_PER_PASS) break;
    calls += 1;
    try {
      const result = await summarized(summarize, rollupPrompt(group[0].label, group.map(item => ({ period: item.periodStart.slice(0, 10), summary: item.summary, openItems: item.openItems }))));
      if (!result) continue;
      store.replaceWithRollup(group.map(item => item.id), { source: group[0].source, label: group[0].label, channel: group[0].channel, periodStart: group[0].periodStart, periodEnd: group.at(-1)!.periodEnd, ...result });
    } catch (error) { log(`rollup failed ${group[0].source}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const forgotten = store.forget(now());
  if (forgotten) log(`forgot ${forgotten} episodes`);
}

export function startEpisodeJob(deps: EpisodeJobDeps) {
  let timer: NodeJS.Timeout | undefined, stopped = false;
  const tick = async () => {
    try { await runEpisodePass(deps); } catch (error) { deps.log(`pass failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!stopped) { timer = setTimeout(tick, INTERVAL_MS); timer.unref(); }
  };
  timer = setTimeout(tick, FIRST_RUN_DELAY_MS);
  timer.unref();
  return () => { stopped = true; clearTimeout(timer); };
}
