import { z } from "zod";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";

import { requestReferral, REFERRAL_COOKIE } from "@blast/core/modules/social/referrals/contracts.ts";
import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import { findLinkedXAccount, type LinkedXAccount } from "@blast/server/lib/privy-adapter/adapter.ts";
import type { PrivyProviderGateway } from "@blast/core/lib/privy-adapter/types.ts";
import {
  isSocialCallsign,
  socialCreateAccountRequestSchema,
  type SocialCreateAccountRequest,
  normalizeSocialCallsign,
  normalizeSocialDisplayName,
  SOCIAL_ACCOUNTS_ROUTE,
  SOCIAL_CALLSIGNS_PATH,
  SOCIAL_CALLSIGNS_ROUTE,
  type SocialCallsignAvailability,
  type SocialCreateAccountResponse,
} from "@blast/core/modules/social/contracts/accounts.ts";
import type { SocialAccountLoader } from "@blast/server/modules/social/route-kit/contracts.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialJsonWithSchema, type SocialRequestContext, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { completeOnboarding } from "@blast/server/modules/social/onboarding/repository.ts";
import { generateAccountIdentity } from "@blast/server/modules/social/accounts/generated-identity.ts";
import {
  blockedTerm,
  callsignRefusal,
  callsignUnavailableReason,
  derivedDisplayName,
  insertNewAccount,
  type BlockedTermFinder,
} from "@blast/server/modules/social/accounts/creation.ts";
import type { SocialAccountWalletLister } from "@blast/server/modules/social/accounts/me-route.ts";

/** A callsign path segment longer than this is a malformed parameter, not a callsign to check. */
const MAX_CALLSIGN_SEGMENT = 64;

export type SocialAccountCreationDependencies = Readonly<{
  kit: SocialRouteKit;
  /** Resolves the new account in the `me` shape and lists its wallets (on the primary). */
  accounts: SocialAccountLoader & SocialAccountWalletLister;
  /** Privy's users API (`privyGateway`). */
  privyUsers: Pick<PrivyProviderGateway, "getUser">;
  findBlockedTerm: BlockedTermFinder;
  createId?: () => string;
  generateIdentity?: typeof generateAccountIdentity;
}>;

/** `{callsign}` from `/api/social/callsigns/{callsign}`; an empty, undecodable or oversized segment is `invalid_parameter`. */
function callsignParameter(request: Request): string {
  const path = new URL(request.url).pathname;
  const segment = path.startsWith(`${SOCIAL_CALLSIGNS_PATH}/`) ? path.slice(SOCIAL_CALLSIGNS_PATH.length + 1) : "";
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    throw new SocialRouteError("invalid_parameter");
  }
  socialInput(z.string().min(1).refine((text) => !text.includes("/") && [...text].length <= MAX_CALLSIGN_SEGMENT), value, "invalid_parameter");
  return normalizeSocialCallsign(value);
}

async function requestedIdentity(body: SocialCreateAccountRequest, findBlockedTerm: BlockedTermFinder) {
  if (body.callsign === undefined) throw new SocialRouteError("invalid_request");
  const callsign = normalizeSocialCallsign(body.callsign);
  if (!isSocialCallsign(callsign)) throw callsignRefusal("invalid");
  const requestedName = body.display_name === undefined ? null : normalizeSocialDisplayName(body.display_name);
  if (body.display_name !== undefined && requestedName === null) throw new SocialRouteError("invalid_display_name");
  if ((await findBlockedTerm(callsign)) !== null) throw blockedTerm("callsign");
  if (requestedName !== null && (await findBlockedTerm(requestedName)) !== null) throw blockedTerm("display_name");
  return { callsign, requestedName };
}

/**
 * Blast Account creation (contracts in `contracts/accounts.ts`). An empty
 * body saves random defaults and completes onboarding in one transaction.
 *
 * - `create`: `POST /api/social/accounts`. Order: kit (origin, auth, bucket
 *   `social_account_create` per IP and per account, the caller's account),
 *   `account_exists`, the closed body, the callsign's format, the display
 *   name when sent, blocked terms in either, the caller's Privy user (outside
 *   any transaction; a failure creates the account without X fields), the
 *   derived display name when none was sent (X's name, else the callsign;
 *   OA-7; a wallet-only caller has no Privy user, so its callsign), then one
 *   READ COMMITTED transaction: `member_exists`, the callsign's holders, the
 *   insert (a Privy DID, or a wallet session's Sui address and that address
 *   as the account's `slush` wallet). The 201 is the new
 *   account in the `me` shape.
 * - `callsign`: `GET /api/social/callsigns/{callsign}`, signed in, bucket
 *   `social_read`: the same callsign checks in the same order.
 */
export function createSocialAccountCreationRoutes(dependencies: SocialAccountCreationDependencies) {
  const { kit, accounts, privyUsers, findBlockedTerm, createId } = dependencies;
  const generateIdentity = dependencies.generateIdentity ?? generateAccountIdentity;

  async function createGenerated(context: SocialRequestContext, x: LinkedXAccount | null): Promise<void> {
    const caller = context.caller!;
    const identity = caller.kind === "privy" ? { privyDid: caller.did } : { privyDid: null, suiAddress: caller.address };
    for (let attempt = 0; attempt < 8; attempt++) {
      const suggestion = generateIdentity();
      try {
        if ((await findBlockedTerm(suggestion.displayName)) !== null) continue;
        await context.transaction(async (social) => {
          const accountId = await insertNewAccount(social, { ...identity, ...suggestion, x, referralCallsign: requestReferral(context.request) }, { findBlockedTerm, createId });
          await completeOnboarding(social, accountId, false, { createId });
        }, { isolationLevel: "READ COMMITTED", label: "social.account_create" });
        return;
      } catch (error) {
        if (!(error instanceof SocialRouteError) || !["callsign_taken", "callsign_reserved", "blocked_term"].includes(error.code)) throw error;
      }
    }
    throw new Error("A generated callsign could not be allocated.");
  }

  /** The caller's linked X account; null without one, and null (counted) when Privy cannot be read. */
  async function linkedX(did: string): Promise<LinkedXAccount | null> {
    try {
      return await findLinkedXAccount(privyUsers, did);
    } catch (error) {
      recordMetric("social.privy_users", { route: SOCIAL_ACCOUNTS_ROUTE, outcome: "unavailable", cause: errorLabel(error) });
      return null;
    }
  }

  return Object.freeze({
    create: Object.freeze({
      POST: kit.route(
        { name: SOCIAL_ACCOUNTS_ROUTE, auth: "account", account: "resolve", bucket: "social_account_create", cache: "private" },
        async (context) => {
          if (context.account) throw new SocialRouteError("account_exists");
          const body = await readSocialJsonWithSchema(context.request, socialCreateAccountRequestSchema);
          const caller = context.caller!;
          if (Object.keys(body).length === 0) {
            const x = caller.kind === "privy" ? await linkedX(caller.did) : null;
            await createGenerated(context, x);
          } else {
            const { callsign, requestedName } = await requestedIdentity(body, findBlockedTerm);
            // A wallet-only caller has no Privy user, so no X name.
            const x = caller.kind === "privy" ? await linkedX(caller.did) : null;
            const displayName = requestedName ?? (await derivedDisplayName(callsign, x, findBlockedTerm));
            const identity = caller.kind === "privy" ? { privyDid: caller.did } : { privyDid: null, suiAddress: caller.address };
            await context.transaction(
              (social) => insertNewAccount(social, { ...identity, callsign, displayName, x, referralCallsign: requestReferral(context.request) }, { findBlockedTerm, createId }),
              { isolationLevel: "READ COMMITTED", label: "social.account_create" },
            );
          }
          const account = caller.kind === "privy" ? await accounts.resolve(caller.did) : await accounts.resolveWallet(caller.address);
          if (!account) throw new Error("The created account did not resolve.");
          const response: SocialCreateAccountResponse = {
            account: { ...account, wallets: await accounts.wallets(account.account_id) },
          };
          const result = context.json(response, 201);
          result.headers.append("Set-Cookie", `${REFERRAL_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
          return result;
        },
      ),
    }),
    callsign: Object.freeze({
      GET: kit.route(
        { name: SOCIAL_CALLSIGNS_ROUTE, auth: "account", account: "resolve", bucket: "social_read" },
        async (context) => {
          const callsign = callsignParameter(context.request);
          const reason = context.account?.callsign === callsign ? null : await context.transaction(
            (social) => callsignUnavailableReason(social, callsign, findBlockedTerm, context.account?.account_id),
            { label: "social.callsign_availability" },
          );
          const body: SocialCallsignAvailability = reason === null ? { available: true, reason: null } : { available: false, reason };
          return context.json(body);
        },
      ),
    }),
  });
}
