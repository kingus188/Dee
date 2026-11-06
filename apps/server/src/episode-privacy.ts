import { summaryHasSecret } from "@assistant/features";

export const OMITTED_EPISODE_TEXT = "[已省略可能含敏感数据的内容]";

// Local, deliberately conservative screening, not a general PII classifier. Keep
// whole messages out when a match is found: replacing only a token fragment can
// leave a multiline credential, a quoted value or a truncated identifier behind.
const SENSITIVE = [
  /\b(?:github_pat_|gh[pousr]_|sk-|xox[baprs]-)[A-Za-z0-9_-]{8,}/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/i,
  /(?:password|passwd|passphrase|secret|(?:access|refresh|session|auth)[_ -]?token|token|api[_ -]?key|client[_ -]?secret|密码|口令|密钥|令牌)["'\s]*(?:[:=：]|\bis\b|是|为)\s*\S+/i,
  /(?:authorization|cookie|set-cookie)["'\s]*:\s*\S+/i,
  /(?:验证码|动态码|verification\s+code|one[- ]time\s+(?:code|password)|\botp\b)\s*(?:是|为|is|[:=：])?\s*\d{4,8}\b/i,
  /(?:身份证(?:号(?:码)?)?|护照(?:号(?:码)?)?|银行(?:卡|账号)(?:号(?:码)?)?|信用卡(?:号)?|passport|social\s+security|\bssn\b|bank\s+account|credit\s+card)["'\s]*(?:号码|number|no\.?|is|是|为|[:=：])?\s*[:=：]?\s*[A-Z0-9][A-Z0-9 -]{5,}/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dX]\b/i,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /https?:\/\/[^\s/@]+:[^\s/@]+@/i,
];

const hasSensitivePattern = (text: string) => summaryHasSecret({ summary: text, openItems: [] }) || SENSITIVE.some(pattern => pattern.test(text));

/** Inspect decoded, untruncated JSON fields as well as their escaped wire form. */
export function episodeHasSensitiveData(raw: string): boolean {
  if (hasSensitivePattern(raw)) return true;
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch { return false; /* Non-JSON text is retained without decoding. */ }
  if (hasSensitivePattern(JSON.stringify(parsed))) return true;
  const values: unknown[] = [parsed];
  while (values.length) {
    const value = values.pop();
    if (typeof value === "string" && hasSensitivePattern(value)) return true;
    if (value && typeof value === "object") for (const item of Object.values(value)) values.push(item);
  }
  return false;
}

/** Call on the complete source value, before whitespace folding or truncation. */
export function sanitizeEpisodeText(text: string): string {
  return episodeHasSensitiveData(text) ? OMITTED_EPISODE_TEXT : text;
}

export function knownEpisodeSource(source: string, channel: string): boolean {
  return (/^conv:[^\s]+$/.test(source) && ["web", "wechat", "teams"].includes(channel))
    || (/^teams:[^\s]+$/.test(source) && channel === "teams");
}
