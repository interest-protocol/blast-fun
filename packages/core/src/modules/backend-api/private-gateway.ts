import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { canonicalAddress } from "@blast/core/lib/web-security/ingress.ts";
import {
  privateRoute,
  type PrivatePurpose,
  type PrivateRouteContract,
} from "./private-routes.ts";
import { MINIMUM_SECRET_LENGTH } from "@blast/core/lib/config/secret.ts";
import { isLoopbackHostname } from "@blast/core/lib/loopback.ts";
import { HOP_BY_HOP_HEADERS } from "./hop-by-hop.ts";

const DOMAIN = "blast.private-relay.v1";
const PREFIX = "x-blast-private-";
export const PRIVATE_PROOF_TTL_SECONDS = 30;
const MAX_AGE_MS = 15_000;
const FUTURE_SKEW_MS = 2_000;
export type PrivateProof = Readonly<{
  namespace: string;
  purpose: PrivatePurpose;
  siteOrigin: string;
  ip: string;
  issued: string;
  nonce: string;
  bodySha256: string;
}>;
export type VerifiedPrivateProof = PrivateProof &
  Readonly<{ route: PrivateRouteContract }>;
export type PrivateSigningContext = Readonly<{
  namespace: string;
  purpose: PrivatePurpose;
  siteOrigin: string;
  ip: string;
}>;

/** Private transport is purpose-bound and never substitutes for user/session authorization. */
export function signPrivateRequest(
  request: Request,
  body: Uint8Array,
  secret: string,
  context: PrivateSigningContext,
  now = Date.now(),
): Headers {
  const proof: PrivateProof = {
    ...context,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    issued: String(now),
    nonce: randomBytes(24).toString("base64url"),
  };
  const route = validate(request, proof);
  if (secret.length < MINIMUM_SECRET_LENGTH || !route || body.byteLength > route.maxBodyBytes)
    throw new Error("Invalid private relay request");
  const headers = new Headers(request.headers);
  stripPrivateHeaders(headers);
  for (const [name, value] of Object.entries(proof))
    headers.set(`${PREFIX}${name.toLowerCase()}`, value);
  headers.set(
    `${PREFIX}signature`,
    signature(request, secret, proof).toString("base64url"),
  );
  return headers;
}

export function verifyPrivateEnvelope(
  request: Request,
  secret: string,
  expected: Readonly<{ namespace: string; siteOrigin: string }>,
  now = Date.now(),
): VerifiedPrivateProof | null {
  if (secret.length < MINIMUM_SECRET_LENGTH) return null;
  const field = (name: string) => request.headers.get(`${PREFIX}${name}`) ?? "";
  for (const name of request.headers.keys()) {
    if (name.startsWith(PREFIX) && request.headers.get(name)?.includes(","))
      return null;
  }
  const purpose = field("purpose");
  if (purpose !== "browser" && purpose !== "ssr-read") return null;
  const proof: PrivateProof = {
    namespace: field("namespace"),
    purpose,
    siteOrigin: field("siteorigin"),
    ip: field("ip"),
    issued: field("issued"),
    nonce: field("nonce"),
    bodySha256: field("bodysha256"),
  };
  if (
    proof.namespace !== expected.namespace ||
    proof.siteOrigin !== expected.siteOrigin
  )
    return null;
  const route = validate(request, proof);
  if (
    !route ||
    !/^\d{13}$/.test(proof.issued) ||
    !/^[A-Za-z0-9_-]{32}$/.test(proof.nonce) ||
    !/^[0-9a-f]{64}$/.test(proof.bodySha256)
  )
    return null;
  const age = now - Number(proof.issued);
  if (age < -FUTURE_SKEW_MS || age > MAX_AGE_MS) return null;
  const supplied = field("signature");
  if (!/^[A-Za-z0-9_-]{43}$/.test(supplied)) return null;
  const digest = Buffer.from(supplied, "base64url");
  const actual = signature(request, secret, proof);
  return digest.length === actual.length && timingSafeEqual(digest, actual)
    ? { ...proof, route }
    : null;
}

/** Compare the bytes only after the signed envelope has been authenticated. */
export function verifyPrivateBody(
  body: Uint8Array,
  proof: VerifiedPrivateProof,
): boolean {
  if (body.byteLength > proof.route.maxBodyBytes) return false;
  return timingSafeEqual(
    createHash("sha256").update(body).digest(),
    Buffer.from(proof.bodySha256, "hex"),
  );
}

export function verifyPrivateRequest(
  request: Request,
  body: Uint8Array,
  secret: string,
  expected: Readonly<{ namespace: string; siteOrigin: string }>,
  now = Date.now(),
): VerifiedPrivateProof | null {
  const proof = verifyPrivateEnvelope(request, secret, expected, now);
  return proof && verifyPrivateBody(body, proof) ? proof : null;
}

export function stripPrivateHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (
      name.startsWith(PREFIX) ||
      name.startsWith("x-blast-gateway-") ||
      name.startsWith("x-blast-internal-") ||
      ["forwarded", "x-forwarded-for", "x-real-ip", ...HOP_BY_HOP_HEADERS].includes(name)
    )
      headers.delete(name);
  }
}

function validate(
  request: Request,
  proof: PrivateProof,
): PrivateRouteContract | null {
  const url = new URL(request.url);
  if (
    !/^[0-9a-f]{64}$/.test(proof.namespace) ||
    !validSiteOrigin(proof.siteOrigin) ||
    canonicalAddress(proof.ip) !== proof.ip
  )
    return null;
  if (
    url.pathname.startsWith("//") ||
    /%(?:2f|5c|2e)/i.test(url.pathname) ||
    url.pathname.includes("\\") ||
    url.hash ||
    url.username ||
    url.password
  )
    return null;
  const route = privateRoute(request.method, url.pathname, proof.purpose);
  if (!route) return null;
  if (
    request.headers.has("x-blast-partner-key") ||
    request.headers.get("authorization")?.includes(",")
  )
    return null;
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding !== "identity") return null;
  for (const name of [
    "origin",
    "sec-fetch-site",
    "content-type",
    "x-csrf-token",
    "x-blast-csrf",
    "x-bot-challenge",
    "idempotency-key",
    "x-blast-api-key",
    "x-blast-public-view",
  ])
    if (request.headers.get(name)?.includes(",")) return null;
  return route;
}

function validSiteOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const local = isLoopbackHostname(url.hostname);
    return (
      url.origin === value &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" || (local && url.protocol === "http:"))
    );
  } catch {
    return false;
  }
}

function present(
  headers: Headers,
  name: string,
): readonly [boolean, string | null] {
  return [headers.has(name), headers.get(name)];
}

function signature(
  request: Request,
  secret: string,
  proof: PrivateProof,
): Buffer {
  const url = new URL(request.url);
  const credentials = createHash("sha256")
    .update(
      JSON.stringify([
        present(request.headers, "authorization"),
        present(request.headers, "cookie"),
      ]),
    )
    .digest("hex");
  const content = JSON.stringify([
    DOMAIN,
    proof.namespace,
    proof.purpose,
    request.method,
    url.pathname + url.search,
    proof.siteOrigin,
    present(request.headers, "origin"),
    present(request.headers, "sec-fetch-site"),
    present(request.headers, "content-type"),
    [
      "x-csrf-token",
      "x-blast-csrf",
      "x-bot-challenge",
      "idempotency-key",
      "x-blast-api-key",
      "x-blast-public-view",
    ].map((name) => [name, present(request.headers, name)]),
    proof.bodySha256,
    credentials,
    proof.ip,
    proof.issued,
    proof.nonce,
  ]);
  const key = createHmac("sha256", secret).update(DOMAIN).digest();
  return createHmac("sha256", key).update(content).digest();
}
