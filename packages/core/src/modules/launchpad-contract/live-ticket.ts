import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Short-lived ticket that admits one browser to the direct live socket.
 * It is a cost and a throttle, not authentication: the socket's own limits
 * bound the damage. Single use is enforced by the caller burning `nonce`.
 */
export const LIVE_TICKET_TTL_MS = 60_000;
const LABEL = "blast-live-ticket-v1";
const FUTURE_SKEW_MS = 5_000;
const TICKET = /^[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{43}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;

export type LiveTicket = Readonly<{ nonce: string; expiresAtMs: number; origin: string }>;

const key = (secret: string) => createHmac("sha256", secret).update(LABEL).digest();
const sign = (secret: string, payload: string) => createHmac("sha256", key(secret)).update(payload).digest();

export function mintLiveTicket(secret: string, origin: string, now = Date.now()) {
  const ticket: LiveTicket = { nonce: randomBytes(16).toString("base64url"), expiresAtMs: now + LIVE_TICKET_TTL_MS, origin };
  const payload = Buffer.from(JSON.stringify({ v: 1, exp: ticket.expiresAtMs, n: ticket.nonce, o: origin })).toString("base64url");
  return { ...ticket, ticket: `${payload}.${sign(secret, payload).toString("base64url")}` };
}

/** Returns the ticket when its signature, expiry and origin all hold; never throws. */
export function verifyLiveTicket(secret: string, value: string, origin: string, now = Date.now()): LiveTicket | null {
  if (!TICKET.test(value)) return null;
  const [payload, mac] = value.split(".") as [string, string];
  const expected = sign(secret, payload);
  const supplied = Buffer.from(mac, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  let body: unknown;
  try { body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!body || typeof body !== "object") return null;
  const { v, exp, n, o } = body as Record<string, unknown>;
  if (v !== 1 || typeof exp !== "number" || !Number.isSafeInteger(exp) || typeof n !== "string" || !NONCE.test(n) || o !== origin) return null;
  if (exp <= now || exp > now + LIVE_TICKET_TTL_MS + FUTURE_SKEW_MS) return null;
  return { nonce: n, expiresAtMs: exp, origin };
}
