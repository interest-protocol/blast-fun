import { trustedUrl } from "@blast/core/lib/config/trusted-origin.ts";
import { signGatewayRequest } from "./gateway.ts";
import { HOP_BY_HOP_HEADERS } from "./hop-by-hop.ts";
import { signPrivateRequest, type PrivateSigningContext } from "./private-gateway.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** How a relay proves itself to the backend: the gateway scheme, the private scheme, or not at all (cron). */
export type BackendSigning =
  | Readonly<{ scheme: "gateway"; secret: string; ip: string; namespace: string }>
  | Readonly<{ scheme: "private"; secret: string; context: PrivateSigningContext }>
  | Readonly<{ scheme: "unsigned" }>;

type BackendCall = Readonly<{
  url: URL;
  method: string;
  /** What the relay chose to forward; the client strips hop-by-hop fields, `host` and `content-length`. */
  headers: Headers;
  body?: Uint8Array<ArrayBuffer>;
  signing: BackendSigning;
  /** The incoming request's signal; the call also ends after `timeoutMs`. */
  signal: AbortSignal;
  timeoutMs: number;
  redirect: "error" | "manual";
  cache?: "no-store";
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}>;

/**
 * A backend origin from `environment[name]`: a bare HTTPS origin, or HTTP on loopback. Unset is
 * null unless `required`; a set value that does not parse throws.
 */
export function backendOrigin(environment: Environment, name: string, required: boolean): string | null {
  const raw = environment[name];
  if (!raw && !required) {
    return null;
  }
  return trustedUrl(name, raw, { shape: "origin", http: "loopback" }).origin;
}

/** Signs and sends one relay call, and returns the backend's answer without wire metadata. */
export async function callBackend(call: BackendCall): Promise<Response> {
  const headers = new Headers(call.headers);
  for (const name of [...HOP_BY_HOP_HEADERS, "host", "content-length"]) {
    headers.delete(name);
  }
  const body = call.body?.byteLength ? { body: call.body } : {};
  const response = await (call.fetch ?? fetch)(call.url, {
    method: call.method,
    headers: signed(call, () => new Request(call.url, { method: call.method, headers, ...body })) ?? headers,
    ...body,
    signal: AbortSignal.any([call.signal, AbortSignal.timeout(call.timeoutMs)]),
    redirect: call.redirect,
    ...(call.cache ? { cache: call.cache } : {}),
  });
  return new Response(response.body, { status: response.status, headers: responseHeaders(response) });
}

/** The signed headers, or null for an unsigned call. */
function signed(call: BackendCall, outgoing: () => Request): Headers | null {
  const signing = call.signing;
  switch (signing.scheme) {
    case "gateway":
      return signGatewayRequest(outgoing(), signing.secret, signing.ip, signing.namespace);
    case "private":
      return signPrivateRequest(outgoing(), call.body ?? new Uint8Array(), signing.secret, signing.context);
    case "unsigned":
      return null;
    default:
      return signing satisfies never;
  }
}

/** Native fetch decodes compressed bodies but keeps their length and encoding; drop those too. */
function responseHeaders(response: Response): Headers {
  // Headers preserves separate Set-Cookie fields; never split a cookie on commas.
  const headers = new Headers(response.headers);
  const listed = (headers.get("connection") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of [...listed, ...HOP_BY_HOP_HEADERS, "content-length", "content-encoding"]) {
    headers.delete(name);
  }
  return headers;
}
