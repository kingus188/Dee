import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";

// Only a certificate provisioned locally for this exact origin may override system trust.
export function isPinnedCertificate(origin: string, pin: unknown, hostname: string, pem: string): boolean {
  if (!pin || typeof pin !== "object") return false;
  const stored = pin as Record<string, unknown>;
  if (stored.origin !== origin || typeof stored.certificate !== "string") return false;
  try {
    const url = new URL(origin), host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || hostname !== host) return false;
    const expected = new X509Certificate(stored.certificate), actual = new X509Certificate(pem);
    const validHost = isIP(host) ? actual.checkIP(host) : actual.checkHost(host);
    const now = Date.now();
    return Boolean(validHost) && expected.fingerprint256 === actual.fingerprint256
      && now >= Date.parse(actual.validFrom) && now <= Date.parse(actual.validTo);
  } catch {
    // Invalid local pins and malformed peer certificates never override normal verification.
    return false;
  }
}
