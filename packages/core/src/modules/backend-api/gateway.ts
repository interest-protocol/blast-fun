import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { MINIMUM_SECRET_LENGTH } from "@blast/core/lib/config/secret.ts";

const PREFIX = "x-blast-gateway-";
export const INTERNAL_READ_PREFIX = "/internal/public-read";
const LIFETIME_SECONDS = 15;
export type GatewayContext = Readonly<{ ip: string; nonce: string; namespace: string }>;

function requestProof(request: Request, ip: string, issued: string, nonce: string, namespace: string): string {
  const url = new URL(request.url);
  const credentials = createHash("sha256").update(JSON.stringify([
    request.headers.get("authorization"), request.headers.get("cookie"), request.headers.get("x-blast-partner-key"),
    request.headers.get("origin"), request.headers.get("sec-fetch-site"),
  ])).digest("hex");
  return JSON.stringify(["blast-public-gateway-v1", request.method, url.pathname + url.search, ip, issued, nonce, namespace, credentials]);
}

export function stripGatewayHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (name.startsWith(PREFIX) || name.startsWith("x-blast-internal-") ||
        ["forwarded", "x-forwarded-for", "x-real-ip"].includes(name)) headers.delete(name);
  }
}

/** Signs transport metadata only; the backend still verifies original user sessions. */
export function signGatewayRequest(request: Request, secret: string, ip: string, namespace: string, now = Date.now()): Headers {
  if (secret.length < MINIMUM_SECRET_LENGTH) throw new Error("BLAST_BACKEND_GATEWAY_SECRET must contain at least 32 characters.");
  if (!/^[0-9a-f]{64}$/.test(namespace)) throw new Error("Invalid gateway quota namespace.");
  if (ip !== "unavailable" && !isIP(ip)) throw new Error("Invalid gateway client address.");
  const headers = new Headers(request.headers);
  stripGatewayHeaders(headers);
  const issued = String(Math.floor(now / 1_000));
  const nonce = randomBytes(24).toString("base64url");
  const signature = createHmac("sha256", secret).update(requestProof(request, ip, issued, nonce, namespace)).digest("base64url");
  headers.set(`${PREFIX}namespace`, namespace);
  headers.set(`${PREFIX}ip`, ip);
  headers.set(`${PREFIX}issued`, issued);
  headers.set(`${PREFIX}nonce`, nonce);
  headers.set(`${PREFIX}signature`, signature);
  return headers;
}

export function verifyGatewayRequest(request: Request, secret: string, expectedNamespace: string, now = Date.now()): GatewayContext | null {
  if (secret.length < MINIMUM_SECRET_LENGTH) return null;
  const namespace = request.headers.get(`${PREFIX}namespace`) ?? "";
  if (namespace !== expectedNamespace || !/^[0-9a-f]{64}$/.test(namespace)) return null;
  const ip = request.headers.get(`${PREFIX}ip`) ?? "";
  const issued = request.headers.get(`${PREFIX}issued`) ?? "";
  const nonce = request.headers.get(`${PREFIX}nonce`) ?? "";
  const signature = request.headers.get(`${PREFIX}signature`) ?? "";
  if ((ip !== "unavailable" && !isIP(ip)) || !/^\d{10}$/.test(issued) ||
      !/^[A-Za-z0-9_-]{32}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  const age = Math.floor(now / 1_000) - Number(issued);
  if (age < -2 || age > LIFETIME_SECONDS) return null;
  const expected = createHmac("sha256", secret).update(requestProof(request, ip, issued, nonce, namespace)).digest();
  const supplied = Buffer.from(signature, "base64url");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? { ip, nonce, namespace } : null;
}
