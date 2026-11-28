import { primaryPool, replicaPool } from "@blast/core/modules/database/pool.ts";
import { trackRequestWork } from "@blast/server/lib/request-work.ts";

import { Env, type AggregatorClientParams } from "@cetusprotocol/aggregator-sdk";
import type { SuiGrpcClient } from "@mysten/sui/grpc";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { sponsorService } from "@blast/server/modules/sponsor/runtime.ts";
import { blastWalletOf } from "@blast/server/modules/social/coins/runtime.ts";
import { sharedSocialRouteKit, socialMainnetClient } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createCetusTradeRouter, type TradeRouter } from "@blast/server/modules/social/trades/aggregator.ts";
import { createAftermathDaoRouter, fullnodeAftermathDaoPools, routeByVenue } from "@blast/server/modules/social/trades/aftermath.ts";
import { fullnodeTradeChain, type TradeChain } from "@blast/server/modules/social/trades/chain.ts";
import { tradeQuoteKey } from "@blast/server/modules/social/trades/quote-token.ts";
import { createSocialTradeRoutes, type SocialTradeRoutes } from "@blast/server/modules/social/trades/route.ts";
import { createSocialSwapRoutes, fullnodeTradeLookup, type SocialSwapRoutes } from "@blast/server/modules/social/trades/swap.ts";

/** The mainnet node (`socialMainnetClient`), one per process: the swap builder's coin and pool reads and the dry runs. */
function mainnet(): SuiGrpcClient {
  return socialMainnetClient("social.trades-fullnode");
}

/**
 * The aggregator over the same fullnode, mainnet only (`Env.Mainnet`; the SDK's
 * testnet configuration is never selected), with no partner. Blast's app fee
 * (`BLAST_TRADE_FEE_BPS`, `BLAST_TRADE_FEE_RECEIVER`) is the swap's overlay
 * fee, paid to the receiver inside the swap; with neither set a trade pays
 * the venues' fees and nothing else. `SOCIAL_TRADE_PROVIDERS` names the
 * venues (default Cetus and Bluefin). A coin whose sale migrated to an
 * Aftermath DAO-fee pool is routed through that pool (`aftermath.ts`), with
 * the same fee taken from its output. An invalid value of any of them stops
 * boot (`RuntimeConfig`): a misconfigured fee never trades without it.
 */
export function socialTradeRouter(): TradeRouter {
  return processSingleton("social.trades-router", () => {
    const { tradeProviders: providers, tradeFee: fee } = runtimeConfig();
    const aggregator: AggregatorClientParams = { env: Env.Mainnet, client: mainnet() as unknown as AggregatorClientParams["client"] };
    return routeByVenue(
      createCetusTradeRouter({ aggregator, providers, fee }),
      createAftermathDaoRouter({
        pools: fullnodeAftermathDaoPools(mainnet()),
        // The USDC ↔ SUI leg of an Aftermath route: the same aggregator, charging nothing (the DAO route takes Blast's fee).
        base: createCetusTradeRouter({ aggregator, providers, fee: null }),
        fee,
      }),
    );
  });
}

export function socialTradeChain(): TradeChain {
  return processSingleton("social.trades-chain", () => fullnodeTradeChain(mainnet()));
}

/** `chain_read_v1` reads for quotes, on the read replica. */
export function socialTradeDatabase(): ReadableDatabase {
  return autocommitReader(replicaPool(), "social", { label: "social.trades" });
}

/** The `quote_id` key from `RATE_LIMIT_SUBJECT_PEPPER`. */
export function socialTradeQuoteKey(): Buffer {
  return processSingleton("social.trades-quote-key", () => tradeQuoteKey(runtimeConfig().subjectPepper));
}

/** Trades on the primary: personal, and an owner sees what they just did. */
function socialTradePrimary(): ReadableDatabase {
  return autocommitReader(primaryPool(), "social", { label: "social.trades-primary" });
}

/** The production quote route over the shared social kit. */
export function socialTradeRoutes(): SocialTradeRoutes {
  return processSingleton("social.trade-routes", () =>
    createSocialTradeRoutes({
      kit: sharedSocialRouteKit(),
      database: socialTradeDatabase,
      router: () => socialTradeRouter(),
      chain: socialTradeChain,
      quoteKey: () => socialTradeQuoteKey(),
      blastWallet: blastWalletOf,
      trackWork: trackRequestWork,
    }));
}

/**
 * The production swap routes (R3-31): the same router, fullnode and quote
 * key, the primary, the presale sponsor in-process (its gas pool, reservations
 * and deployment gate).
 */
export function socialSwapRoutes(): SocialSwapRoutes {
  return processSingleton("social.swap-routes", () =>
    createSocialSwapRoutes({
      kit: sharedSocialRouteKit(),
      database: socialTradePrimary,
      router: () => socialTradeRouter(),
      chain: socialTradeChain,
      quoteKey: () => socialTradeQuoteKey(),
      sponsor: sponsorService,
      transactions: () => fullnodeTradeLookup(mainnet),
      blastWallet: blastWalletOf,
    }));
}
