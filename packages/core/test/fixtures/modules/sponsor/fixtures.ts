/**
 * Test-only fixtures for the sponsor target policy (T-015). Transaction kinds
 * come from the Blast SDK builders and from the Cetus aggregator SDK in its
 * sponsored mode, built offline: an in-memory client serves the coins and
 * objects, and Cetus's router API is answered from a fixture response. Nothing
 * here reaches a chain or the Cetus API. Runtime code must not import this
 * file: it uses the dev dependency `@cetusprotocol/aggregator-sdk`.
 */
import { SUI_COIN_TYPE as SUI } from "@blast/core/lib/sui/coin-types.ts";
import { AggregatorClient, PACKAGE_NAMES } from "@cetusprotocol/aggregator-sdk";
import { defineBlastDeployment, presaleDeployment } from "@interest-protocol/blast-sdk/deployments";
import { VaultTransactions } from "@interest-protocol/blast-sdk/vault";
import { NON_PRODUCTION_MANIFEST } from "../launchpad-coin/manifest-fixtures.ts";
import type { RewardProof } from "@interest-protocol/blast-sdk/holder-rewards";
import { PresaleTransactions } from "@interest-protocol/blast-sdk/presale";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction, type TransactionArgument, type TransactionObjectArgument } from "@mysten/sui/transactions";
import { fromHex, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { SponsorTransactionKind } from "../../../../src/modules/sponsor/policy.ts";

const id = (byte: string): string => `0x${byte.repeat(32)}`;
const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

export const SENDER = id("a1");
export const OTHER_WALLET = id("e9");
export const PRESALE_PACKAGE = id("50");
export const PRESALE_ID = id("51");
export const OTHER_PRESALE_ID = id("52");
export const VAULT_ID = id("53");
export const OTHER_VAULT_ID = id("54");
export const ROUND_ID = id("55");
export const OTHER_SALE_ROUND_ID = id("56");
export const SALE_TOKEN = normalizeStructTag(`${id("5a")}::meme::MEME`);
export const QUOTE = normalizeStructTag(
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
);
export { SUI_COIN_TYPE as SUI } from "@blast/core/lib/sui/coin-types.ts";
/** The aggregator package Cetus's router API names in `packages.aggregator_v3`. */
export const CETUS_AGGREGATOR_PACKAGE = id("c0");
/** The DEX adapter package (`published_at`) of the fixture route's path. */
export const CETUS_ADAPTER_PACKAGE = id("c1");
/** The pool (path id) of the fixture route unless a build names another. */
export const CETUS_POOL = id("b0");
/** Route pools the derivation varies, so a route-chosen pool is never pinned. */
export const CETUS_DERIVATION_POOLS = [id("b1"), id("b2")];
/** `PRESALE_SPONSOR_SWAP_TARGETS` for the fixture routes through CETUS and DEEPBOOKV3. */
export const CETUS_SWAP_TARGETS = [
  `${CETUS_AGGREGATOR_PACKAGE}::router`,
  `${CETUS_ADAPTER_PACKAGE}::cetus`,
  `${CETUS_ADAPTER_PACKAGE}::deepbookv3`,
].join(",");

const DEPLOYMENT = {
  ...presaleDeployment(defineBlastDeployment(NON_PRODUCTION_MANIFEST)),
  packageId: PRESALE_PACKAGE,
  originalPackageId: PRESALE_PACKAGE,
};
export const presale = new PresaleTransactions(DEPLOYMENT);
export const VAULT_PACKAGE = DEPLOYMENT.vault.packageId;

const TYPES = { saleTokenType: SALE_TOKEN, quoteType: QUOTE };
const presaleObject = (presaleId = PRESALE_ID) =>
  ({ objectId: presaleId, initialSharedVersion: 7, mutable: true }) as const;

/**
 * Where the sender's coins of a type come from. Sui's coin resolver chooses
 * the commands from this: owned coins split, exact coins destroyed to zero,
 * an address balance redeemed and its remainder sent back. When neither
 * covers the amount alone, the resolver merges the redeemed part into the
 * first owned coin and sends that coin's remainder back.
 */
export type CoinSource =
  | "owned coins"
  | "exact coins"
  | "address balance"
  | "coins and address balance"
  | "coins topped up from address balance";
export const COIN_SOURCES: readonly CoinSource[] = [
  "owned coins",
  "exact coins",
  "address balance",
  "coins and address balance",
  "coins topped up from address balance",
];

function wallet(source: CoinSource, amount: bigint): { coins: bigint[]; addressBalance: bigint } {
  switch (source) {
    case "owned coins":
      return { coins: [amount * 3n], addressBalance: 0n };
    case "exact coins":
      return { coins: [amount / 2n, amount - amount / 2n], addressBalance: 0n };
    case "address balance":
      return { coins: [], addressBalance: amount * 2n };
    case "coins and address balance":
      return { coins: [amount / 4n], addressBalance: amount };
    case "coins topped up from address balance":
      return { coins: [amount / 2n], addressBalance: (amount * 3n) / 4n };
  }
}

/**
 * An in-memory `ClientWithCoreApi` for `Transaction.build`: it lists the
 * sender's coins and address balance, resolves every object as shared, and
 * describes each Move function as taking objects only (the builders serialize
 * every pure argument themselves).
 */
function offlineClient(tx: Transaction, source: CoinSource, amount: bigint): ClientWithCoreApi {
  const { coins, addressBalance } = wallet(source, amount);
  const coinBalance = coins.reduce((sum, balance) => sum + balance, 0n);
  const arity = new Map<string, number>();
  for (const command of tx.getData().commands) {
    if (command.MoveCall) {
      const { package: pkg, module, function: fn, arguments: args } = command.MoveCall;
      arity.set(`${normalizeSuiAddress(pkg)}::${module}::${fn}`, args.length);
    }
  }
  const core = {
    resolveTransactionPlugin: () => undefined,
    getBalance: async ({ coinType }: { coinType: string }) => ({
      balance: {
        coinType,
        balance: String(coinBalance + addressBalance),
        coinBalance: String(coinBalance),
        addressBalance: String(addressBalance),
      },
    }),
    listCoins: async ({ coinType }: { coinType: string }) => ({
      objects: coins.map((balance, index) => ({
        objectId: id((0xd0 + index).toString(16)),
        version: "11",
        digest: DIGEST,
        balance: String(balance),
        type: `0x2::coin::Coin<${coinType}>`,
      })),
      hasNextPage: false,
      cursor: null,
    }),
    getObjects: async ({ objectIds }: { objectIds: string[] }) => ({
      objects: objectIds.map((objectId) => ({
        objectId,
        version: "9",
        digest: DIGEST,
        owner: { $kind: "Shared", Shared: { initialSharedVersion: "3" } },
      })),
    }),
    getMoveFunction: async (call: { packageId: string; moduleName: string; name: string }) => {
      const count = arity.get(`${normalizeSuiAddress(call.packageId)}::${call.moduleName}::${call.name}`);
      if (count === undefined) throw new Error(`fixture has no Move function ${call.moduleName}::${call.name}`);
      const object = { reference: "mutable", body: { $kind: "datatype", datatype: { typeName: "0x2::object::UID", typeParameters: [] } } };
      return { function: { parameters: Array.from({ length: count }, () => object) } };
    },
  };
  return { core } as unknown as ClientWithCoreApi;
}

/** Builds `tx` as the sender's transaction kind, offline, and decodes it. */
export async function kindOf(
  tx: Transaction,
  options: { source?: CoinSource; amount?: bigint; sender?: string } = {},
): Promise<SponsorTransactionKind> {
  const { source = "owned coins", amount = 1_000_000n, sender = SENDER } = options;
  tx.setSender(sender);
  const bytes = await tx.build({ client: offlineClient(tx, source, amount), onlyTransactionKind: true });
  return bcs.TransactionKind.parse(bytes);
}

export type CommitRoute = "open" | "allowlisted" | "uncapped";
export const COMMIT_ROUTES: readonly CommitRoute[] = ["open", "allowlisted", "uncapped"];

/** `PresaleTransactions.commit`: commits `amount` Quote and sends the change to `recipient`. */
export function sdkCommit(
  route: CommitRoute,
  options: { amount?: bigint; recipient?: string; presaleId?: string; types?: typeof TYPES } = {},
): Transaction {
  const { amount = 1_000_000n, recipient = SENDER, presaleId = PRESALE_ID, types = TYPES } = options;
  const common = { ...types, presale: presaleObject(presaleId), amount, recipient };
  if (route === "allowlisted") {
    return presale.commit({
      ...common,
      route,
      allowlist: { index: 3n, wallet: SENDER, walletCap: 5_000_000n, proof: ["ab".repeat(32), "cd".repeat(32)] },
    });
  }
  return presale.commit({ ...common, route });
}

export function sdkClaim(participants: readonly string[] = [SENDER], presaleId = PRESALE_ID): Transaction {
  return presale.claim({ ...TYPES, presale: presaleObject(presaleId), participants });
}

export function sdkSettle(presaleId = PRESALE_ID): Transaction {
  return presale.settle({ ...TYPES, presale: presaleObject(presaleId) });
}

export function sdkCancel(presaleId = PRESALE_ID): Transaction {
  return presale.cancelUnlaunched({ ...TYPES, presale: presaleObject(presaleId) });
}

export function rewardProof(beneficiary = SENDER): RewardProof {
  return { index: "2", beneficiary, memeAmount: "700", quoteAmount: "90", proof: ["ef".repeat(32)] };
}

export function sdkRewardClaim(options: { round?: string; allocations?: RewardProof[] } = {}): Transaction {
  const { round = ROUND_ID, allocations = [rewardProof()] } = options;
  return new VaultTransactions(DEPLOYMENT.vault).claimRewards({
    memeType: SALE_TOKEN,
    quoteType: QUOTE,
    round: { objectId: round, initialSharedVersion: 8 },
    leaves: allocations.map((leaf) => ({
      ...leaf,
      index: BigInt(leaf.index),
      memeAmount: BigInt(leaf.memeAmount),
      quoteAmount: BigInt(leaf.quoteAmount),
      proof: leaf.proof.map(fromHex),
    })),
  });
}

/**
 * Cetus providers whose swaps the aggregator SDK builds offline from a route
 * alone. Pyth-priced providers (`PYTH_ORACLE_BASED_DEXES`) fetch prices from
 * Hermes and pay Pyth's update fee from the gas coin, which the policy refuses
 * anyway; the others need per-pool details the fixture route does not carry.
 */
export const CETUS_FIXTURE_PROVIDERS = [
  "CETUS",
  "KRIYA",
  "FLOWX",
  "FLOWXV3",
  "KRIYAV3",
  "AFTERMATH",
  "HAEDAL",
  "VOLO",
  "AFSUI",
  "BLUEMOVE",
  "DEEPBOOKV3",
  "SUILEND",
  "BLUEFIN",
  "ALPHAFI",
  "SPRINGSUI",
  "HAWAL",
  "MOMENTUM",
  "MAGMA",
  "FULLSAIL",
  "CETUSDLMM",
  "FERRADLMM",
  "FERRACLMM",
] as const;

/** Cetus's `find_routes` response for `amountIn` SUI to Quote through `provider`. */
function cetusRouteResponse(provider: string, amountIn: bigint, target: string, pool: string) {
  return {
    code: 200,
    msg: "Success",
    data: {
      request_id: "fixture-route",
      amount_in: amountIn.toString(),
      amount_out: "3000000",
      deviation_ratio: 0,
      packages: { [PACKAGE_NAMES.AGGREGATOR_V3]: CETUS_AGGREGATOR_PACKAGE },
      paths: [
        {
          id: pool,
          direction: true,
          provider,
          from: SUI,
          target,
          fee_rate: 0.0025,
          amount_in: amountIn.toString(),
          amount_out: "3000000",
          published_at: CETUS_ADAPTER_PACKAGE,
          extended_details: {},
        },
      ],
    },
  };
}

/** `AggregatorClient.findRouters` answered from the fixture response; any other request fails. */
async function cetusRoute(aggregator: AggregatorClient, provider: string, amountIn: bigint, target = QUOTE, pool = CETUS_POOL) {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("/find_routes?")) throw new Error(`fixture blocks network request ${url}`);
    return new Response(JSON.stringify(cetusRouteResponse(provider, amountIn, target, pool)));
  };
  try {
    const route = await aggregator.findRouters({ from: SUI, target, amount: amountIn, byAmountIn: true, providers: [provider] });
    if (!route || route.error) throw new Error(`fixture route failed: ${route?.error?.msg}`);
    return route;
  } finally {
    globalThis.fetch = fetch;
  }
}

type CetusTransaction = Parameters<AggregatorClient["routerSwap"]>[0]["txb"];

/**
 * Swap-and-commit in Cetus's sponsored mode: the sender's SUI comes from a
 * coin intent that never uses the gas coin (`useGasCoin: false`, what
 * `fastRouterSwap({ sponsored: true })` builds), `routerSwap` turns it into
 * Quote, and the Quote coin is committed with the SDK's `commit_open`.
 */
export async function cetusSwapAndCommit(provider = "CETUS", amountIn = 1_000_000_000n, pool = CETUS_POOL): Promise<Transaction> {
  const aggregator = new AggregatorClient({});
  const route = await cetusRoute(aggregator, provider, amountIn, QUOTE, pool);
  const tx = new Transaction();
  const sui = tx.coin({ type: SUI, balance: amountIn, useGasCoin: false });
  const quote = await aggregator.routerSwap({
    router: route,
    inputCoin: sui,
    slippage: 0.01,
    txb: tx as unknown as CetusTransaction,
  });
  const change = tx.add(
    presale.call.commitOpen({ ...TYPES, presale: presaleObject(), quoteIn: quote as unknown as TransactionArgument }),
  );
  tx.transferObjects([change], SENDER);
  return tx;
}

/** `fastRouterSwap({ sponsored: true })` alone: swaps SUI to Quote and delivers it to the sender. */
export async function cetusSponsoredSwap(provider = "CETUS", amountIn = 1_000_000_000n, pool = CETUS_POOL): Promise<Transaction> {
  const aggregator = new AggregatorClient({});
  const route = await cetusRoute(aggregator, provider, amountIn, QUOTE, pool);
  const tx = new Transaction();
  await aggregator.fastRouterSwap({ router: route, slippage: 0.01, txb: tx as unknown as CetusTransaction, sponsored: true });
  return tx;
}

/**
 * A sponsored-mode swap of SUI to `target` delivered to the sender, beside an
 * SDK `commit_open` paid from the sender's own Quote coins.
 */
export async function cetusSwapBesideCommit(target: string, amountIn = 1_000_000_000n): Promise<Transaction> {
  const aggregator = new AggregatorClient({});
  const route = await cetusRoute(aggregator, "CETUS", amountIn, target);
  const tx = new Transaction();
  const sui = tx.coin({ type: SUI, balance: amountIn, useGasCoin: false });
  const out = await aggregator.routerSwap({ router: route, inputCoin: sui, slippage: 0.01, txb: tx as unknown as CetusTransaction });
  tx.transferObjects([out as unknown as TransactionObjectArgument], SENDER);
  const quote = tx.coin({ type: QUOTE, balance: 1_000_000n, useGasCoin: false });
  tx.transferObjects([tx.add(presale.call.commitOpen({ ...TYPES, presale: presaleObject(), quoteIn: quote }))], SENDER);
  return tx;
}
