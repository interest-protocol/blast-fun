/**
 * The nonce this document's Content-Security-Policy allows. A layout mounted
 * by client navigation (from a social page to `/presale` or `/settings`, each
 * with its own provider root) is rendered from an RSC request with its own
 * fresh nonce, which this page's policy does not list: styled-components'
 * style tag with that nonce is refused, has no sheet, and Privy's styles throw
 * (styled-components error 17, "This page couldn't load"). The nonce Next put
 * on this document's scripts is the one the policy allows; `fallback` (the
 * request's) on the server and when the document has none.
 */
export function documentNonce(
  fallback: string | null,
  doc: Pick<Document, "querySelector"> | undefined = globalThis.document,
): string | null {
  if (!doc) return fallback;
  return doc.querySelector<HTMLScriptElement>("script[nonce]")?.nonce || fallback;
}
