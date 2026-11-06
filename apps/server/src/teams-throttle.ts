/** One account-level Graph gate shared by live polling, archives and exact reads.
 * Authentication and non-Graph file downloads are not put behind this gate. */
export function createTeamsFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  let until = 0;
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const graph = url.origin === "https://graph.microsoft.com";
    if (graph && Date.now() < until) throw Object.assign(new Error("微软限制读取频率，等待 Retry-After 后重试"), { retryAfterMs: until - Date.now() });
    const response = await fetchImpl(input, init);
    if (graph && [429, 503].includes(response.status)) {
      const retry = response.headers.get("retry-after");
      const ms = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 60_000;
      until = Math.max(until, Date.now() + (Number.isFinite(ms) ? Math.max(1000, ms) : 60_000));
    }
    return response;
  };
}
