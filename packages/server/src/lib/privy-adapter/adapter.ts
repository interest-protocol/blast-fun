import { z } from "zod";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import {
  PrivyAdapterError,
  toSafePrivyAdapterError,
} from "@blast/core/lib/privy-adapter/errors.ts";
import {
  PRIVY_TOKEN_ISSUER,
  type EmbeddedSuiWallet,
  type PrivyAccessClaims,
  type PrivyContractProbeResult,
  type PrivyOnboardingAdapter,
  type PrivyProviderGateway,
  type PrivySession,
  type PrivySessionVerifier,
  type VerifiedXIdentity,
} from "@blast/core/lib/privy-adapter/types.ts";

type JsonRecord = Record<string, unknown>;

export type PrivyOnboardingAdapterOptions = Readonly<{
  appId: string;
  gateway: PrivyProviderGateway;
  now?: () => number;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return z.record(z.string(), z.unknown()).safeParse(value).success;
}

function nonEmptyString(value: unknown): string | null {
  return z.string().min(1).safeParse(value).data ?? null;
}

function safeText(value: unknown, maxLength: number): string | null {
  if (!z.string().safeParse(value).success) return null;
  const text = (value as string)
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return null;
  return [...text].slice(0, maxLength).join("");
}

function safeHandle(value: unknown): string | null {
  const handle = safeText(value, 16)?.replace(/^@/, "") ?? null;
  return (
    z
      .string()
      .regex(/^[A-Za-z0-9_]{1,15}$/)
      .safeParse(handle).data ?? null
  );
}

function safeAvatarReference(value: unknown): string | null {
  const parsed = z.string().max(2_048).safeParse(value);
  if (!parsed.success) return null;
  try {
    const url = new URL(parsed.data);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function callsignSuggestion(handle: string | null, displayName: string | null): string | null {
  const source = handle ?? displayName;
  if (!source) return null;
  const callsign = source
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 15)
    .toUpperCase();
  return callsign || null;
}

function assertClaims(
  claims: PrivyAccessClaims,
  appId: string,
  issuer: string,
  now: () => number,
): void {
  const access = z
    .object({
      appId: z.literal(appId),
      issuer: z.literal(issuer),
      userId: z.string().startsWith("did:privy:"),
      sessionId: z.string().min(1),
      issuedAt: z
        .number()
        .int()
        .max(now() + 5),
    })
    .safeParse(claims);
  if (!access.success) throw new PrivyAdapterError("INVALID_ACCESS_TOKEN");
  if (!z.number().int().gt(now()).safeParse(claims.expiration).success) {
    throw new PrivyAdapterError("ACCESS_TOKEN_EXPIRED");
  }
}

function readUser(value: unknown, expectedPrivyDid: string): JsonRecord {
  const parsed = z
    .looseObject({ id: z.literal(expectedPrivyDid), linked_accounts: z.array(z.unknown()) })
    .safeParse(value);
  if (!parsed.success) {
    throw new PrivyAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  return parsed.data;
}

function findXIdentity(user: JsonRecord, claims: PrivyAccessClaims): VerifiedXIdentity {
  const accounts = user.linked_accounts as unknown[];
  const account = accounts.find(
    (candidate): candidate is JsonRecord =>
      isRecord(candidate) && candidate.type === "twitter_oauth",
  );

  if (!account) {
    throw new PrivyAdapterError("IDENTITY_NOT_FOUND");
  }

  const xSubject = nonEmptyString(account.subject);
  const verifiedAt = account.verified_at;
  if (!xSubject || !z.number().int().nonnegative().safeParse(verifiedAt).success) {
    throw new PrivyAdapterError("PROVIDER_RESPONSE_INVALID");
  }

  const displayNameSuggestion = safeText(account.name, 50);
  const handle = safeHandle(account.username);

  return {
    authProvider: "privy",
    avatarReference: safeAvatarReference(account.profile_picture_url),
    callsignSuggestion: callsignSuggestion(handle, displayNameSuggestion),
    displayNameSuggestion,
    handle,
    privyDid: claims.userId,
    proofReference: claims.sessionId,
    socialProvider: "x",
    verifiedAtEpochSeconds: verifiedAt as number,
    xSubject,
  };
}

function canonicalSuiAddress(value: unknown): string | null {
  const parsed = z.string().max(66).safeParse(value);
  if (!parsed.success) return null;
  const address = normalizeSuiAddress(parsed.data);
  if (!isValidSuiAddress(address) || /^0x0{64}$/.test(address)) return null;
  return address;
}

function existingSuiWallet(user: JsonRecord, privyDid: string): EmbeddedSuiWallet | null {
  const accounts = user.linked_accounts as unknown[];
  const account = accounts.find(
    (candidate): candidate is JsonRecord =>
      isRecord(candidate) &&
      candidate.type === "wallet" &&
      candidate.chain_type === "sui" &&
      candidate.wallet_client_type === "privy" &&
      candidate.connector_type === "embedded",
  );
  if (!account) return null;

  const address = canonicalSuiAddress(account.address);
  const reference = nonEmptyString(account.id);
  if (!address || !reference) {
    throw new PrivyAdapterError("PROVIDER_RESPONSE_INVALID");
  }

  return {
    address,
    chain: "sui",
    created: false,
    custodyProvider: "privy",
    privyDid,
    providerWalletReference: reference,
  };
}

function createdSuiWallet(value: unknown, privyDid: string): EmbeddedSuiWallet {
  const parsed = z
    .object({ chain_type: z.literal("sui"), address: z.unknown(), id: z.unknown() })
    .safeParse(value);
  if (!parsed.success) {
    throw new PrivyAdapterError("WALLET_RESOLUTION_FAILED");
  }
  const address = canonicalSuiAddress(parsed.data.address);
  const reference = nonEmptyString(parsed.data.id);
  if (!address || !reference) {
    throw new PrivyAdapterError("WALLET_RESOLUTION_FAILED");
  }
  return {
    address,
    chain: "sui",
    created: true,
    custodyProvider: "privy",
    privyDid,
    providerWalletReference: reference,
  };
}

async function providerCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toSafePrivyAdapterError(error);
  }
}

export function createPrivyOnboardingAdapter(
  options: PrivyOnboardingAdapterOptions,
): PrivyOnboardingAdapter {
  const issuer = PRIVY_TOKEN_ISSUER;
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));

  if (!options.appId) {
    throw new PrivyAdapterError("INVALID_CONFIGURATION");
  }

  async function verifiedUser(accessToken: string) {
    if (!accessToken) {
      throw new PrivyAdapterError("INVALID_ACCESS_TOKEN");
    }
    const claims = await providerCall(() => options.gateway.verifyAccessToken(accessToken));
    assertClaims(claims, options.appId, issuer, now);
    const rawUser = await providerCall(() => options.gateway.getUser(claims.userId));
    const user = readUser(rawUser, claims.userId);
    return { claims, identity: findXIdentity(user, claims), user };
  }

  return {
    async verifyXIdentity(accessToken) {
      return (await verifiedUser(accessToken)).identity;
    },
    async verifyXIdentityAndGetExistingWallet(accessToken) {
      const { claims, identity, user } = await verifiedUser(accessToken);
      const wallet = existingSuiWallet(user, claims.userId);
      if (!wallet) throw new PrivyAdapterError("WALLET_RESOLUTION_FAILED");
      return { identity, wallet };
    },
    async verifyXIdentityAndResolveWallet(accessToken) {
      const { claims, identity, user } = await verifiedUser(accessToken);

      const existingWallet = existingSuiWallet(user, claims.userId);
      const wallet =
        existingWallet ??
        createdSuiWallet(
          await providerCall(() =>
            options.gateway.createEmbeddedSuiWallet({
              chainType: "sui",
              ownerPrivyDid: claims.userId,
            }),
          ),
          claims.userId,
        );

      return { identity, wallet };
    },
  };
}

/**
 * Verifies any Privy session, whatever login method made it, and returns only
 * the user's DID and embedded Sui wallet address (or null). No X identity is
 * required and no other provider field leaves the adapter.
 */
export function createPrivySessionVerifier(
  options: PrivyOnboardingAdapterOptions,
): PrivySessionVerifier {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  if (!options.appId) {
    throw new PrivyAdapterError("INVALID_CONFIGURATION");
  }
  return {
    async verifySession(accessToken): Promise<PrivySession> {
      if (!accessToken) {
        throw new PrivyAdapterError("INVALID_ACCESS_TOKEN");
      }
      const claims = await providerCall(() => options.gateway.verifyAccessToken(accessToken));
      assertClaims(claims, options.appId, PRIVY_TOKEN_ISSUER, now);
      const user = readUser(
        await providerCall(() => options.gateway.getUser(claims.userId)),
        claims.userId,
      );
      return {
        privyDid: claims.userId,
        suiWalletAddress: existingSuiWallet(user, claims.userId)?.address ?? null,
      };
    },
  };
}

/** DID → embedded Sui address. Entries never expire: Privy never moves an embedded wallet. */
export interface EmbeddedSuiWalletCache {
  get(privyDid: string): Promise<string | null>;
  put(privyDid: string, address: string): Promise<void>;
}

export type EmbeddedSuiWalletResolver = Readonly<{
  /**
   * The canonical address of the user's Privy embedded Sui wallet, or null
   * when the user has none. Any login method qualifies: no X account is
   * required. A cached DID never calls Privy; a miss reads
   * `GET /v1/users/{did}` and caches what it finds. It never creates a
   * wallet. A Privy failure on a miss throws a retryable PrivyAdapterError.
   */
  resolveEmbeddedSuiWallet(privyDid: string): Promise<string | null>;
}>;

export function createEmbeddedSuiWalletResolver(
  options: Readonly<{
    cache: EmbeddedSuiWalletCache;
    gateway: Pick<PrivyProviderGateway, "getUser">;
  }>,
): EmbeddedSuiWalletResolver {
  return Object.freeze({
    async resolveEmbeddedSuiWallet(privyDid: string) {
      if (
        !z
          .string()
          .regex(/^did:privy:[A-Za-z0-9_-]{1,128}$/)
          .safeParse(privyDid).success
      ) {
        throw new PrivyAdapterError("INVALID_ACCESS_TOKEN");
      }
      const cached = await options.cache.get(privyDid);
      if (cached) return cached;
      const user = readUser(await providerCall(() => options.gateway.getUser(privyDid)), privyDid);
      const wallet = existingSuiWallet(user, privyDid);
      if (!wallet) return null;
      await options.cache.put(privyDid, wallet.address);
      return wallet.address;
    },
  });
}

/**
 * The X account linked to a Privy user, as a new Blast Account stores it:
 * the subject, and the handle, name and avatar sanitized as onboarding
 * sanitizes them (an unusable value is null).
 */
export type LinkedXAccount = Readonly<{
  xSubject: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}>;

/**
 * Reads the Privy user (`getUser`, Privy's users API) and answers its linked
 * X account, or null when it has none (or one without a subject). A provider
 * failure or a response for another user throws a PrivyAdapterError.
 */
export async function findLinkedXAccount(
  gateway: Pick<PrivyProviderGateway, "getUser">,
  privyDid: string,
): Promise<LinkedXAccount | null> {
  const user = readUser(await providerCall(() => gateway.getUser(privyDid)), privyDid);
  const account = (user.linked_accounts as unknown[]).find(
    (candidate): candidate is JsonRecord =>
      isRecord(candidate) && candidate.type === "twitter_oauth",
  );
  const xSubject = account ? nonEmptyString(account.subject) : null;
  if (!account || !xSubject || xSubject.length > 512) return null;
  return {
    xSubject,
    handle: safeHandle(account.username),
    displayName: safeText(account.name, 50),
    avatarUrl: safeAvatarReference(account.profile_picture_url),
  };
}

export async function probePrivyProviderContract(
  gateway: PrivyProviderGateway,
  privyDid: string,
  timeoutMs = 3_000,
): Promise<PrivyContractProbeResult> {
  if (
    !privyDid.startsWith("did:privy:") ||
    !z.number().int().min(1).max(10_000).safeParse(timeoutMs).success
  ) {
    throw new PrivyAdapterError("INVALID_CONFIGURATION");
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const rawUser = await Promise.race([
      providerCall(() => gateway.getUser(privyDid)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new PrivyAdapterError("PROVIDER_TIMEOUT")), timeoutMs);
      }),
    ]);
    const user = readUser(rawUser, privyDid);
    const accounts = user.linked_accounts as unknown[];
    return {
      hasEmbeddedSuiWallet: accounts.some(
        (account) =>
          isRecord(account) &&
          account.type === "wallet" &&
          account.chain_type === "sui" &&
          account.wallet_client_type === "privy" &&
          account.connector_type === "embedded",
      ),
      hasVerifiedXIdentity: accounts.some(
        (account) =>
          isRecord(account) &&
          account.type === "twitter_oauth" &&
          nonEmptyString(account.subject) !== null,
      ),
      provider: "privy",
      reachable: true,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
