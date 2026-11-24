import type { AccountWalletsResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import type { PresaleEmbeddedWallets } from "@blast/server/modules/presale/embedded-wallets/service.ts";
import type { PresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";

export type LinkedWallet = AccountWalletsResponse["wallets"][number];

/** The verified Sui wallets of the Blast Account linked to a Privy DID, primary first; none without a profile. */
export interface LinkedWalletStore {
  list(did: string): Promise<LinkedWallet[]>;
}

/**
 * The Blast Account's linked wallets, then the Privy embedded wallet when it
 * is not one of them. The embedded wallet is primary only when it is the
 * caller's only wallet (no profile, or a profile without wallets).
 */
export function accountWallets(embedded: string | null, linked: readonly LinkedWallet[]): LinkedWallet[] {
  const wallets = new Map(linked.map((wallet) => [wallet.address, wallet]));
  if (embedded && !wallets.has(embedded)) {
    wallets.set(embedded, { address: embedded, kind: "embedded", primary: wallets.size === 0 });
  }
  return [...wallets.values()];
}

/** `GET /api/account/wallets` (contract 3.7) for signed-in accounts. */
export function createAccountWalletsRoutes(dependencies: Readonly<{
  kit: PresaleRouteKit;
  store: LinkedWalletStore;
  embeddedWallets: Pick<PresaleEmbeddedWallets, "find">;
}>) {
  const { kit, store, embeddedWallets } = dependencies;
  return Object.freeze({
    GET: kit.route(
      { name: "GET /api/account/wallets", auth: "account", bucket: "presale_account_wallets" },
      async (context) => {
        // `auth: "account"` admits no request without one.
        const did = context.account!.did;
        const [embedded, linked] = await Promise.all([embeddedWallets.find(did), store.list(did)]);
        const body: AccountWalletsResponse = { wallets: accountWallets(embedded, linked) };
        return context.json(body);
      },
    ),
  });
}
