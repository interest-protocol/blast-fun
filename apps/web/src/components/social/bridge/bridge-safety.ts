import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/web/contracts/portfolio.ts";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";
import type { Quote } from "@mayanfinance/swap-sdk";

import type { BridgeChain } from "./bridge-config.ts";
import { CHAINS, sourceAddressKey, type DestinationToken, type SourceToken } from "./bridge-model.ts";

/** Jose, 2026-11-28: a worst case that loses more than 3% takes a second press. Nothing is blocked. */
export const LOSS_ASK_BPS = 300;

/** What the worst case loses, in Blast's own dollar prices. */
export type Loss =
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "loss"; bps: number; /** Only the fixed fee puts it above the line, so more money would lose less. */ sendMore: boolean }>;

export type ReadPrice = (coinType: string) => Promise<SocialPriceHistory | null>;

/** Wrapped coins on Sui follow the feed of the coin they wrap, so they price a source chain's own coin. */
const SUI_ETH = "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH";
const WRAPPED_SOL = "0xb7844e289a8410e50fb3ca48d69eb9cf29e27d223ef90353fe1bd8e27ff8f3f8::coin::COIN";

/** A coin worth $1, a coin type Blast prices, or null when Blast has no price for it. */
type PriceSource = 1 | string | null;

function sourcePrice(chain: BridgeChain, token: SourceToken): PriceSource {
  if (sourceAddressKey(chain, token.mayan) === sourceAddressKey(chain, CHAINS[chain].tokens[1].mayan)) return 1;
  // Polygon's own coin is POL, and Blast prices none.
  if (!token.native || chain === "polygon") return null;
  return chain === "solana" ? WRAPPED_SOL : SUI_ETH;
}

function destinationPrice(to: DestinationToken): PriceSource {
  return to.symbol === "USDC" ? 1 : SUI_COIN_TYPE;
}

/** The coin's dollar price, or null when there is none, the read fails or it is too old. */
async function dollars(source: PriceSource, read: ReadPrice, now: () => number): Promise<number | null> {
  if (typeof source !== "string") return source;
  try {
    const answer = await read(source);
    const price = Number(answer?.price_usd ?? 0);
    const asOf = answer?.price_as_of_ms;
    return price > 0 && asOf !== undefined && now() - asOf <= PORTFOLIO_PRICE_MAX_AGE_MS ? price : null;
  } catch {
    return null;
  }
}

/** Dollars sent against Mayan's minimum received. */
export async function worstLoss({ quote, chain, token, to, read, now }: Readonly<{
  quote: Quote;
  chain: BridgeChain;
  token: SourceToken;
  to: DestinationToken;
  read: ReadPrice;
  now: () => number;
}>): Promise<Loss> {
  // Both reads start in the same tick, so the price client asks for them in one request.
  const [from, received] = await Promise.all([dollars(sourcePrice(chain, token), read, now), dollars(destinationPrice(to), read, now)]);
  if (from === null || received === null) return { kind: "unknown" };
  const sent = (Number(quote.effectiveAmountIn64) / 10 ** token.decimals) * from;
  const gap = sent - quote.minReceived * received;
  // Rounded to a millionth of a point, so exactly 3% is not pushed over by float noise.
  const bps = (amount: number) => Math.round((amount / sent) * 1e10) / 1e6;
  const lost = bps(gap);
  if (!Number.isFinite(lost)) return { kind: "unknown" };
  // Ours: without Mayan's relayer fee (in dollars, the same at any size) it would be one press.
  const sendMore = lost > LOSS_ASK_BPS && bps(gap - (quote.clientRelayerFeeSuccess ?? 0)) <= LOSS_ASK_BPS;
  return { kind: "loss", bps: lost, sendMore };
}

/** Whether this send takes a second press. */
export function asksFirst(loss: Loss): boolean {
  return loss.kind === "unknown" || loss.bps > LOSS_ASK_BPS;
}
