import { parseSummary, rollupPrompt, summaryPrompt } from "@assistant/features";
import type { Summary } from "@assistant/features";
import type { Collect } from "./episode-sources.js";
import type { EpisodeStore } from "./episode-store.js";
import { episodeHasSensitiveData, knownEpisodeSource, sanitizeEpisodeText } from "./episode-privacy.js";

const MIN_CHARS = 600; // 太短的内容先攒着
const QUIET_MS = 2 * 3_600_000; // 对话安静这么久才整理，避免总结到一半的话题
const ROLLUP_AFTER_MS = 14 * 86_400_000; // 超过两周的单次摘要合并为周摘要
const MAX_CALLS_PER_PASS = 10; // 包括失败的来源许可检查，限制模型及远程复核的次数
const INTERVAL_MS = 3_600_000;
const FIRST_RUN_DELAY_MS = 60_000;

export type EpisodeJobDeps = {
  store: EpisodeStore; collect: Collect; summarize: (prompt: string) => Promise<string>; log: (message: string) => void; now?: () => number;
  // The host must affirm current eligibility. Missing/failed/unknown permission
  // never falls back to sending cached text to a provider.
  allowSource?: (source: string, channel: string) => boolean | Promise<boolean>;
  startAfterSource?: string;
};

async function summarized(summarize: EpisodeJobDeps["summarize"], prompt: string): Promise<Summary | null> {
  // Defence in depth for every outbound field, including source labels/rollups.
  if (episodeHasSensitiveData(prompt)) return null;
  const raw = await summarize(prompt);
  if (episodeHasSensitiveData(raw)) return null;
  const result = parseSummary(raw);
  return result && !episodeHasSensitiveData([result.summary, ...result.openItems].join("\n")) ? result : null;
}

// 一轮整理：新内容 → 摘要；旧摘要 → 周摘要；最后遗忘。单个来源失败只记日志，下一轮再试。
export async function runEpisodePass({ store, collect, summarize, log, allowSource, startAfterSource, now = Date.now }: EpisodeJobDeps) {
  let attempts = 0;
  let lastSource = startAfterSource;
  const allowed = async (source: string, channel: string, revision: number, messageIds: string[] = []) =>
    knownEpisodeSource(source, channel) && await allowSource?.(source, channel) === true && store.sourceAllowed(source, revision, messageIds);
  const batches = await collect(source => store.cursor(source));
  const start = (batches.findIndex(batch => batch.source === startAfterSource) + 1) % (batches.length || 1);
  for (const batch of [...batches.slice(start), ...batches.slice(0, start)]) {
    if (attempts >= MAX_CALLS_PER_PASS) break;
    const ready = batch.chars >= MIN_CHARS && now() - Date.parse(batch.periodEnd) >= QUIET_MS;
    if (!ready) continue;
    attempts += 1;
    lastSource = batch.source;
    try {
      const revision = batch.sourceRevision ?? store.sourceRevision(batch.source);
      const expectedCursor = batch.afterCursor !== undefined ? batch.afterCursor : store.cursor(batch.source) ?? null;
      if ((store.cursor(batch.source) ?? null) !== expectedCursor) { log("skip source: collection cursor changed"); continue; }
      if (!await allowed(batch.source, batch.channel, revision, batch.messageIds)) { log("skip source: permission unavailable"); continue; }
      // Collectors sanitize complete messages before truncation. A custom/legacy
      // collector that still supplies unsafe text is rejected before model I/O.
      if (episodeHasSensitiveData(batch.text)) {
        store.commitBatch(null, batch.source, batch.cursor, revision, batch.messageIds, expectedCursor);
        log("skip source: sensitive input");
        continue;
      }
      const label = sanitizeEpisodeText(batch.label);
      const result = await summarized(summarize, summaryPrompt(label, batch.text));
      if (!await allowed(batch.source, batch.channel, revision, batch.messageIds)) { log("skip result: permission changed"); continue; }
      const episode = result ? { source: batch.source, label, channel: batch.channel, periodStart: batch.periodStart, periodEnd: batch.periodEnd, sourceRevision: revision, messageIds: batch.messageIds, ...result } : null;
      store.commitBatch(episode, batch.source, batch.cursor, revision, batch.messageIds, expectedCursor);
      if (!result) log("skip source: empty or contains secret");
    } catch { log("summarize failed: source unavailable or model error; retry later"); }
  }
  for (const group of store.rollupGroups(new Date(now() - ROLLUP_AFTER_MS).toISOString())) {
    if (attempts >= MAX_CALLS_PER_PASS) break;
    attempts += 1;
    try {
      const first = group[0];
      const revision = first.sourceRevision ?? 0;
      const messageIds = group.flatMap(item => item.messageIds ?? []);
      if (!await allowed(first.source, first.channel, revision, messageIds)) continue;
      const label = sanitizeEpisodeText(first.label);
      const prompt = rollupPrompt(label, group.map(item => ({ period: item.periodStart.slice(0, 10), summary: item.summary, openItems: item.openItems })));
      if (episodeHasSensitiveData(prompt)) { log("skip rollup: sensitive input"); continue; }
      const result = await summarized(summarize, prompt);
      if (!result) continue;
      if (!await allowed(first.source, first.channel, revision, messageIds)) continue;
      store.replaceWithRollup(group.map(item => item.id), { source: first.source, label, channel: first.channel, periodStart: first.periodStart, periodEnd: group.at(-1)!.periodEnd, sourceRevision: revision, messageIds, ...result });
    } catch { log("rollup failed: source unavailable or model error; retry later"); }
  }
  const forgotten = store.forget(now());
  if (forgotten) log(`forgot ${forgotten} episodes`);
  return lastSource;
}

export function startEpisodeJob(deps: EpisodeJobDeps) {
  let timer: NodeJS.Timeout | undefined, stopped = false;
  let startAfterSource = deps.startAfterSource;
  const tick = async () => {
    // Rotate failures as well as successes so a stable set of inaccessible
    // sources cannot consume every hourly budget. A restart resets rotation.
    try { startAfterSource = await runEpisodePass({ ...deps, startAfterSource }); } catch { deps.log("pass failed: collection or storage unavailable; retry later"); }
    if (!stopped) { timer = setTimeout(tick, INTERVAL_MS); timer.unref(); }
  };
  timer = setTimeout(tick, FIRST_RUN_DELAY_MS);
  timer.unref();
  return () => { stopped = true; clearTimeout(timer); };
}
