import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { responseDiagnostic } from "#web/lib/errors.ts";

import { socialRequestAuth, type AccessTokenSource, type SocialRequestAuth } from "./social-fetch.ts";

export type TokenSource = AccessTokenSource;

export type ApiResult<Body> =
  | Readonly<{ status: "ok"; body: Body; httpStatus: number }>
  | Readonly<{ status: "refused"; code: string; retryAfterSeconds: number | null; reasons?: readonly string[]; httpStatus?: number; requestId?: string }>
  | Readonly<{ status: "error"; code?: string; httpStatus?: number; requestId?: string }>;

export type SocialApiOptions = Readonly<{ getAccessToken: TokenSource; signal?: AbortSignal; fetch?: typeof globalThis.fetch }>;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function socialErrorBody(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.error) ? value.error : null;
}

/**
 * One call to a signed-in social route: the viewer's credentials, never
 * cached, the published refusal decoded. Shared by Settings, Notifications
 * (UI-13) and Profile (UI-06), so the session rework (OA-16) changes one
 * place. A JSON `body`, a `raw` one sent with its own type (a picture
 * upload), or a `form` the browser encodes as `multipart/form-data` (a sale
 * cover, R3-28).
 */
type SocialApiInit = Readonly<{ method: "GET" | "PUT" | "POST" | "DELETE"; headers?: Readonly<Record<string, string>>; body?: unknown; raw?: Blob; form?: FormData }>;

export type SocialResponseBody<Body> =
  { safeParse: (value: unknown) => { success: true; data: Body } | { success: false } };

export function parseSocialResponse<Body>(contract: SocialResponseBody<Body>, value: unknown): { data: Body } | null {
  const parsed = contract.safeParse(value);
  return parsed.success ? parsed : null;
}

function socialRequestBody(init: SocialApiInit): Readonly<{ headers: Record<string, string>; body?: Blob | FormData | string }> {
  const headers: Record<string, string> = init.raw ? { "content-type": init.raw.type } : init.body === undefined ? {} : { "content-type": "application/json" };
  if (init.form) return { headers, body: init.form };
  if (init.raw) return { headers, body: init.raw };
  if (init.body === undefined) return { headers };
  return { headers, body: JSON.stringify(init.body) };
}

function transportFailureCode(signal?: AbortSignal): string {
  return signal?.aborted ? "request_cancelled" : "network_unavailable";
}

export async function callSocialApi<Body>(
  options: SocialApiOptions,
  path: string,
  init: SocialApiInit,
  contract: SocialResponseBody<Body>,
): Promise<ApiResult<Body>> {
  const request = options.fetch ?? gatedFetch;
  const send = async (auth: SocialRequestAuth): Promise<Response> => {
    const payload = socialRequestBody(init);
    return request(path, {
      ...payload,
      method: init.method,
      cache: "no-store",
      credentials: auth.credentials,
      signal: options.signal,
      headers: {
        ...init.headers,
        ...auth.headers,
        ...payload.headers,
      },
    });
  };
  const auth = await socialRequestAuth(options.getAccessToken);
  if (options.signal?.aborted) return { status: "error", code: "request_cancelled" };
  if (!auth) return { status: "error", code: "authentication_unavailable" };
  let response: Response;
  let body: unknown;
  try {
    response = await send(auth);
    body = await response.json().catch(() => null);
    // A token the server no longer takes (it rotated, or the read went out
    // while the session was still settling): ask for the token again and
    // resend once, so the viewer is not shown signed out until a reload.
    if (response.status === 401 && socialErrorBody(body)?.code === "unauthorized") {
      const again = await socialRequestAuth(options.getAccessToken);
      // The same token again would only be refused again.
      if (again?.headers.authorization && again.headers.authorization !== auth.headers.authorization && !options.signal?.aborted) {
        response = await send(again);
        body = await response.json().catch(() => null);
      }
    }
  } catch {
    return { status: "error", code: transportFailureCode(options.signal) };
  }
  const reference = responseDiagnostic(response);
  if (response.ok) {
    const parsed = parseSocialResponse(contract, body);
    if (parsed) {
      return { status: "ok", body: parsed.data, httpStatus: response.status };
    }
    return { status: "error", code: "invalid_response", ...reference };
  }
  const error = socialErrorBody(body);
  if (!error || typeof error.code !== "string") return { status: "error", code: "invalid_response", ...reference };
  const reasons = error.reasons;
  return { status: "refused", code: error.code, ...reference, retryAfterSeconds: reference.retryAfterSeconds ?? null,
    ...(Array.isArray(reasons) && reasons.every((reason) => typeof reason === "string") ? { reasons } : {}),
  };
}
