/** Pure transport metadata; importing this module never opens an auth store. */
export function isVersionedPartnerPath(path: string): boolean {
  return /^\/api\/v[0-9]+(?:\/|$)/.test(path);
}

export const PARTNER_KEY_HEADER = "x-blast-partner-key";

export function isPartnerRequest(request: Request): boolean {
  return (
    isVersionedPartnerPath(new URL(request.url).pathname) ||
    request.headers.has(PARTNER_KEY_HEADER) ||
    (request.method === "OPTIONS" &&
      requestedHeaders(request).includes(PARTNER_KEY_HEADER))
  );
}

export function requestedHeaders(request: Request): string[] {
  return (request.headers.get("access-control-request-headers") ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
}

/** Applied in the proxy, including refusals. Never cache partner CORS headers. */
export function partnerResponseHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "CDN-Cache-Control": "no-store",
    "Vercel-CDN-Cache-Control": "no-store",
    Vary: "Origin",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", "Retry-After");
  }
  return headers;
}
