import { z } from "zod";
import { observeMetric } from "@blast/core/lib/metrics.ts";
import type { SocialMeResponse } from "@blast/core/modules/social/contracts/me.ts";
import { readWalletSessionToken } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";

import { selectedAccountSession } from "#web/components/social/account-selection.ts";
import { shellViewerOf } from "#web/components/blast-ui/shell-viewer.ts";
import type { HeaderSession } from "#web/components/social/use-header-session.ts";

const SIGNED_OUT: HeaderSession = { signedIn: false, viewer: null, viewerLoading: false, viewerError: false };
const HEADER_SESSION_TIMEOUT_MS = 1_000;
/** One in ten expected answers logs its time; a timeout, failure or server error always does. */
const HEADER_SESSION_SAMPLE_RATE = 0.1;
const EXPECTED_OUTCOMES: ReadonlySet<string> = new Set(["signed_in", "no_account", "aborted", "status_401"]);

/** How long the page waited on the account read before it could render the header (`social.header_session`). */
function recordWait(startedMs: number, outcome: string): void {
  observeMetric(
    "social.header_session",
    { outcome, durationMs: Math.round(performance.now() - startedMs) },
    { sampleRate: EXPECTED_OUTCOMES.has(outcome) ? HEADER_SESSION_SAMPLE_RATE : 1 },
  );
}

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
  const cookieHeader = request.headers.get("cookie") ?? "";
  const selection = selectedAccountSession(cookieHeader);
  const usePrivy = privyEnabled && selection !== "wallet";
  const privyToken = usePrivy ? readPrivyAccessCookie(cookieHeader) : null;
  if (privyToken === undefined) return null;
  if (!privyToken && (selection === "privy" || !readWalletSessionToken(request))) {
    // Existing Privy sessions may live only in local storage; absence is not proof of sign-out.
    return privyEnabled ? null : SIGNED_OUT;
  }

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  if (privyToken) headers.set("authorization", `Bearer ${privyToken}`);
  // Bun restores trusted SSR metadata only after verifying the separate read-only proof.
  return readAccount(request, headers, readMe, privyEnabled);
}

/** The me read within the header's wait; every outcome is timed (`recordWait`). */
async function readAccount(
  request: Request,
  headers: Headers,
  readMe: (request: Request) => Promise<Response>,
  privyEnabled: boolean,
): Promise<HeaderSession | null> {
  const startedMs = performance.now();
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(HEADER_SESSION_TIMEOUT_MS)]);
    const response = await readMe(new Request(request.url, { headers, signal }));
    if (!response.ok) {
      recordWait(startedMs, `status_${response.status}`);
      return response.status === 401 && !privyEnabled ? SIGNED_OUT : null;
    }
    const { account }: SocialMeResponse = await response.json();
    recordWait(startedMs, account ? "signed_in" : "no_account");
    // First-time account creation remains in the existing client sign-in flow.
    return account ? { signedIn: true, viewer: shellViewerOf(account), viewerLoading: false, viewerError: false } : null;
  } catch (error) {
    recordWait(startedMs, waitFailure(request, error));
    return null;
  }
}

/** Why the read ended early: the 1 s wait ran out, the visitor left, or it failed. */
function waitFailure(request: Request, error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  return request.signal.aborted ? "aborted" : "failed";
}

/** A refreshable or malformed cookie leaves the browser to resolve Privy's session. */
function readPrivyAccessCookie(cookieHeader: string): string | null | undefined {
  const cookies = cookieHeader.split(";").map((part) => part.trim());
  const tokens = cookies.filter((part) => part.startsWith("privy-token=")).map((part) => part.slice("privy-token=".length));
  if (tokens.length === 0) {
    return cookies.some((part) => part.startsWith("privy-session=")) ? undefined : null;
  }
  return z.tuple([z.string().max(8192).regex(/^[\w-]+\.[\w-]+\.[\w-]+$/)]).safeParse(tokens).data?.[0];
}
