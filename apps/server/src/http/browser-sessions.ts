import type { IncomingMessage } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { authorized } from "./auth.js";

const cookieName = "__Host-pi-durable-session";
const lifetimeMs = 60 * 60 * 1000;

/** Browser sessions survive proxies that remove WebSocket Authorization, not server restarts. */
export function createBrowserSessions(password: string) {
  const signingKey = randomBytes(32);
  const sign = (expires: string) => createHmac("sha256", signingKey).update(expires).digest("base64url");

  return {
    authenticate(req: IncomingMessage): "basic" | "session" | "anonymous" | false {
      if (!password) return "anonymous";
      // Explicit, incorrect credentials must not be hidden by a cached session.
      if (req.headers.authorization !== undefined) return authorized(req, password) ? "basic" : false;
      let token: string | undefined;
      for (const part of (req.headers.cookie ?? "").split(";")) {
        const entry = part.trim();
        if (!entry.startsWith(cookieName + "=")) continue;
        if (token !== undefined) return false;
        token = entry.slice(cookieName.length + 1);
      }
      const match = token?.match(/^([1-9]\d{0,15})\.([A-Za-z0-9_-]{43})$/);
      if (!match || !Number.isSafeInteger(Number(match[1])) || Date.now() >= Number(match[1])) return false;
      const expected = Buffer.from(sign(match[1]!));
      const supplied = Buffer.from(match[2]!);
      return timingSafeEqual(supplied, expected) ? "session" : false;
    },
    issueCookie() {
      const expires = String(Date.now() + lifetimeMs);
      return `${cookieName}=${expires}.${sign(expires)}; Path=/; Max-Age=${lifetimeMs / 1000}; HttpOnly; Secure; SameSite=Strict`;
    },
  };
}
