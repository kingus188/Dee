export function isAppUrl(value: string, origin: string) {
  try { return new URL(value).origin === origin; } catch { return false; }
}

export function isAppConnection(value: string, origin: string) {
  if (isAppUrl(value, origin)) return true;
  try {
    const url = new URL(value);
    return url.origin === origin.replace(/^http/, "ws") && url.pathname === "/api/socket" && !url.search && !url.username && !url.password;
  } catch { return false; }
}

export function isExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
