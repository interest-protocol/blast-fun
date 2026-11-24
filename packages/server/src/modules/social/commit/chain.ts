import { mainnetIdentity } from "@blast/core/modules/presale/deployment/mainnet-identity.ts";
import { decodePresaleObject, PresaleTransactions, type AllowlistProof } from "@interest-protocol/blast-sdk/presale";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { PresaleDeploymentState, PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import type { ClaimPresale } from "@blast/server/modules/social/claims/chain.ts";
import { commitAvailabilityOf, commitBlockers, type CommitAvailability } from "@blast/core/modules/social/contracts/commit.ts";

/**
 * The commit's view of the chain: whether blasting is on, and the commit
 * transaction. Mainnet only — a deployment on any other network is treated
 * as not deployed, exactly as `create/chain.ts` treats publishing. Nothing
 * here signs or sends.
 *
 * **Server only in practice.** The deployment identity comes from the
 * server's `PRESALE_DEPLOYMENT_MANIFEST`, which no browser bundle carries, so
 * the commit is built by `POST /api/social/me/commits` (`commit/route.ts`)
 * and the browser only signs it. Client code imports nothing from here; the
 * panel's `toAtoms` lives in `quote.ts` (re-exported below for the server).
 */

export { toAtoms } from "@blast/core/modules/social/commit/quote.ts";

export {
  commitAvailabilityOf,
  commitBlockers,
  commitOffLine,
  type CommitAvailability,
} from "@blast/core/modules/social/contracts/commit.ts";

/** The mainnet identity, or null: no manifest, a bad one, or another network. */


/**
 * Why blasting is off now, in a fixed order. The same shape and the same
 * discipline as Create's `publishAvailability`: every reason is published,
 * safe to show and safe to log, and an empty list is the only thing that lets
 * a transaction be built.
 *
 * `PRESALE_DEPLOYMENT_MANIFEST` is not set on any machine yet, so today this
 * always answers `presale_not_deployed` and the dialog never builds anything.
 */
export function commitAvailability(input: Readonly<{
  state: PresaleDeploymentState;
  /** The viewer's Blast wallet, or null while it does not exist yet. */
  wallet: string | null;
  /** An allowlisted sale whose allowlist could not be read at all (not merely "not on it"). */
  allowlistUnreadable?: boolean;
  /** The coin the person chose to pay with, and the coin the sale raises in. */
  payWith?: string;
  quoteCoin?: string;
}>): CommitAvailability {
  const { state, ...rest } = input;
  return commitAvailabilityOf(commitBlockers({ ...rest, deployed: mainnetIdentity(state) !== null }));
}

/** Route the payment by the shared sale object's policy and public window. */
export function commitRoute(sale: Readonly<{ allowlisted: boolean; publicFromMs?: bigint | null; endMs?: bigint }>, nowMs = BigInt(Date.now())) {
  if (sale.publicFromMs != null && sale.endMs !== undefined && sale.publicFromMs <= nowMs && nowMs < sale.endMs) return "uncapped";
  return sale.allowlisted ? "allowlisted" : "open";
}

export type CommitTransactionInput = Readonly<{
  identity: PresaleRuntimeIdentity;
  /** The sale's object, with the shared version the fullnode reports for it. */
  presale: Readonly<{ objectId: string; initialSharedVersion: string | number }>;
  /** `0x…::module::WITNESS` of the sale token and of the quote coin. */
  saleToken: string;
  quoteType: string;
  /** The commitment, in quote-coin atoms. */
  atoms: bigint;
  /** Where the change (and the sale tokens, later) go: the viewer's own wallet. */
  recipient: string;
  /** The wallet's allowlist leaf, for an allowlisted sale. */
  allowlist?: AllowlistProof | null;
  uncapped?: boolean;
}>;

/**
 * The commit: `PresaleTransactions.commit`, which takes the quote coin from
 * the sender's own coins, calls the route's entry and sends the change back.
 * The SDK builds the whole PTB, so nothing about the call shape lives here.
 *
 * **A commit never uses the gas coin (R3-41).** Every commit is sponsored, so
 * the gas coin is Blast's, and the presale sponsor's policy refuses any kind
 * that uses it (`refuseSponsorSpend`: "uses the gas coin"), rightly: such a
 * kind would spend the sponsor's SUI. So the commit passes the SDK's
 * `useGasCoin: false` (`CoinSourceOptions`): a SUI quote comes from the
 * wallet's own SUI coins and address balance. USDC never touches the gas coin.
 *
 * The sender is **not** set: the commit is built as a transaction kind (the
 * sponsor fills in the sender and the gas).
 */
export function commitTransaction(input: CommitTransactionInput): Transaction {
  const sdk = new PresaleTransactions(input.identity.presale);
  const common = {
    saleTokenType: normalizeStructTag(input.saleToken),
    quoteType: normalizeStructTag(input.quoteType),
    presale: { objectId: input.presale.objectId, initialSharedVersion: input.presale.initialSharedVersion, mutable: true as const },
    amount: input.atoms,
    recipient: input.recipient,
    useGasCoin: false,
  };
  if (input.uncapped) return sdk.commit({ ...common, route: "uncapped" });
  if (input.allowlist) return sdk.commit({ ...common, route: "allowlisted", allowlist: input.allowlist });
  return sdk.commit({ ...common, route: "open" });
}

/** The sale's shared object and its type arguments as the chain holds them: the claim's reader, this deployment's `Presale` only. */
export type CommitPresale = ClaimPresale & Readonly<{ allowlisted: boolean; publicFromMs: bigint | null; endMs: bigint }>;

/**
 * What the commit route reads from the deployment's node. A node failure
 * rejects (the route answers `service_unavailable`).
 */
export type CommitChain = Readonly<{
  /** The sale's object, or null when `presaleId` is not a presale of this deployment. */
  presale(presaleId: string, options?: { signal?: AbortSignal }): Promise<CommitPresale | null>;
  /** What `owner` holds of `coinType`, in atoms: its coins and its address balance. */
  balance(owner: string, coinType: string, options?: { signal?: AbortSignal }): Promise<bigint>;
  /**
   * `transaction` as a transaction kind from `sender`: the sender's own coins
   * resolved on the node, no gas (the sponsor adds it).
   */
  kind(transaction: Transaction, sender: string): Promise<Uint8Array>;
}>;

/**
 * The commit's chain reads over a Core API client (the presale node): the
 * sale's object through the claim's reader (it refuses an object that is not
 * this deployment's `Presale`), the wallet's balance, and the build of the
 * commit kind — exactly the build the browser used to run
 * (`transaction.setSender(wallet)`, then `build({ client, onlyTransactionKind:
 * true })`), now on the server, which holds the deployment.
 */
export function createCommitChain(input: Readonly<{ client: ClientWithCoreApi; identity: PresaleRuntimeIdentity }>): CommitChain {
  const { client } = input;
  return Object.freeze({
    async presale(presaleId, options = {}) {
      const { objects } = await client.core.getObjects({ objectIds: [presaleId], include: { content: true }, signal: options.signal });
      const object = objects[0];
      const original = normalizeSuiAddress(input.identity.presale.originalPackageId);
      if (!object || object instanceof Error || object.owner.$kind !== "Shared" ||
          !object.type.startsWith(original + "::blast_presale::Presale<")) return null;
      const initialSharedVersion = String(object.owner.Shared.initialSharedVersion);
      const state = decodePresaleObject({ ...object, initialSharedVersion }, original);
      return {
        objectId: state.objectId, initialSharedVersion, saleToken: state.saleTokenType, quote: state.quoteType,
        allowlisted: state.eligibility.kind === "allowlisted", endMs: state.endMs,
        publicFromMs: state.lifecycle === "Open" && state.uncapped?.access.kind === "anyone" ? state.uncappedFromMs : null,
      };
    },
    async balance(owner, coinType, options = {}) {
      const { balance } = await client.core.getBalance({
        owner: normalizeSuiAddress(owner),
        coinType: normalizeStructTag(coinType),
        signal: options.signal,
      });
      return BigInt(balance.balance);
    },
    async kind(transaction, sender) {
      transaction.setSender(normalizeSuiAddress(sender));
      return transaction.build({ client, onlyTransactionKind: true });
    },
  });
}
