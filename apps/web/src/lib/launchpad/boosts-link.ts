// WHATWG URL parsing normalizes every IPv4 spelling to dotted decimal and
// brackets IPv6, so these catch all IP-literal hosts.
const IP_LITERAL_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[.*\])$/;
// Names that only resolve on a private network or the local machine.
const PRIVATE_NAME_SUFFIXES = [".localhost", ".local", ".internal"];

/**
 * The direct Boosts link from `BLAST_BOOSTS_URL`, or null when it is unset
 * (render no link). A set value must be production-safe: an absolute HTTPS
 * URL to a public, multi-label host name (not localhost, .local, .internal,
 * or an IP), without credentials or surrounding whitespace; anything else
 * fails, naming only the variable.
 */
export function boostsLinkUrl(value: string | undefined): string | null {
  if (!value) return null;
  const url = value.trim() === value ? URL.parse(value) : null;
  // A trailing dot is the same fully qualified name ("localhost." = "localhost").
  const host = url?.hostname.replace(/\.$/, "") ?? "";
  if (
    url === null ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !host.includes(".") ||
    PRIVATE_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    IP_LITERAL_HOST.test(host)
  ) {
    throw new Error("BLAST_BOOSTS_URL must be an HTTPS URL on a public host name.");
  }
  return url.href;
}
