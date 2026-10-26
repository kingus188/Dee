export function validateWebUrl(value: string): string {
  const input = value.trim();
  const url = new URL(input);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("远程地址必须使用 HTTPS，本机可使用 HTTP");
  // Reject normalization tricks (backslashes, dot segments, encoded paths) rather than silently dropping them.
  if (!/^https?:\/\/[^/?#\\@\s]+\/?$/i.test(input) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("地址不得包含用户信息、路径、查询或片段");
  return url.origin;
}

export function isAppUrl(value: string, origin: string) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password && !url.hash; } catch { return false; }
}

export function isAppConnection(value: string, origin: string) {
  if (isAppUrl(value, origin)) return true;
  try {
    const url = new URL(value);
    return url.origin === origin.replace(/^http/, "ws") && url.pathname === "/api/socket" && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

export function isExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
