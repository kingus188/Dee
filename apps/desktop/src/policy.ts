export function isAppUrl(value: string, origin: string) {
  try { return new URL(value).origin === origin; } catch { return false; }
}

export function isExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
