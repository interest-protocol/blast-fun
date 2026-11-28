// Spot Buy and Sell on a Live bonding curve, as adapters of the shared
// transaction boundary (`docs/launchpad/transactions.md`). Each review reads
// the launch and balances fresh, previews with the SDK (`previewBuy`,
// `previewSell`), and builds with the SDK (`LaunchpadTransactions.buy`,
// `sell`); success needs the completed `Bought` or `Sold` event.

import { shortAddress as shortId } from "@blast/core/lib/format.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { launchpadDeployment } from "@interest-protocol/blast-sdk/deployments";
import { LaunchpadTransactions, previewBuy, previewSell } from "@interest-protocol/blast-sdk/launchpad";
import { Transaction } from "@mysten/sui/transactions";
import type { CurvePaymentBuild } from "@blast/core/modules/launchpad-coin/curve-payment.ts";
import { CurveSponsorshipUnavailable, requestCurveSponsorship, requestCurvePayment } from "./curve-payment-client.ts";
import { readSponsoredBytes } from "#web/lib/sui-signing.ts";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import type { MaterialFact } from "../transaction/action-machine.ts";
import type { ActionContext, Eligibility, LaunchpadActionAdapter } from "../transaction/preflight.ts";
import { blastPaysGas } from "../transaction/signer.ts";
import { AMOUNT_REFUSALS, parseTradeAmount } from "./amount.ts";
import { curveFeeValue, quoteAmount } from "./quote-asset.ts";
import { readCurve, type Curve } from "./curve-read.ts";
import { atomsGrouped } from "@blast/core/web/format.ts";
import { bpsPercent, isSlippageBps, minimumOut } from "@blast/core/lib/bps.ts";

export type TradeDirection = "buy" | "sell";

export type CurveTradeInput = Readonly<{
  launchId: string;
  direction: TradeDirection;
  /** The amount as typed: Quote to spend for a buy, the coin to sell for a sell. */
  amount: string;
  /** How far below the previewed amount the creator still accepts, in basis points. */
  slippageBps: bigint;
  /** Minimum shown when Buy/Sell was clicked; fresh reads must never lower it. */
  minimumOut?: bigint;
  /** A sealed, wallet-bound swap funds this buy in the same transaction. */
  payment?: Readonly<{ coinType: string; symbol: string; decimals: number; quoteId: string; quoteAmount: string; expiresAtMs: number }>;
}>;

type CurveFresh = Readonly<{ curve: Curve; quote: bigint; meme: bigint; paymentBalance: bigint | null; routed: CurvePaymentBuild | null }>;

/** The atomic decimals of the amount each direction takes. */
export function inputDecimals(direction: TradeDirection, curve: Pick<Curve, "decimals" | "quote">): number {
  return direction === "buy" ? curve.quote.decimals : curve.decimals;
}

function blocked(code: Extract<Eligibility, { eligible: false }>["code"], message: string): Eligibility {
  return { eligible: false, code, message };
}

/** Why the curve cannot take this trade now, by lifecycle; null while it is Live. */
function lifecycleProblem(curve: Curve): Eligibility | null {
  switch (curve.launch.lifecycle) {
    case "Live":
      return null;
    case "OpeningRound":
      return blocked("stale-lifecycle", "The opening round is still running, so the curve does not trade yet. Bid in the round, or wait until it settles.");
    case "MigrationReady":
      return blocked("stale-lifecycle", "The curve reached its graduation target and is closed. The coin moves to its venue pool next; trade it there.");
    case "Migrated":
      return blocked("stale-route", "This coin has graduated from its curve. Trade it on its venue pool instead.");
  }
}

function lifecycleFact(curve: Curve): string {
  return curve.launch.lifecycle === "Live" ? "Live: the bonding curve is open" : curve.launch.lifecycle;
}

function acceptsOutput(input: CurveTradeInput, curve: Curve, amount: bigint, direction: TradeDirection): boolean {
  if (input.minimumOut === undefined) return true;
  const expected = direction === "buy"
    ? previewBuy(curve.launch, amount).memeOutNet
    : previewSell(curve.launch, amount, curve.launch.sellBurnBps).quoteOutNet;
  return input.minimumOut > 0n && expected >= input.minimumOut;
}

/** One adapter per direction: each completes only on its own event. */
export function curveTradeAdapter(direction: TradeDirection, routePayment = requestCurvePayment, sponsorTrade = requestCurveSponsorship): LaunchpadActionAdapter<CurveTradeInput, CurveFresh> {
  let sponsored: Readonly<{ key: string; transaction: Transaction; reservationId: string; expiresAtMs: number }> | null = null;
  const amountOf = (input: CurveTradeInput, curve: Curve) => parseTradeAmount(direction === "buy" && input.payment ? atomsGrouped(BigInt(input.payment.quoteAmount), curve.quote.decimals) : input.amount, inputDecimals(direction, curve));

  async function readRoutedPayment({ input, signer }: ActionContext<CurveTradeInput>, curve: Curve, payment: NonNullable<CurveTradeInput["payment"]>, walletPaysGas: boolean) {
    const amount = parseTradeAmount(input.amount, payment.decimals);
    const funding = BigInt(payment.quoteAmount);
    if (!amount.ok || funding <= 0n || payment.coinType === curve.launch.quoteType || payment.expiresAtMs <= Date.now()) throw new Error("The payment quote expired or changed. Refresh it and try again.");
    const minimum = input.minimumOut ?? minimumOut(previewBuy(curve.launch, funding).memeOutNet, input.slippageBps);
    const routed = await routePayment(signer, input.launchId, payment.quoteId, minimum, walletPaysGas);
    if (routed.sender !== normalizeSuiAddress(signer.address) || routed.launch_id !== input.launchId || routed.quote_type !== curve.launch.quoteType || routed.payment_type !== payment.coinType || routed.payment_amount !== amount.atomic.toString() || routed.quote_amount !== payment.quoteAmount || routed.min_meme_out !== minimum.toString() || routed.expires_at_ms !== payment.expiresAtMs) throw new Error("The payment route does not match this trade. Nothing was signed.");
    return routed;
  }

  /** The trade; `payGas` lets a buy's SUI come from the wallet's gas coin when the wallet pays its own gas. */
  function buildTrade(fresh: CurveFresh, { deployment, input, signer }: ActionContext<CurveTradeInput>, payGas: boolean): Transaction {
    const { curve } = fresh;
    if (direction === "buy" && fresh.routed) return Transaction.fromKind(fresh.routed.transaction_kind_bytes);
    const amount = amountOf(input, curve);
    if (!amount.ok) throw new RangeError(AMOUNT_REFUSALS[amount.reason]);
    const launch = { objectId: curve.launch.objectId, initialSharedVersion: curve.launch.initialSharedVersion, mutable: true as const };
    const transactions = new LaunchpadTransactions(launchpadDeployment(deployment));
    const types = { memeType: curve.launch.memeType, quoteType: curve.launch.quoteType };
    const recipient = normalizeSuiAddress(signer.address);
    if (direction === "buy") {
      const expected = previewBuy(curve.launch, amount.atomic).memeOutNet;
      return transactions.buy({ ...types, launch, quoteAmount: amount.atomic, minMemeOut: input.minimumOut ?? minimumOut(expected, input.slippageBps), recipient, useGasCoin: payGas });
    }
    const expected = previewSell(curve.launch, amount.atomic, curve.launch.sellBurnBps).quoteOutNet;
    return transactions.sell({ ...types, launch, memeAmount: amount.atomic, minQuoteOut: input.minimumOut ?? minimumOut(expected, input.slippageBps), recipient });
  }

  return {
    action: direction === "buy" ? "curve-buy" : "curve-sell",
    async readFresh(context: ActionContext<CurveTradeInput>) {
      const { client, deployment, signer, input } = context;
      const read = await readCurve(client, deployment, input.launchId, Date.now());
      if (read.status !== "ok") {
        return { objects: [{ role: "The launch", objectId: input.launchId, type: null, lineage: "launchpad" }], value: null };
      }
      const { curve } = read;
      const [quote, coin] = await Promise.all([
        client.core.getBalance({ owner: signer.address, coinType: curve.launch.quoteType }),
        client.core.getBalance({ owner: signer.address, coinType: curve.launch.memeType }),
      ]);
      let routed: CurvePaymentBuild | null = null;
      let paymentBalance: bigint | null = null;
      if (direction === "buy" && input.payment) {
        const payment = input.payment;
        routed = await readRoutedPayment(context, curve, payment, !blastPaysGas(signer));
        paymentBalance = BigInt((await client.core.getBalance({ owner: signer.address, coinType: payment.coinType })).balance.balance);
      }
      return {
        objects: [{ role: "The launch", objectId: curve.launch.objectId, type: curve.objectType, lineage: "launchpad" }],
        value: { curve, quote: BigInt(quote.balance.balance), meme: BigInt(coin.balance.balance), paymentBalance, routed },
      };
    },
    eligibility(fresh, { input }) {
      const lifecycle = lifecycleProblem(fresh.curve);
      if (lifecycle) return lifecycle;
      const amount = amountOf(input, fresh.curve);
      if (!amount.ok) return blocked("ineligible", AMOUNT_REFUSALS[amount.reason]);
      if (!isSlippageBps(input.slippageBps)) return blocked("ineligible", "Choose a slippage tolerance below 100%.");
      if (input.payment && direction === "buy") {
        const pay = parseTradeAmount(input.amount, input.payment.decimals);
        if (!pay.ok || fresh.paymentBalance === null || pay.atomic > fresh.paymentBalance) return blocked("insufficient-balance", "Your wallet does not hold enough of the selected payment coin.");
        if (!fresh.routed || fresh.routed.expires_at_ms <= Date.now()) return blocked("ineligible", "The payment quote expired. Refresh it and try again.");
      }
      if (direction === "buy" && !input.payment && amount.atomic > fresh.quote) {
        return blocked("insufficient-balance", `Your wallet holds ${quoteAmount(fresh.quote, fresh.curve.quote)}, less than this buy.`);
      }
      if (direction === "sell" && amount.atomic > fresh.meme) {
        return blocked(
          "insufficient-balance",
          `Your wallet holds ${atomsGrouped(fresh.meme, fresh.curve.decimals)} ${fresh.curve.symbol}, less than this sale.`,
        );
      }
      if (!acceptsOutput(input, fresh.curve, amount.atomic, direction)) return blocked("ineligible", "The price moved beyond your slippage tolerance. Check the updated estimate and try again. Nothing was signed.");
      return { eligible: true };
    },
    preview(fresh, { input }) {
      const { curve } = fresh;
      const formatQuote = (atoms: bigint) => quoteAmount(atoms, curve.quote);
      const coin = (atoms: bigint) => `${atomsGrouped(atoms, curve.decimals)} ${curve.symbol}`;
      const amount = amountOf(input, curve);
      if (!amount.ok) throw new RangeError(AMOUNT_REFUSALS[amount.reason]);
      const common: MaterialFact[] = [
        { key: "slippage", label: "Slippage tolerance", value: bpsPercent(input.slippageBps) },
        { key: "lifecycle", label: "Launch state", value: lifecycleFact(curve) },
        {
          key: "route",
          label: "Route",
          value: `Blast bonding curve, launch ${shortId(curve.launch.objectId)} at version ${curve.observation.version}`,
        },
        { key: "balance-quote", label: `Your ${curve.quote.symbol} balance`, value: quoteAmount(fresh.quote, fresh.curve.quote) },
        { key: "balance-meme", label: `Your ${curve.symbol} balance`, value: coin(fresh.meme) },
      ];
      if (direction === "buy") {
        const preview = previewBuy(curve.launch, amount.atomic);
        const fees = curveFeeValue(preview.quoteFee, preview.memeFee, formatQuote, coin);
        return [
          { key: "trade", label: "Trade", value: `Buy ${curve.symbol} with ${curve.quote.symbol}` },
          ...(input.payment ? [
            { key: "payment-in", label: "You pay", value: `${input.amount} ${input.payment.symbol}` },
            { key: "payment-route", label: "Payment route", value: `${input.payment.symbol} → ${curve.quote.symbol} → ${curve.symbol}` },
            { key: "quote-in", label: "Curve payment", value: formatQuote(preview.quoteInGross) },
          ] : [{ key: "quote-in", label: "You pay", value: formatQuote(preview.quoteInGross) }]),
          ...(preview.quoteRefund > 0n ? [{ key: "refund", label: "Refund", value: formatQuote(preview.quoteRefund) }] : []),
          { key: "meme-out", label: "You receive about", value: coin(preview.memeOutNet) },
          { key: "minimum-out", label: "Fewest you accept", value: coin(input.minimumOut ?? minimumOut(preview.memeOutNet, input.slippageBps)) },
          ...(fees ? [{ key: "fees", label: "Fee", value: fees }] : []),
          ...(preview.crossedThreshold
            ? [{ key: "graduation", label: "Graduation", value: "This buy reaches the graduation target; the curve closes after it." }]
            : []),
          ...common,
        ];
      }
      const preview = previewSell(curve.launch, amount.atomic, curve.launch.sellBurnBps);
      const fees = curveFeeValue(preview.quoteFee, preview.memeFee, formatQuote, coin);
      return [
        { key: "trade", label: "Trade", value: `Sell ${curve.symbol} for ${curve.quote.symbol}` },
        { key: "meme-in", label: "You sell", value: coin(preview.memeInGross) },
        { key: "quote-out", label: "You receive about", value: formatQuote(preview.quoteOutNet) },
        { key: "minimum-out", label: "Fewest you accept", value: formatQuote(input.minimumOut ?? minimumOut(preview.quoteOutNet, input.slippageBps)) },
        ...(preview.pendingBurnDelta > 0n ? [{ key: "burn", label: "Burned", value: `${coin(preview.pendingBurnDelta)} (${bpsPercent(preview.burnBps)} of the sale after the fee)` }] : []),
        ...(fees ? [{ key: "fees", label: "Fee", value: fees }] : []),
        ...common,
      ];
    },
    build: (fresh, context) => buildTrade(fresh, context, !blastPaysGas(context.signer)),
    async prepare(transaction, fresh, context) {
      const { signer, client, input } = context;
      if (!blastPaysGas(signer)) return { transaction };
      transaction.setSender(signer.address);
      const kind = await transaction.build({ client, onlyTransactionKind: true });
      const key = `${normalizeSuiAddress(signer.address)}:${toBase64(kind)}`;
      if (sponsored?.key === key && sponsored.expiresAtMs > Date.now() + 5_000) return sponsored;
      const amount = amountOf(input, fresh.curve);
      if (!amount.ok) throw new RangeError(AMOUNT_REFUSALS[amount.reason]);
      const minimum = input.minimumOut ?? (direction === "buy"
        ? minimumOut(previewBuy(fresh.curve.launch, amount.atomic).memeOutNet, input.slippageBps)
        : minimumOut(previewSell(fresh.curve.launch, amount.atomic, fresh.curve.launch.sellBurnBps).quoteOutNet, input.slippageBps));
      let response: Awaited<ReturnType<typeof sponsorTrade>>;
      try {
        response = await sponsorTrade(signer, {
          launch_id: input.launchId, sponsor: true, direction,
          amount: fresh.routed?.payment_amount ?? amount.atomic.toString(), min_out: minimum.toString(),
          ...(input.payment ? { quote_id: input.payment.quoteId } : {}),
        });
      } catch (error) {
        // Only an outside wallet can cover an unavailable sponsor with its own gas.
        if (signer.kind !== "wallet" || !(error instanceof CurveSponsorshipUnavailable)) throw error;
        if (input.payment && fresh.routed?.payment_type === SUI_COIN_TYPE) {
          const walletPaid = await readRoutedPayment(context, fresh.curve, input.payment, true);
          return { transaction: Transaction.fromKind(walletPaid.transaction_kind_bytes) };
        }
        return { transaction: buildTrade(fresh, context, true) };
      }
      const bytes = readSponsoredBytes(response.transaction_bytes, kind, signer.address);
      if (!bytes || response.transaction_kind_bytes !== toBase64(kind) || response.expires_at_ms <= Date.now() + 5_000) throw new Error("The sponsored transaction does not match this trade. Nothing was signed.");
      sponsored = { key, transaction: Transaction.from(bytes), reservationId: response.reservation_id, expiresAtMs: response.expires_at_ms };
      return sponsored;
    },
    expiresAtMs: (fresh) => fresh.routed?.expires_at_ms,
    completion: { kind: "event", source: "launchpad", event: direction === "buy" ? "Bought" : "Sold" },
    affectedReads: (input) => [
      `launch:${input.launchId}`,
      `curve:${input.launchId}`,
      `chart:${input.launchId}`,
      `activity:${input.launchId}`,
      "wallet:balances",
    ],
  };
}
