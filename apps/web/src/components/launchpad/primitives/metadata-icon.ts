// Coin metadata icons are untrusted creator input. Only a plausible, public
// https image URL is shown; anything else gets a generated gradient fallback
// that can never be mistaken for an official Sui or Blast mark.

const MAX_URL_LENGTH = 2048;
const PLACEHOLDER_TEXT = /[<>{}]|your[_-]|placeholder|replace[_-]?me|changeme|\btodo\b/i;
const RESERVED_HOST =
  /(^|\.)(example\.(com|net|org)|localhost)$|\.(test|invalid|local|localhost|example|internal)$/i;
const IP_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$|^\[/;
const SECRET_PARAMETER =
  /^(token|access_token|id_token|auth|authorization|api[_-]?key|key|secret|sig|signature|password|pass|credential)$|^x-(amz|goog)-/i;

/** The icon URL when it is safe and real enough to render, otherwise null. */
export function validMetadataIconUrl(raw: string | null | undefined): string | null {
  const candidate = raw?.trim();
  if (!candidate || candidate.length > MAX_URL_LENGTH || PLACEHOLDER_TEXT.test(candidate)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  // "localhost." is localhost; a public host always has at least two labels.
  const host = url.hostname.replace(/\.$/, "");
  if (!host.includes(".") || RESERVED_HOST.test(host) || IP_LITERAL.test(host)) return null;
  // Tokens also travel in fragments (OAuth implicit flow: #access_token=…).
  const fragment = new URLSearchParams(url.hash.slice(1));
  for (const name of [...url.searchParams.keys(), ...fragment.keys()]) {
    if (SECRET_PARAMETER.test(name)) return null;
  }
  return candidate;
}
