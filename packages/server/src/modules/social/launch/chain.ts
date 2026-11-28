import { launchpadDeployment, type BlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import { LaunchpadTransactions } from "@interest-protocol/blast-sdk/launchpad";
import { Inputs, Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";

import type { LaunchPublishCoin, LaunchPublishStepKind } from "@blast/core/modules/social/contracts/launch.ts";
import { firstBuyMemeOut, launchArguments, type LaunchDraft, type LaunchRules } from "@blast/core/modules/social/launch/model.ts";
import { registerCurrencyTransaction } from "@blast/server/modules/social/create/chain.ts";
import type { MemeTemplate } from "@blast/server/modules/social/launch/meme-template.ts";

/**
 * The launch's three transactions, built from the stored draft on the
 * server. Nothing here signs or sends.
 *
 * 1. `publish_coin`: the coin's own package from the launchpad's template,
 *    its `UpgradeCap` made immutable. Its initializer mints the 1B supply
 *    into a `LaunchTicket` for the creator and sends the `Currency` to the
 *    Coin Registry.
 * 2. `register_currency`: `coin_registry::finalize_registration`, sharing
 *    the `Currency` (the publish's effects name its `Receiving` reference).
 * 3. `create_launch`: the venue adapter's `new`, every setter, `finalize`,
 *    the creator's first buy on the still-owned launch, and `share`, in one
 *    PTB through the SDK. Before `share` no one else can trade, so the first
 *    buy's output is exact and its minimum is that output.
 */

/** The coin package's dependencies, in the order `LaunchpadTransactions.publishMeme` lists them. */
export function memeDependencies(deployment: BlastDeployment): string[] {
  const launchpad = launchpadDeployment(deployment);
  return [
    "0x0000000000000000000000000000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000000000000000000000000000002",
    launchpad.admin.packageId,
    launchpad.partners.packageId,
    launchpad.vestingPackageId,
    launchpad.core.packageId,
    launchpad.packageId,
  ];
}

export type LaunchStepInput = Readonly<{
  step: LaunchPublishStepKind;
  deployment: BlastDeployment;
  draft: LaunchDraft;
  rules: LaunchRules;
  logoUrl: string;
  creator: string;
  accountCommitment: string | null;
  template: MemeTemplate;
  coin: LaunchPublishCoin | null;
  /** A Blast wallet's step is sponsored: its SUI comes from the account's own coins, never the gas coin. */
  sponsored: boolean;
}>;

export async function launchStepTransaction(input: LaunchStepInput): Promise<Transaction> {
  const { deployment, draft, rules } = input;
  if (input.step === "publish_coin") {
    if (input.accountCommitment === null) throw new Error("Publication needs a creator commitment.");
    const launchpad = launchpadDeployment(deployment);
    const module = await input.template.bytecode({
      decimals: draft.decimals,
      symbol: draft.symbol,
      name: draft.name.trim(),
      description: draft.description.trim(),
      iconUrl: input.logoUrl,
      burnable: draft.burnable,
      sellBurnBps: String(draft.sell_burn_bps),
      accountCommitment: input.accountCommitment,
      launchpadOriginalPackageId: launchpad.originalPackageId,
      coreOriginalPackageId: launchpad.core.originalPackageId,
    });
    const tx = new Transaction();
    const [upgradeCap] = tx.publish({ modules: [module], dependencies: memeDependencies(deployment) });
    tx.moveCall({ target: "0x2::package::make_immutable", arguments: [upgradeCap!] });
    tx.setSenderIfNotSet(input.creator);
    return tx;
  }
  const coin = input.coin;
  if (!coin) throw new Error("The step needs the published coin");
  if (input.step === "register_currency") {
    const currency = coin.currency;
    if (!("version" in currency)) throw new Error("Registration needs the currency's receiving reference");
    const tx = registerCurrencyTransaction({ coinType: coin.coin_type, currency: { objectId: currency.object_id, version: currency.version, digest: currency.digest } });
    tx.setSenderIfNotSet(input.creator);
    return tx;
  }
  const currency = coin.currency;
  if (!coin.ticket || !coin.sealed_treasury_cap || !("initial_shared_version" in currency)) throw new Error("Creation needs the ticket and the shared currency");
  const args = launchArguments(draft, rules);
  const builder = new LaunchpadTransactions(launchpadDeployment(deployment), { useGasCoin: !input.sponsored });
  const memeOut = firstBuyMemeOut(draft, rules);
  const common = {
    memeType: normalizeStructTag(coin.coin_type),
    quoteType: normalizeStructTag(draft.quote_type),
    virtualQuote: args.virtualQuote,
    graduationTarget: args.graduationTarget,
    allocationPlan: { ...args.allocationPlan, recipients: [...args.allocationPlan.recipients] },
    lpFeeSplit: args.lpFeeSplit,
    ticket: Inputs.ObjectRef({ objectId: coin.ticket.object_id, version: coin.ticket.version, digest: coin.ticket.digest }),
    sealedTreasuryCap: Inputs.ObjectRef({
      objectId: coin.sealed_treasury_cap.object_id,
      version: coin.sealed_treasury_cap.version,
      digest: coin.sealed_treasury_cap.digest,
    }),
    currency: { objectId: currency.object_id, initialSharedVersion: currency.initial_shared_version },
    creationFee: BigInt(rules.creation_fee),
    ...(args.firstBuy > 0n ? { preShareBuy: { quoteAmount: args.firstBuy, minMemeOut: memeOut, recipient: input.creator } } : {}),
  };
  const shared = deployment.sharedObjects;
  const tx = draft.venue === "cetus"
    ? builder.createLaunch({
      ...common,
      venue: "cetus",
      cetus: { config: shared.cetus!.config, pools: shared.cetus!.pools },
      tier: { tickSpacing: args.tickSpacing },
    })
    : builder.createLaunch({ ...common, venue: "bluefin", tier: { tickSpacing: args.tickSpacing, feeRate: args.feeRate } });
  tx.setSenderIfNotSet(input.creator);
  return tx;
}
