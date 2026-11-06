import { createTeamsGraph, graphPageUrl } from "./teams-graph.js";

// A configured callback is not proof of current access. Probe identity and at
// most one message with the existing token. Graph does not support $select on
// this endpoint: any returned body is discarded, never stored/logged/summarized.
export function createTeamsEpisodeAccess({ getToken, bindAccount, fetchImpl = fetch, signal, now = Date.now }: {
  getToken: () => Promise<string>; bindAccount: (id: string) => void; fetchImpl?: typeof fetch; signal?: AbortSignal; now?: () => number;
}) {
  let rateLimitedUntil = 0;
  const failures = new Map<string, number>();
  const pending = new Map<string, Promise<boolean>>();
  const graph = createTeamsGraph(async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.status === 429 || response.status === 503) {
      const retry = response.headers.get("retry-after") ?? "";
      const seconds = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now();
      rateLimitedUntil = now() + Math.max(60_000, Number.isFinite(seconds) ? seconds : 60_000);
    }
    return response;
  }, signal);

  async function verify(chatId: string): Promise<boolean> {
    try {
      const token = await getToken();
      const me = await graph<{ id?: unknown }>(token, graphPageUrl("/me?$select=id"));
      if (typeof me.id !== "string" || !me.id) throw new Error("Teams 身份复核无效");
      bindAccount(me.id);
      const page = await graph<{ value?: unknown }>(token, graphPageUrl(`/chats/${encodeURIComponent(chatId)}/messages?$top=1`));
      if (!Array.isArray(page.value) || page.value.length > 1 || !page.value.every(item => item && typeof item === "object" && typeof item.id === "string" && !!item.id)) throw new Error("Teams 来源复核格式无效");
      return true;
    } catch {
      failures.set(chatId, now() + 60_000);
      return false;
    }
  }

  return (chatId: string): Promise<boolean> => {
    const at = now();
    for (const [key, until] of failures) if (until <= at) failures.delete(key);
    if (!chatId || chatId.length > 1024 || /[\u0000-\u001f]/.test(chatId) || chatId === "." || chatId === ".."
      || signal?.aborted || at < rateLimitedUntil || failures.has(chatId)) return Promise.resolve(false);
    let result = pending.get(chatId);
    if (!result) { result = verify(chatId).finally(() => pending.delete(chatId)); pending.set(chatId, result); }
    return result;
  };
}
