import { PrivyAdapterError } from "../../../../src/lib/privy-adapter/errors.ts";
import type {
  PrivyAccessClaims,
  PrivyProviderGateway,
} from "../../../../src/lib/privy-adapter/types.ts";

export const SYNTHETIC_PRIVY_DID = "did:privy:synthetic-blast-user";
export const SYNTHETIC_X_SUBJECT = "x-subject-1042";
export const SYNTHETIC_SUI_ADDRESS = `0x${"42".repeat(32)}`;

export type SyntheticPrivyFixtureMode =
  | "expired"
  | "malformed-token"
  | "provider-timeout"
  | "success";

export function syntheticPrivyClaims(
  nowEpochSeconds = 2_000_000_000,
): PrivyAccessClaims {
  return {
    appId: "synthetic-privy-app",
    expiration: nowEpochSeconds + 3_600,
    issuedAt: nowEpochSeconds - 60,
    issuer: "privy.io",
    sessionId: "synthetic-session-proof",
    userId: SYNTHETIC_PRIVY_DID,
  };
}

export function syntheticPrivyUser(options?: Readonly<{ withWallet?: boolean }>) {
  const linkedAccounts: Record<string, unknown>[] = [
    {
      latest_verified_at: 1_999_999_990,
      name: "  Blast\u0000 Pilot  ",
      profile_picture_url: "https://images.example.test/blast-pilot.png",
      provider_private_field: "must-never-escape",
      subject: SYNTHETIC_X_SUBJECT,
      type: "twitter_oauth",
      username: "blast_pilot",
      verified_at: 1_999_999_900,
    },
  ];
  if (options?.withWallet ?? true) {
    linkedAccounts.push({
      address: SYNTHETIC_SUI_ADDRESS,
      chain_id: "sui:mainnet",
      chain_type: "sui",
      connector_type: "embedded",
      id: "wallet-synthetic-existing",
      private_key: "must-never-escape",
      type: "wallet",
      wallet_client: "privy",
      wallet_client_type: "privy",
    });
  }
  return {
    custom_metadata: { providerSecret: "must-never-escape" },
    id: SYNTHETIC_PRIVY_DID,
    linked_accounts: linkedAccounts,
  };
}

export function syntheticCreatedSuiWallet() {
  return {
    address: SYNTHETIC_SUI_ADDRESS,
    chain_type: "sui",
    id: "wallet-synthetic-created",
    owner_id: "provider-owner-reference",
  };
}

export function createSyntheticPrivyGateway(
  mode: SyntheticPrivyFixtureMode,
  options?: Readonly<{ withWallet?: boolean }>,
): PrivyProviderGateway {
  const claims = syntheticPrivyClaims();
  return {
    async verifyAccessToken(accessToken) {
      if (mode === "malformed-token" || accessToken !== "synthetic-access-token") {
        throw new PrivyAdapterError("INVALID_ACCESS_TOKEN");
      }
      if (mode === "expired") {
        return { ...claims, expiration: claims.issuedAt - 1 };
      }
      return claims;
    },
    async getUser() {
      if (mode === "provider-timeout") {
        throw new PrivyAdapterError("PROVIDER_TIMEOUT");
      }
      return syntheticPrivyUser(options);
    },
    async createEmbeddedSuiWallet() {
      if (mode === "provider-timeout") {
        throw new PrivyAdapterError("PROVIDER_TIMEOUT");
      }
      return syntheticCreatedSuiWallet();
    },
  };
}

export const SYNTHETIC_GOOGLE_PRIVY_DID = "did:privy:synthetic-google-only";
export const SYNTHETIC_GOOGLE_SUI_ADDRESS = `0x${"5a".repeat(32)}`;

/**
 * A Privy user who signed in with Google only: no X account. `wallet` adds the
 * embedded Sui wallet; an external Sui wallet and an embedded EVM wallet are
 * always present and are never the embedded Sui wallet.
 */
export function syntheticGoogleOnlyUser(options?: Readonly<{ wallet?: boolean }>) {
  const linkedAccounts: Record<string, unknown>[] = [
    { type: "google_oauth", subject: "google-subject-77", email: "pilot@example.test", verified_at: 1_999_999_900 },
    {
      address: `0x${"6b".repeat(32)}`,
      chain_type: "sui",
      connector_type: "injected",
      id: "wallet-external",
      type: "wallet",
      wallet_client_type: "slush",
    },
    {
      address: `0x${"7c".repeat(20)}`,
      chain_type: "ethereum",
      connector_type: "embedded",
      id: "wallet-evm",
      type: "wallet",
      wallet_client_type: "privy",
    },
  ];
  if (options?.wallet ?? true) {
    linkedAccounts.push({
      address: SYNTHETIC_GOOGLE_SUI_ADDRESS,
      chain_type: "sui",
      connector_type: "embedded",
      id: "wallet-google-embedded",
      private_key: "must-never-escape",
      type: "wallet",
      wallet_client_type: "privy",
    });
  }
  return { id: SYNTHETIC_GOOGLE_PRIVY_DID, linked_accounts: linkedAccounts };
}
