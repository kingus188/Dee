import { get } from "node:https";
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { isPinnedCertificate } from "./certificate-trust.js";
import { validateLanUrl, validateWebUrl } from "./policy.js";

type ServerIdentity = { pid: number; startedAt: string; boots: number };
type Probe = (origin: string) => Promise<ServerIdentity | null>;
type NetworkAddresses = Record<string, readonly Pick<NetworkInterfaceInfo, "address" | "netmask" | "family" | "internal">[] | undefined>;

export function isOnLocalNetwork(origin: string, interfaces: NetworkAddresses): boolean {
  const address = new URL(validateLanUrl(origin)).hostname.split(".").map(Number);
  return Object.values(interfaces).flatMap(items => items ?? []).some(item => {
    if (item.internal || item.family !== "IPv4") return false;
    const local = item.address.split(".").map(Number), mask = item.netmask.split(".").map(Number);
    return local.length === 4 && mask.length === 4 && mask.some(part => part !== 0) &&
      address.every((part, index) => (part & mask[index]!) === (local[index]! & mask[index]!));
  });
}

export function probeServer(origin: string, authorization: string | undefined, pin: unknown): Promise<ServerIdentity | null> {
  const url = new URL("/api/info", validateWebUrl(origin));
  if (url.protocol !== "https:") return Promise.resolve(null);
  const stored = pin && typeof pin === "object" ? pin as Record<string, unknown> : undefined;
  const certificate = stored?.origin === url.origin && typeof stored.certificate === "string" ? stored.certificate : undefined;
  return new Promise(resolve => {
    // TLS/hostname verification runs before sending credentials; redirects are never followed.
    const request = get(url, { ...(certificate ? { ca: certificate } : {}), rejectUnauthorized: true,
      headers: authorization ? { Authorization: authorization } : {}, signal: AbortSignal.timeout(2500) }, response => {
      if (response.statusCode !== 200) { response.resume(); resolve(null); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 4096) request.destroy(); else chunks.push(chunk); });
      response.on("error", () => resolve(null));
      response.on("end", () => {
        try {
          const info = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ServerIdentity;
          resolve(Number.isSafeInteger(info.pid) && info.pid > 0 && typeof info.startedAt === "string" && Number.isFinite(Date.parse(info.startedAt)) &&
            Number.isSafeInteger(info.boots) && info.boots >= 0 ? { pid: info.pid, startedAt: info.startedAt, boots: info.boots } : null);
        } catch { resolve(null); }
      });
    });
    request.on("error", () => resolve(null));
  });
}

export async function selectServer(config: { url: string; lanUrl?: string }, pin: unknown, authorization: string | undefined,
  options: { interfaces?: NetworkAddresses; probe?: Probe } = {}): Promise<{ origin: string; lanUrl?: string }> {
  const fallback = validateWebUrl(config.url), stored = pin && typeof pin === "object" ? pin as Record<string, unknown> : undefined;
  let candidate: string;
  try {
    candidate = validateLanUrl(config.lanUrl ?? (typeof stored?.origin === "string" ? stored.origin : ""));
    if (candidate === fallback || !isOnLocalNetwork(candidate, options.interfaces ?? networkInterfaces())) return { origin: fallback };
    // Discover only a previously provisioned exact certificate, never arbitrary devices on the subnet.
    if (!config.lanUrl && (typeof stored?.certificate !== "string" || !isPinnedCertificate(candidate, pin, new URL(candidate).hostname, stored.certificate))) return { origin: fallback };
  } catch { return { origin: fallback }; }
  const probe: Probe = async origin => {
    try { return await (options.probe ? options.probe(origin) : probeServer(origin, authorization, pin)); }
    catch { return null; }
  };
  if (config.lanUrl) return await probe(candidate) ? { origin: candidate, lanUrl: candidate } : { origin: fallback };
  const [local, remote] = await Promise.all([probe(candidate), probe(fallback)]);
  if (!local || !remote || local.pid !== remote.pid || local.startedAt !== remote.startedAt || local.boots !== remote.boots) return { origin: fallback };
  return { origin: candidate, lanUrl: candidate };
}

/** Keep device credentials/grants keyed by their configured server while changing only transport. */
export function transportUrl(value: string, configured: string, active: string): string {
  const url = new URL(value);
  if (url.origin !== configured || url.username || url.password) return value;
  const target = new URL(validateWebUrl(active)); url.protocol = target.protocol; url.host = target.host;
  return url.href;
}
