import { responseDiagnostic } from "#web/lib/errors.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import {
  SOCIAL_ACCOUNTS_PATH,
  socialCallsignPath,
  socialCallsignAvailabilitySchema,
  socialCreateAccountResponseSchema,
  type SocialAccountField,
  type SocialCallsignAvailability,
} from "@blast/core/web/contracts/accounts.ts";
import type { SocialMeAccount } from "@blast/core/web/contracts/me.ts";
import { socialRequestAuth } from "./social-fetch";

export type CreateAccountRefusal = Readonly<{
  status: "refused";
  code: string;
  httpStatus?: number;
  requestId?: string;
  retryAfterSeconds: number | null;
  /** For `blocked_term`: the field that holds the term. */
  field: SocialAccountField | null;
}>;
export type CreateAccountFailure = CreateAccountRefusal | Readonly<{ status: "error"; code?: string; httpStatus?: number; requestId?: string }>;

export type CallsignCheckResult = Readonly<{ status: "checked"; availability: SocialCallsignAvailability }> | CreateAccountFailure;
export type CreateAccountResult = Readonly<{ status: "created"; account: SocialMeAccount }> | CreateAccountFailure;

type Transport = Readonly<{
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}>;

/** Calls a social route with the caller's Privy token; answers the body of `expected`, or the failure. An abort rethrows. */
async function call(
  input: Transport,
  path: string,
  expected: number,
  init: Readonly<{ method: "GET" | "POST"; body?: unknown }>,
): Promise<Readonly<{ ok: true; body: unknown; httpStatus: number; requestId?: string }> | CreateAccountFailure> {
  const request = input.fetch ?? gatedFetch;
  const auth = await socialRequestAuth(input.getAccessToken);
  if (!auth) return { status: "error", code: "authentication_unavailable" };
  const headers: Record<string, string> = { ...auth.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await request(path, {
      method: init.method,
      cache: "no-store",
      credentials: auth.credentials,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { status: "error", code: "network_unavailable" };
  }
  const diagnostic = responseDiagnostic(response);
  const parsed: unknown = await response.json().catch(() => null);
  if (response.status === expected) return { ok: true, body: parsed, ...diagnostic };
  const error = (parsed as { error?: { code?: unknown; field?: unknown } } | null)?.error;
  if (typeof error?.code !== "string") return { status: "error", code: "invalid_response", ...diagnostic };
  const retryAfter = Number(response.headers.get("retry-after"));
  return {
    status: "refused",
    code: error.code,
    ...diagnostic,
    retryAfterSeconds: Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : null,
    field: error.field === "callsign" || error.field === "display_name" ? error.field : null,
  };
}

/** `GET /api/social/callsigns/{callsign}`: whether the callsign can be taken, and why not. */
export async function fetchCallsignAvailability(input: Transport & Readonly<{ callsign: string }>): Promise<CallsignCheckResult> {
  const result = await call(input, socialCallsignPath(input.callsign), 200, { method: "GET" });
  if (!("ok" in result)) return result;
  const parsed = socialCallsignAvailabilitySchema.safeParse(result.body);
  return parsed.success ? { status: "checked", availability: parsed.data } : { status: "error", code: "invalid_response", httpStatus: result.httpStatus, ...(result.requestId ? { requestId: result.requestId } : {}) };
}

/** Creates saved random defaults with `{}`, or creates an explicitly chosen identity. */
export async function postCreateAccount(
  input: Transport & Readonly<{ callsign?: string; displayName?: string }>,
): Promise<CreateAccountResult> {
  const result = await call(input, SOCIAL_ACCOUNTS_PATH, 201, {
    method: "POST",
    body: input.displayName === undefined ? { callsign: input.callsign } : { callsign: input.callsign, display_name: input.displayName },
  });
  if (!("ok" in result)) return result;
  const parsed = socialCreateAccountResponseSchema.safeParse(result.body);
  return parsed.success
    ? { status: "created", account: parsed.data.account }
    : { status: "error", code: "invalid_response", httpStatus: result.httpStatus, ...(result.requestId ? { requestId: result.requestId } : {}) };
}
