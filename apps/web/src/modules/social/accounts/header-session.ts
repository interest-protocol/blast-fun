import { z } from "zod";
import type { SocialMeResponse } from "@blast/core/modules/social/contracts/me.ts";
import { readWalletSessionToken } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";

import { shellViewerOf } from "#web/components/blast-ui/shell-viewer.ts";
import type { HeaderSession } from "#web/components/social/use-header-session.ts";

const SIGNED_OUT: HeaderSession = { signedIn: false, viewer: null, viewerLoading: false, viewerError: false };
const HEADER_SESSION_TIMEOUT_MS = 1_000;

/** The request carries a Privy access or session cookie: the page loads Privy's SDK at once. */
export function hasPrivySessionCookie(headers: Headers): boolean {
  return (headers.get("cookie") ?? "").split(";").some((part) => /^privy-(?:token|session)=/.test(part.trim()));
}

/** A request-local read through the existing me handler; credentials never reach client props. */
export async function readHeaderSession(
  request: Request,
  readMe: (request: Request) => Promise<Response>,
  privyEnabled: boolean,
): Promise<HeaderSession | null> {
  const cookies = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim());
  const tokens = cookies.filter((part) => part.startsWith("privy-token=")).map((part) => part.slice("privy-token=".length));
  const privyToken = privyEnabled ? tokens[0] : undefined;
  if (privyEnabled && tokens.length > 0 && !z.tuple([z.string().max(8192).regex(/^[\w-]+\.[\w-]+\.[\w-]+$/)]).safeParse(tokens).success) return null;
  // An expired access cookie can disappear while Privy's refresh session still exists.
  if (privyEnabled && !privyToken && cookies.some((part) => part.startsWith("privy-session="))) return null;
  if (!privyToken && !readWalletSessionToken(request)) {
    // Existing Privy sessions may live only in local storage; absence is not proof of sign-out.
    return privyEnabled ? null : SIGNED_OUT;
  }

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  if (privyToken) headers.set("authorization", `Bearer ${privyToken}`);
  // Bun restores trusted SSR metadata only after verifying the separate read-only proof.
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(HEADER_SESSION_TIMEOUT_MS)]);
    const response = await readMe(new Request(request.url, { headers, signal }));
    if (response.status === 401 && !privyEnabled) return SIGNED_OUT;
    if (!response.ok) return null;
    const { account }: SocialMeResponse = await response.json();
    // First-time account creation remains in the existing client sign-in flow.
    return account ? { signedIn: true, viewer: shellViewerOf(account), viewerLoading: false, viewerError: false } : null;
  } catch {
    return null;
  }
}
