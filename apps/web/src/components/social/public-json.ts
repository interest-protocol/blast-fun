import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { responseDiagnostic, responseError } from "#web/lib/errors.ts";
import { QueryTransientError } from "#web/lib/query/client.ts";

import { parseSocialResponse, type SocialResponseBody } from "./social-api.ts";

type PublicJsonOptions = Readonly<{
  signal?: AbortSignal;
  networkError?: () => Error;
  notFound?: () => Error;
  invalidResponse?: () => Error;
}>;

export function publicReadSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function publicJson<Body>(
  path: string,
  what: string,
  contract: SocialResponseBody<Body>,
  options: PublicJsonOptions = {},
): Promise<Body> {
  let response: Response;
  try {
    response = await gatedFetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: options.signal,
    });
  } catch (error) {
    throw options.networkError ? options.networkError() : error;
  }

  if (response.status === 404 && options.notFound) throw options.notFound();
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw responseError(body, response, `${what} could not load. Try again.`);

  const parsed = parseSocialResponse(contract, body);
  if (parsed) return parsed.data;
  throw options.invalidResponse?.() ?? new QueryTransientError(
    `${what} returned an unreadable response. Try again.`,
    response.status,
    responseDiagnostic(response).requestId,
    "invalid_response",
  );
}
