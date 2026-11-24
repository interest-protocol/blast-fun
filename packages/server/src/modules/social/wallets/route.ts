import { holders, linkProvenWallet } from "./store.ts";
import { recordMetric, timed } from "@blast/core/lib/metrics.ts";
import type { WalletRateSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import {
  canonicalSuiAddress,
  WalletChallengeError,
  type IssueWalletChallengeRequest,
  type IssuedWalletChallenge,
  type VerifyWalletChallengeRequest,
  type WalletControlProof,
} from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import {
  SOCIAL_WALLET_CHALLENGE_ROUTE,
  SOCIAL_WALLET_LINK_ROUTE,
  socialWalletChallengeRequestSchema,
  socialWalletLinkRequestSchema,
  type SocialWalletChallenge,
  type SocialWalletLinked,
} from "@blast/core/modules/social/contracts/wallets.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialJsonWithSchema, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";

/** Mission Control's wallet-challenge service (`WalletChallengeService`), as the link routes use it. */
export interface SocialWalletChallenges {
  issue(request: IssueWalletChallengeRequest, subject: WalletRateSubject): Promise<IssuedWalletChallenge>;
  verify(request: VerifyWalletChallengeRequest, subject: WalletRateSubject): Promise<WalletControlProof>;
}

export type SocialWalletRoutesDependencies = Readonly<{
  kit: SocialRouteKit;
  /** Resolved per request, so a missing setting fails that request only (`service_unavailable`). */
  challenges: () => SocialWalletChallenges;
  /** The site origin: a challenge binds it, and only this site's challenges link. */
  origin: string;
}>;

function addressOf(address: string): string {
  try {
    return canonicalSuiAddress(address);
  } catch {
    throw new SocialRouteError("invalid_request");
  }
}

/** A challenge-service refusal as a published social code. */
function fromChallengeError(error: unknown): never {
  if (error instanceof WalletChallengeError) {
    switch (error.code) {
      case "WALLET_PROOF_INVALID":
        throw new SocialRouteError("invalid_signature");
      case "WALLET_CHALLENGE_RATE_LIMITED":
        throw new SocialRouteError("rate_limited", { retryAfterSeconds: error.retryAfterSeconds });
      case "WALLET_CHALLENGE_REQUEST_INVALID":
        throw new SocialRouteError("invalid_request");
      case "WALLET_PROOF_UNAVAILABLE":
        throw new SocialRouteError("service_unavailable", { retryAfterSeconds: error.retryAfterSeconds });
    }
  }
  throw error;
}

/**
 * `POST /api/social/me/wallets/challenge` and `POST /api/social/me/wallets`
 * (T-017; contract in `contracts/wallets.ts`). Both: account required, bucket
 * `social_wallet_link`, `private, no-store`. The challenge service also
 * applies Mission Control's per-IP-and-address `wallet` limit. Every read
 * and the write run on the primary in the kit's transactions.
 *
 * Linking order: closed body, ownership (`wallet_taken` before the
 * signature is checked), the signature (which consumes the challenge, so a
 * signature never links twice), then one transaction that inserts the proven
 * wallet and re-checks every source, so a concurrent link of the same
 * address by another account is `wallet_taken` and writes nothing.
 */
export function createSocialWalletRoutes(dependencies: SocialWalletRoutesDependencies) {
  const { kit, challenges, origin } = dependencies;
  const spec = (name: string) =>
    ({ name, auth: "account", account: "required", bucket: "social_wallet_link", cache: "private" }) as const;
  const contextFor = (accountId: string) => ({ kind: "account" as const, id: `social:${accountId}` });

  return Object.freeze({
    challenge: Object.freeze({
      POST: kit.route(spec(SOCIAL_WALLET_CHALLENGE_ROUTE), async (context) => {
        const body = await readSocialJsonWithSchema(context.request, socialWalletChallengeRequestSchema);
        const address = addressOf(body.address);
        const accountId = context.account!.account_id;
        const owners = await context.transaction((social) => holders(social, address, accountId), {
          label: "social.wallet_holders",
        });
        if (owners.taken) {
          recordMetric("social.wallet_link", { step: "challenge", outcome: "taken" });
          throw new SocialRouteError("wallet_taken");
        }
        let issued: IssuedWalletChallenge;
        try {
          issued = await challenges().issue(
            { action: "link_wallet", address, origin, context: contextFor(accountId) },
            { ip: context.client.rateKey, address },
          );
        } catch (error) {
          fromChallengeError(error);
        }
        recordMetric("social.wallet_link", { step: "challenge", outcome: "issued" });
        const answer: SocialWalletChallenge = {
          challenge_id: issued.challengeId,
          address: issued.address,
          message: issued.message,
          expires_at_ms: Date.parse(issued.expiresAt),
        };
        return context.json(answer, 201);
      }),
    }),
    link: Object.freeze({
      POST: kit.route(spec(SOCIAL_WALLET_LINK_ROUTE), async (context) => {
        const body = await readSocialJsonWithSchema(context.request, socialWalletLinkRequestSchema);
        const { challenge_id: challengeId, message, signature, wallet: kind = "external" } = body;
        const address = addressOf(body.address);
        const accountId = context.account!.account_id;

        return timed("social.wallet_link", async () => {
          const before = await context.transaction((social) => holders(social, address, accountId), {
            label: "social.wallet_holders",
          });
          if (before.taken) throw new SocialRouteError("wallet_taken");
          try {
            await challenges().verify(
              { action: "link_wallet", address, origin, context: contextFor(accountId), challengeId, message, signature },
              { ip: context.client.rateKey, address },
            );
          } catch (error) {
            fromChallengeError(error);
          }
          const linked = await context.transaction(
            async (social) => {
              return linkProvenWallet(social, address, accountId, kind, before.held);
            },
            { label: "social.wallet_link" },
          );
          const answer: SocialWalletLinked = { wallet: linked.wallet };
          return context.json(answer, linked.created ? 201 : 200);
        }, { step: "link" });
      }),
    }),
  });
}
