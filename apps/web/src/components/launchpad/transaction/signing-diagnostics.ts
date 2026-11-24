import { track } from "@vercel/analytics";

import type { SignerKind } from "./action-machine.ts";

const PROVIDER_CODES = new Map<string | number, string>([
  [4100, "wallet_account_unauthorized"],
  [4200, "wallet_signing_unsupported"],
  [4900, "wallet_disconnected"],
  [4901, "wallet_network_unsupported"],
  ["must_be_authenticated", "privy_session_invalid"],
  ["missing_or_invalid_token", "privy_session_invalid"],
  ["embedded_wallet_not_found", "wallet_account_missing"],
  ["missing_or_invalid_mfa", "wallet_mfa_required"],
  ["client_request_timeout", "wallet_request_timed_out"],
  ["session_storage_unavailable", "wallet_storage_unavailable"],
  ["too_many_requests", "wallet_provider_rate_limited"],
]);

// The Sui wallet kit, Slush and Privy can throw plain Errors with no code.
// Match known messages in memory because they can contain an account or provider data.
const KNOWN_MESSAGES: readonly (readonly [RegExp, string])[] = [
  [/^Failed to open new window$/, "wallet_popup_open_failed"],
  [/^User closed the wallet window$/, "wallet_popup_closed"],
  [/^No session found$/, "wallet_session_missing"],
  [/^App and session origin mismatch$/, "wallet_session_origin_mismatch"],
  [/^.+ is not available in this browser\. Install it, then try again\.$/, "wallet_unavailable"],
  [/^No wallet is connected\.$/, "wallet_disconnected"],
  [/^(No accounts were authorized\.|Requested account not found in session)$/, "wallet_account_unauthorized"],
  [/^No account with address |^.+ has not authorized this wallet address\./, "wallet_account_unauthorized"],
  [/^The account .+ does not support the chain /, "wallet_network_unsupported"],
  [/^Requested chain not authorized by session$/, "wallet_network_unsupported"],
  [/^The account .+ does not support signing transactions\.$/, "wallet_signing_unsupported"],
  [/^Requested operation not authorized by session$/, "wallet_signing_unsupported"],
  [/^User must be authenticated before signing$/, "privy_session_invalid"],
  [/^Wallet not found$/, "wallet_account_missing"],
  [/^Privy returned an invalid Sui signature\.$|^The wallet did not return its signed transaction bytes\.$/, "wallet_signing_response_invalid"],
  [/^(Failed to fetch|NetworkError when attempting to fetch resource\.)$/, "wallet_network_request_failed"],
];

type SigningFailure = Readonly<{ reason: string; provider_code?: string | number }>;
type ProviderError = Readonly<{ code?: unknown; privyErrorCode?: unknown; message?: unknown; cause?: unknown }>;

function describeSigningFailure(error: unknown): SigningFailure {
  for (let depth = 0; depth < 4 && error !== null && typeof error === "object"; depth += 1) {
    const details: ProviderError = error;
    const code = details.privyErrorCode ?? details.code;
    if (typeof code === "string" || typeof code === "number") {
      const reason = PROVIDER_CODES.get(code);
      if (reason) {
        return { reason, provider_code: code };
      }
    }
    const { message } = details;
    if (typeof message === "string" && message.length <= 512) {
      const match = KNOWN_MESSAGES.find(([pattern]) => pattern.test(message));
      if (match) {
        return { reason: match[1] };
      }
    }
    error = details.cause;
  }
  return { reason: "unrecognized_wallet_error" };
}

export function reportWalletSigningFailure(signer: SignerKind, error: unknown): void {
  try {
    if (typeof window !== "undefined") {
      track("wallet_signature_failed", { signer, ...describeSigningFailure(error) });
    }
  } catch {
    // Wallet errors and analytics must leave the signing outcome intact.
  }
}
