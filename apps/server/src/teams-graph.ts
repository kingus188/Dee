const GRAPH = "https://graph.microsoft.com/v1.0";

// 令牌只能发给 Graph；分页必须停留在同一个资源，不能借 nextLink 切换账号或端点。
export function graphPageUrl(path: string, cursor?: string) {
	const base = new URL(GRAPH + path);
	const url = cursor ? new URL(cursor) : base;
	// Graph 的 nextLink 会改变冒号、@ 等字符的编码；逐段比较，不能把编码的斜杠变成路径分隔符。
	const sameResource = JSON.stringify(url.pathname.split("/").map(decodeURIComponent)) === JSON.stringify(base.pathname.split("/").map(decodeURIComponent));
	if (url.origin !== "https://graph.microsoft.com" || !sameResource || url.username || url.password || url.hash) {
		throw new Error("Teams 分页地址无效，请从第一页重新读取");
	}
	return url.href;
}

export function createTeamsGraph(fetchImpl: typeof fetch, signal?: AbortSignal) {
	return async function graph<T>(token: string, url: string, body?: unknown): Promise<T> {
		signal?.throwIfAborted();
		const target = new URL(url);
		if (target.origin !== "https://graph.microsoft.com" || !target.pathname.startsWith("/v1.0/") || target.username || target.password) throw new Error("Teams 请求地址无效");
		const response = await fetchImpl(url, {
			method: body === undefined ? "GET" : "POST", redirect: "error",
			headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			if (response.status === 403) throw new Error("Teams 读取被拒绝：请核对当前账号访问权及该功能的微软委托授权");
			if (response.status === 401) throw new Error("Teams 登录已失效，请重新登录");
			if (response.status === 404) throw new Error("Teams 消息或文件不存在，或当前账号无权访问");
			if (response.status === 429 || response.status === 503) {
        const retry = response.headers.get("retry-after");
        const milliseconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 60_000;
        throw Object.assign(new Error("微软暂时限制读取频率，请稍后重试"), { retryAfterMs: Number.isFinite(milliseconds) ? Math.max(1000, milliseconds) : 60_000 });
      }
			throw new Error(`Teams 读取失败（HTTP ${response.status}），未将失败当作空结果`);
		}
		return await response.json() as T;
	};
}
export type TeamsGraph = ReturnType<typeof createTeamsGraph>;
