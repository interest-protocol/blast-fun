import { randomUUID } from "node:crypto";

import { errorLabel, recordMetric } from "./metrics.ts";

export type PublicErrorResponseOptions = Readonly<{
  requestId?: string;
  cause?: unknown;
  route?: string;
  headers?: HeadersInit;
  /** Existing domain fields or a legacy envelope; callers supply only safe values. */
  body?: Readonly<Record<string, unknown>>;
}>;

/** Fixed domain copy goes to the client; only a value-free cause label goes to the correlated log. */
export function publicErrorResponse(
  code: string,
  message: string,
  status: number,
  options: PublicErrorResponseOptions = {},
): Response {
  const requestId = options.requestId ?? randomUUID();
  const headers = new Headers(options.headers);
  headers.set("Cache-Control", headers.get("Cache-Control") ?? "no-store");
  headers.set("X-Request-ID", requestId);
  if (status === 503 && !headers.has("Retry-After")) headers.set("Retry-After", "5");
  recordMetric("http.error", {
    route: options.route ?? code,
    requestId,
    code,
    status,
    ...(options.cause === undefined ? {} : { cause: errorLabel(options.cause) }),
  });
  return Response.json(options.body ?? { error: { code, message } }, { status, headers });
}

/** Adds references and correlated logs to fixed, server-owned JSON error envelopes. */
export function publicJson(body: unknown, init: ResponseInit = {}, cause?: unknown): Response {
  const status = init.status ?? 200;
  if (status < 400) return Response.json(body, init);
  const fields = body !== null && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown> : {};
  const error = fields.error !== null && typeof fields.error === "object" && !Array.isArray(fields.error)
    ? fields.error as Record<string, unknown> : {};
  const code = typeof error.code === "string" ? error.code : status >= 500 ? "SERVICE_UNAVAILABLE" : "REQUEST_INVALID";
  const message = typeof error.message === "string" ? error.message : status >= 500
    ? "This service is temporarily unavailable. Please retry." : "The request could not be completed.";
  const requestId = typeof fields.requestId === "string" ? fields.requestId : new Headers(init.headers).get("X-Request-ID");
  return publicErrorResponse(code, message, status, {
    ...(requestId ? { requestId } : {}),
    headers: init.headers,
    cause,
    body: { ...fields, error: { ...error, code, message } },
  });
}

/** Final guard for routes whose dependency adapters may unexpectedly throw. */
export function safeRouteHandler<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
  failure: Readonly<{ code: string; message: string; status: number }> = { code: "INTERNAL_ERROR", message: "The request could not be completed. Please retry.", status: 500 },
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (cause) {
      return publicErrorResponse(failure.code, failure.message, failure.status, { cause });
    }
  };
}
