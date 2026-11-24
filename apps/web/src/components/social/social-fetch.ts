/**
 * How every social client authenticates a call (OA-16): with a Privy access
 * token when the viewer has one (`Authorization: Bearer`), otherwise with the
 * Sui wallet session cookie, which the browser sends on same-origin requests
 * only (`credentials: "same-origin"`; HttpOnly, script never sees it). The
 * server prefers the token when both arrive. A visitor with neither gets the
 * route's `401`.
 */
export type AccessTokenSource = () => Promise<string | null>;

export type SocialRequestAuth = Readonly<{ headers: Readonly<Record<string, string>>; credentials: RequestCredentials }>;

/** The headers and credentials for one social call; null when the token source failed (a network or Privy error). */
export async function socialRequestAuth(getAccessToken?: AccessTokenSource | null): Promise<SocialRequestAuth | null> {
  let token: string | null = null;
  try {
    token = getAccessToken ? await getAccessToken() : null;
  } catch {
    return null;
  }
  return token
    ? { headers: { authorization: `Bearer ${token}` }, credentials: "same-origin" }
    : { headers: {}, credentials: "same-origin" };
}
