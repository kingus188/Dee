import type { TeamsSyncSettings } from "@assistant/contracts";
import { archiveSyncDelay, syncDelay } from "./teams-sync-policy.js";

/** Reads settings locally every 15 seconds, but makes no network call until due.
 * Serial completion-based polling cannot overlap itself or catch up in a burst. */
export function startTeamsPolling({ settings, run, archive = false, onError = () => {} }: {
  settings: () => TeamsSyncSettings;
  run: () => Promise<{ ok: boolean; retryAfterMs?: number }>;
  archive?: boolean;
  onError?: (error: unknown) => void;
}) {
  let stopped = false, lastAt: number | undefined, failures = 0, retryAt = 0;
  let timer: NodeJS.Timeout | undefined, running: Promise<void> | undefined;
  async function tick() {
    if (stopped) return;
    const current = settings(), now = Date.now();
    const delay = archive ? archiveSyncDelay(current, failures) : syncDelay(current, now, failures);
    if (current.enabled && (lastAt === undefined || now >= Math.max(lastAt + delay, retryAt))) {
      try {
        const result = await run();
        failures = result.ok ? 0 : Math.min(failures + 1, 16);
        retryAt = Date.now() + Math.max(0, result.retryAfterMs ?? 0);
      } catch (error) {
        failures = Math.min(failures + 1, 16);
        const retry = error && typeof error === "object" && "retryAfterMs" in error ? Number(error.retryAfterMs) : 0;
        if (Number.isFinite(retry)) retryAt = Date.now() + Math.max(0, retry);
        if (!stopped) onError(error);
      }
      lastAt = Date.now();
    }
    if (!stopped) timer = setTimeout(() => { running = tick(); }, 15_000);
  }
  running = tick();
  return () => { stopped = true; clearTimeout(timer); return running ?? Promise.resolve(); };
}
