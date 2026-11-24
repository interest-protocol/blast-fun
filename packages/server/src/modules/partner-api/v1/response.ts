/** Credentials and untrusted caller context never reach public data handlers. */
export function anonymousPartnerHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (["cookie", "authorization", "x-blast-api-key", "x-blast-partner-key", "x-blast-home-rewrite", "x-blast-profile-rewrite"].includes(name) ||
        name.startsWith("x-blast-internal-") || name.startsWith("x-blast-gateway-")) headers.delete(name);
  }
  return headers;
}

/** API responses need no browser-rendering configuration or frontend imports. */
export function applyPartnerApiHeaders<T extends Response>(response: T, accessHeaders: Headers): T {
  response.headers.set("X-Content-Type-Options", "nosniff");
  for (const [name, value] of accessHeaders) {
    if (name === "vary") response.headers.append(name, value);
    else response.headers.set(name, value);
  }
  return response;
}
