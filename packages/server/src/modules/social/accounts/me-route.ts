import { SOCIAL_ME_ROUTE, type SocialAccountWallet, type SocialMeAccount, type SocialMeResponse } from "@blast/core/modules/social/contracts/me.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";

/** Lists an account's wallets (`social_wallet_owners`), on the primary. */
export interface SocialAccountWalletLister {
  wallets(accountId: string): Promise<SocialAccountWallet[]>;
  walletsForAccounts?(accountIds: readonly string[]): Promise<ReadonlyMap<string, readonly SocialAccountWallet[]>>;
}

/** Reads the verified caller's account and wallets from one account snapshot. */
export interface SocialMeAccountReader {
  resolveWithWallets(did: string): Promise<SocialMeAccount | null>;
  resolveWalletWithWallets(address: string, sessionId?: string): Promise<SocialMeAccount | null>;
}

/**
 * `GET /api/social/me`: the signed-in caller's Blast Account with its
 * wallets, or `account: null`. A member's first call creates its account row
 * (through the compound account reader). The account-scoped `social_me_read`
 * guard applies; every answer is `Cache-Control: private, no-store`.
 */
export function createSocialMeRoute(dependencies: Readonly<{ kit: SocialRouteKit; accounts: SocialMeAccountReader }>) {
  const { kit, accounts } = dependencies;
  return Object.freeze({
    GET: kit.route(
      { name: SOCIAL_ME_ROUTE, auth: "account", bucket: "social_me_read", cache: "private" },
      async (context) => {
        const body: SocialMeResponse = {
          account: context.caller?.kind === "privy"
            ? await accounts.resolveWithWallets(context.caller.did)
            : context.caller?.kind === "wallet"
              ? await accounts.resolveWalletWithWallets(context.caller.address, context.caller.sessionId)
              : null,
        };
        return context.json(body);
      },
    ),
  });
}
