import { shortAddress as shortId } from "@blast/core/lib/format.ts";
import { safeErrorCode } from "#web/lib/errors.ts";
// Spot Buy and Sell on a migrated launch's recorded venue pool, as adapters of
// the shared transaction boundary (`docs/launchpad/transactions.md`). Each
// review reads the recorded route from chain records (`readVenueRoute`), the
// venue's availability from the confirmed deployment, the signer's balances,
// and a fresh exact-input quote; it builds with the SDK's venue builder, and
// the preflight simulates that exact transaction and has the SDK reconcile the
// simulated swap against the quote before any signature. Success needs the
// completed swap to reconcile against the signed quote too. The venue's
// driver (Cetus CLMM or Bluefin Spot) is the one the launch recorded; a quote
// is built and reconciled only by its own venue's SDK adapter.

import { exactPrice, formatPrice, type ExactPrice } from "@interest-protocol/blast-sdk/launchpad";
import { BluefinVenueError, CetusVenueError, type BluefinVenueQuote, type CetusVenueQuote } from "@interest-protocol/blast-sdk/migrators";
import type { ClientWithCoreApi } from "@mysten/sui/client";

import type { MaterialFact } from "../transaction/action-machine.ts";
import type {
  ActionContext,
  CompletionExpectation,
  Eligibility,
  EnabledAccess,
  LaunchpadActionAdapter,
  SimulatedTransaction,
} from "../transaction/preflight.ts";
import { quoteAmount } from "./quote-asset.ts";
import { AMOUNT_REFUSALS, parseTradeAmount } from "./amount.ts";
import type { TradeDirection } from "./curve-adapter.ts";
import {
  BluefinQuoteRefused,
  BluefinQuoteUnavailable,
  buildBluefinTrade,
  quoteBluefinTrade,
  reconcileBluefinTrade,
  simulatedBluefinQuoteTransport,
} from "./venue-bluefin.ts";
import {
  buildCetusTrade,
  CetusQuoteRefused,
  CetusQuoteUnavailable,
  quoteCetusTrade,
  reconcileCetusTrade,
  simulatedCetusQuoteTransport,
} from "./venue-cetus.ts";
import { readVenueRoute, recordedPool, type RecordedVenue, type VenueLocator } from "./venue-route.ts";
import { VENUE_PRODUCTS } from "@blast/core/modules/launchpad-contract/venues.ts";
import { atomsGrouped } from "@blast/core/web/format.ts";
import { bpsPercent, isSlippageBps } from "@blast/core/lib/bps.ts";

export type VenueTradeInput = VenueLocator &
  Readonly<{
    direction: TradeDirection;
    /** The amount as typed: Quote to spend for a buy, the coin to sell for a sell. */
    amount: string;
    /** How far below the quoted amount the trader still accepts, in basis points. */
    slippageBps: bigint;
  }>;

type Problem = Extract<Eligibility, { eligible: false }>;

/** A quote of the venue the launch recorded, from that venue's SDK adapter. */
export type VenueQuote = CetusVenueQuote | BluefinVenueQuote;

type Balances = Readonly<{ quote: bigint; meme: bigint }>;

type VenueFresh =
  | Readonly<{ kind: "refused"; problem: Problem }>
  | Readonly<{ kind: "quoted"; recorded: RecordedVenue; balances: Balances; quote: VenueQuote }>;

/** Whole Quote per whole Meme, truncated to 12 decimal places. */
export function wholePrice(price: ExactPrice, memeDecimals: number, quoteDecimals = 9): string {
  const whole = formatPrice(exactPrice(price.numerator * 10n ** BigInt(memeDecimals), price.denominator * 10n ** BigInt(quoteDecimals)));
  const [integer, fraction = ""] = whole.split(".");
  const kept = fraction.slice(0, 12).replace(/0+$/, "");
  return kept ? `${integer}.${kept}` : integer!;
}

function refused(code: Problem["code"], message: string): VenueFresh {
  return { kind: "refused", problem: { eligible: false, code, message } };
}

/** The recorded venue pool as a required object, typed by its venue's lineage. */
function poolObject(recorded: RecordedVenue) {
  const { objectId, type } = recordedPool(recorded);
  return recorded.venue === "cetus"
    ? { role: "The Cetus pool", objectId, type, lineage: "cetusClmm" as const }
    : { role: "The Bluefin pool", objectId, type, lineage: "bluefinSpot" as const };
}

/** A fresh exact-input quote through the recorded venue's own SDK adapter and quote transport. */
function quoteRecorded(
  recorded: RecordedVenue,
  request: Readonly<{ side: TradeDirection; amountIn: bigint; slippageBps: bigint; sender: string; balances: Balances }>,
  context: Readonly<{ client: ClientWithCoreApi; access: EnabledAccess; now: () => number }>,
): Promise<VenueQuote> {
  const { client, access, now } = context;
  const transport = { client, access, sender: request.sender, balances: request.balances, now };
  return recorded.venue === "cetus"
    ? quoteCetusTrade({ ...request, record: recorded.cetus, transport: simulatedCetusQuoteTransport({ ...transport, pool: recorded.cetus.pool }) })
    : quoteBluefinTrade({ ...request, record: recorded.bluefin, transport: simulatedBluefinQuoteTransport({ ...transport, pool: recorded.bluefin.pool }) });
}

/** The quoted swap, built by its own venue's SDK builder. */
function buildQuoted(access: EnabledAccess, quote: VenueQuote, nowMs: number) {
  return quote.venue === "cetus" ? buildCetusTrade(access, quote, nowMs) : buildBluefinTrade(access, quote, nowMs);
}

/** Throws unless `transaction` is exactly the quoted swap, by its own venue's SDK reconciliation. */
function reconcileQuoted(transaction: SimulatedTransaction, quote: VenueQuote): void {
  if (quote.venue === "cetus") reconcileCetusTrade(transaction, quote);
  else reconcileBluefinTrade(transaction, quote);
}

function quoteFailure(error: unknown): VenueFresh {
  // The provider did not answer after its retries: retry the review later.
  if (error instanceof CetusQuoteUnavailable || error instanceof BluefinQuoteUnavailable) throw error;
  if (error instanceof CetusQuoteRefused || error instanceof BluefinQuoteRefused) {
    return refused("ineligible", "The venue refused this quote. Try a smaller amount.");
  }
  if (error instanceof CetusVenueError) return refused("ineligible", "The Cetus quote was refused. Review the amount and route before trying again.");
  if (error instanceof BluefinVenueError) return refused("ineligible", "The Bluefin quote was refused. Review the amount and route before trying again.");
  throw error;
}

/** One adapter per direction, for the venue the launch recorded; each completes only when the SDK reconciles its own swap. */
export function venueTradeAdapter(
  direction: TradeDirection,
  options: Readonly<{ now?: () => number }> = {},
): LaunchpadActionAdapter<VenueTradeInput, VenueFresh> {
  const now = options.now ?? Date.now;
  const quoteOf = (fresh: VenueFresh): VenueQuote => {
    if (fresh.kind !== "quoted") throw new RangeError(fresh.problem.message);
    return fresh.quote;
  };

  return {
    action: direction === "buy" ? "venue-buy" : "venue-sell",
    async readFresh(context: ActionContext<VenueTradeInput>) {
      const { client, deployment, access, signer, input } = context;
      const read = await readVenueRoute(client, deployment, input, now());
      // A transient read failure blocks like any unavailable node: retry later.
      if (read.status === "unavailable") throw new Error(read.message);
      if (read.status === "refused") {
        const code = read.code === "not-migrated" ? "stale-lifecycle" : "stale-route";
        return { objects: [], value: refused(code, read.message) };
      }
      const { recorded } = read;
      const objects = [
        { role: "The launch", objectId: recorded.launch.objectId, type: recorded.launchType, lineage: "launchpad" as const },
        { role: "The LP vault", objectId: recorded.vault.objectId, type: recorded.vaultType, lineage: "vault" as const },
        poolObject(recorded),
      ];
      const availability = access.venues[recorded.venue];
      if (!availability.available) {
        const reasons = availability.reasons.map((reason) => safeErrorCode(reason.code, "deployment-rejected")).join("; ");
        return {
          objects,
          value: refused("stale-route", `${VENUE_PRODUCTS[recorded.venue]} trading is unavailable for this Blast deployment (venue-unavailable: ${reasons}). Nothing can be signed.`),
        };
      }
      const [quoteBalance, memeBalance] = await Promise.all([
        client.core.getBalance({ owner: signer.address, coinType: recorded.launch.quoteType }),
        client.core.getBalance({ owner: signer.address, coinType: recorded.launch.memeType }),
      ]);
      const balances = { quote: BigInt(quoteBalance.balance.balance), meme: BigInt(memeBalance.balance.balance) };
      const amount = parseTradeAmount(input.amount, direction === "buy" ? recorded.quote.decimals : recorded.decimals);
      if (!amount.ok) return { objects, value: refused("ineligible", AMOUNT_REFUSALS[amount.reason]) };
      if (!isSlippageBps(input.slippageBps)) return { objects, value: refused("ineligible", "Choose a slippage tolerance below 100%.") };
      if (direction === "buy" && amount.atomic > balances.quote) {
        return { objects, value: refused("insufficient-balance", `Your wallet holds ${quoteAmount(balances.quote, recorded.quote)}, less than this buy.`) };
      }
      if (direction === "sell" && amount.atomic > balances.meme) {
        return {
          objects,
          value: refused("insufficient-balance", `Your wallet holds ${atomsGrouped(balances.meme, recorded.decimals)} ${recorded.symbol}, less than this sale.`),
        };
      }
      try {
        const request = { side: direction, amountIn: amount.atomic, slippageBps: input.slippageBps, sender: signer.address, balances };
        const quote = await quoteRecorded(recorded, request, { client, access, now });
        return { objects, value: { kind: "quoted", recorded, balances, quote } };
      } catch (error) {
        return { objects, value: quoteFailure(error) };
      }
    },
    eligibility(fresh) {
      return fresh.kind === "refused" ? fresh.problem : { eligible: true };
    },
    preview(fresh, { input }) {
      const quote = quoteOf(fresh);
      if (fresh.kind !== "quoted") return [];
      const { recorded, balances } = fresh;
      const { route } = quote;
      const formatQuote = (atoms: bigint) => quoteAmount(atoms, recorded.quote);
      const coin = (atoms: bigint) => `${atomsGrouped(atoms, recorded.decimals)} ${recorded.symbol}`;
      const [paid, received] = direction === "buy" ? [formatQuote, coin] : [coin, formatQuote];
      return [
        { key: "trade", label: "Trade", value: direction === "buy" ? `Buy ${recorded.symbol} with ${recorded.quote.symbol}` : `Sell ${recorded.symbol} for ${recorded.quote.symbol}` },
        { key: "venue", label: "Venue", value: `${VENUE_PRODUCTS[recorded.venue]} pool ${shortId(route.pool.objectId)}, recorded at migration` },
        { key: "amount-in", label: direction === "buy" ? "You pay" : "You sell", value: paid(quote.amountIn) },
        { key: "amount-out", label: "You receive about", value: received(quote.amountOut) },
        { key: "minimum-out", label: "Fewest you accept", value: received(quote.minimumOut) },
        {
          key: "fee",
          label: "Venue fee",
          value: `${paid(quote.feeAmount)} (${recorded.venue === "cetus" ? "Cetus" : "Bluefin"} pool fee, included in what you ${direction === "buy" ? "pay" : "sell"})`,
        },
        {
          key: "price-impact",
          label: "Price impact",
          value: quote.priceImpactBps === null ? "Not stated by the quote" : bpsPercent(quote.priceImpactBps),
        },
        { key: "pool-price", label: "Pool price before the trade", value: `1 ${recorded.symbol} = ${wholePrice(quote.priceBefore, recorded.decimals, recorded.quote.decimals)} ${recorded.quote.symbol}` },
        { key: "slippage", label: "Slippage tolerance", value: bpsPercent(input.slippageBps) },
        {
          key: "route",
          label: "Recorded route",
          value: `LP vault ${shortId(route.vaultId)}, tick spacing ${route.tickSpacing}, ${atomsGrouped(route.feeRate, 4)}% pool fee`,
        },
        { key: "balance-quote", label: `Your ${recorded.quote.symbol} balance`, value: quoteAmount(balances.quote, recorded.quote) },
        { key: "balance-meme", label: `Your ${recorded.symbol} balance`, value: coin(balances.meme) },
      ] satisfies MaterialFact[];
    },
    build(fresh, { access }) {
      const quote = quoteOf(fresh);
      return buildQuoted(access, quote, Math.max(now(), Number(quote.quotedAtMs)));
    },
    checkSimulation(simulated, fresh) {
      reconcileQuoted(simulated, quoteOf(fresh));
    },
    expiresAtMs: (fresh) => Number(quoteOf(fresh).expiresAtMs),
    // Never success without a reviewed quote: every ready review supplies its own check.
    completion: { kind: "check", check: () => false },
    completionFor(fresh): CompletionExpectation {
      const quote = quoteOf(fresh);
      return {
        kind: "check",
        check: (transaction) => {
          reconcileQuoted(transaction, quote);
          return true;
        },
      };
    },
    // Venue facts only: the curve's chart and activity are a separate, finished series.
    affectedReads: (input) => [
      `venue-pool:${input.launchId}`,
      `venue-chart:${input.launchId}`,
      `venue-activity:${input.launchId}`,
      "wallet:balances",
    ],
  };
}
