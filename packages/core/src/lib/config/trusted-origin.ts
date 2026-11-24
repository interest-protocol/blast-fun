export type TrustedUrlRules = Readonly<{
  /** `origin` refuses credentials, a path, a query and a hash. `url` accepts all four. */
  shape: "origin" | "url";
  http: "never" | "loopback" | "any";
  plainHost?: boolean;
}>;

/**
 * A host as the URL parser serializes it: a DNS name or IPv4 address (dot-separated labels of
 * letters, digits and hyphens) or a bracketed IPv6 literal. The parser also accepts `*`, `_`, `;`,
 * `,` and other characters, which a configured origin must never hold.
 */
const PLAIN_HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?|\[[0-9a-f:]+\])$/i;

const LOOPBACK_IPV4 = /^127\.(?:\d{1,3}\.){2}\d{1,3}$/;

/**
 * The one parser for a URL read from configuration. It returns the `URL`, so each caller keeps its
 * own return text. Errors name the variable and never repeat the value, which may embed a key.
 */
export function trustedUrl(name: string, raw: string | undefined, rules: TrustedUrlRules): URL {
  if (!raw) {
    throw new Error(`${name} is required.`);
  }

  const url = URL.parse(raw);

  if (!url || !hasAllowedScheme(url, rules.http) || !hasAllowedShape(url, rules)) {
    throw new Error(`${name} must be ${expectation(rules)}.`);
  }

  return url;
}

function hasAllowedScheme(url: URL, http: TrustedUrlRules["http"]): boolean {
  if (url.protocol === "https:") {
    return true;
  }

  if (url.protocol !== "http:") {
    return false;
  }

  return http === "any" || (http === "loopback" && isLoopback(url.hostname));
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || LOOPBACK_IPV4.test(hostname);
}

function hasAllowedShape(url: URL, rules: TrustedUrlRules): boolean {
  if (rules.plainHost && !PLAIN_HOST.test(url.hostname)) {
    return false;
  }

  return (
    rules.shape === "url" ||
    (url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password)
  );
}

function expectation(rules: TrustedUrlRules): string {
  if (rules.shape === "url") {
    return "an https URL";
  }

  if (rules.http === "any") {
    return "a bare HTTP(S) origin";
  }

  return rules.http === "loopback"
    ? "a bare HTTPS origin (HTTP only on loopback)"
    : "a bare HTTPS origin";
}
