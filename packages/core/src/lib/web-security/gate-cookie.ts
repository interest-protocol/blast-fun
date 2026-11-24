import { deploymentIdentity } from "../config/deployment-identity.ts";
import { MINIMUM_SECRET_LENGTH } from "../config/secret.ts";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GATE_COOKIE_NAME, GATE_COOKIE_NAME_INSECURE, GATE_LIFETIME_SECONDS } from "./api-gate-protocol.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** Instances may disagree about the time; a fresh cookie must not look too new. */
const CLOCK_SKEW_SECONDS = 60;
const TOKEN = /^v1\.([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const DEVELOPMENT_SECRET = Symbol.for("blast.apiGate.developmentSecret");

export type GateKeys = Readonly<{ signing: string; verifying: readonly string[] }>;

function usable(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= MINIMUM_SECRET_LENGTH;
}

/**
 * The secrets the gate signs and verifies with, or null when production has
 * none. Outside production a random secret is kept on `globalThis`, so the
 * proxy bundles in one `next dev` process agree. Backend refresh requires
 * an explicit shared key because it runs in another process.
 */
export function gateKeys(environment: Environment = process.env): GateKeys | null {
  const current = environment.BLAST_GATE_SECRET;
  if (usable(current)) {
    const previous = environment.BLAST_GATE_SECRET_PREVIOUS;
    return rotatingGateKeys(current, usable(previous) ? previous : null);
  }
  if (!deploymentIdentity(environment).localRun) return null;
  const store = globalThis as typeof globalThis & { [DEVELOPMENT_SECRET]?: string };
  store[DEVELOPMENT_SECRET] ??= randomBytes(32).toString("base64url");
  return { signing: store[DEVELOPMENT_SECRET], verifying: [store[DEVELOPMENT_SECRET]] };
}

/** Signs with `current`; also accepts tokens signed with `previous` during a rotation. */
export function rotatingGateKeys(current: string, previous: string | null): GateKeys {
  return { signing: current, verifying: previous !== null && previous !== current ? [current, previous] : [current] };
}

function signature(secret: string, issuedAt: number, id: string): Buffer {
  return createHmac("sha256", secret).update(`blast-gate:v1:${issuedAt}.${id}`).digest();
}

/** A new gate token issued at `now` (epoch ms). */
export function mintGateToken(keys: GateKeys, now: number = Date.now()): string {
  const issuedAt = Math.floor(now / 1_000);
  const id = randomBytes(16).toString("base64url");
  return `v1.${issuedAt}.${id}.${signature(keys.signing, issuedAt, id).toString("base64url")}`;
}

/** The token's issue time (epoch seconds) when it is genuine and unexpired at `now`, else null. */
export function gateTokenIssuedAt(value: string, keys: GateKeys, now: number = Date.now()): number | null {
  const match = TOKEN.exec(value);
  if (!match) return null;
  const issuedAt = Number(match[1]);
  const nowSeconds = Math.floor(now / 1_000);
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS || nowSeconds - issuedAt >= GATE_LIFETIME_SECONDS) return null;
  const presented = Buffer.from(match[3], "base64url");
  if (presented.byteLength !== 32) return null;
  let valid = false;
  for (const secret of keys.verifying) {
    // Every secret is compared, so the time taken does not say which matched.
    if (timingSafeEqual(presented, signature(secret, issuedAt, match[2]))) valid = true;
  }
  return valid ? issuedAt : null;
}

/** Whether the request reached us over HTTPS; only then is the `__Host-` cookie used. */
export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

export function gateCookieName(secure: boolean): string {
  return secure ? GATE_COOKIE_NAME : GATE_COOKIE_NAME_INSECURE;
}

/** Every value the Cookie header carries under the gate cookie's name for this scheme. */
function presentedTokens(request: Request): string[] {
  const name = gateCookieName(isSecureRequest(request));
  const values: string[] = [];
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    values.push(part.slice(separator + 1).trim());
  }
  return values;
}

/** The newest valid gate cookie's issue time (epoch seconds), or null. */
export function requestGateIssuedAt(request: Request, keys: GateKeys, now: number = Date.now()): number | null {
  let newest: number | null = null;
  for (const value of presentedTokens(request).slice(0, 4)) {
    const issuedAt = gateTokenIssuedAt(value, keys, now);
    if (issuedAt !== null && (newest === null || issuedAt > newest)) newest = issuedAt;
  }
  return newest;
}

/** The `Set-Cookie` value for `token`: HttpOnly, SameSite=Lax, Path=/, Secure (and `__Host-`) over HTTPS. */
export function gateSetCookie(token: string, secure: boolean): string {
  return `${gateCookieName(secure)}=${token}; Path=/; Max-Age=${GATE_LIFETIME_SECONDS}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax`;
}

/** A fresh gate cookie for `request`'s scheme. */
export function issueGateCookie(request: Request, keys: GateKeys, now: number = Date.now()): string {
  return gateSetCookie(mintGateToken(keys, now), isSecureRequest(request));
}
