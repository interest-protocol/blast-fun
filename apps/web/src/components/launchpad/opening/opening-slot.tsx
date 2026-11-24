import type { CoinActionSlots } from "../coin/CoinExecution";
import type { TradeUnavailable } from "../trade/server-availability";
import { OpeningRoundUnavailable } from "./OpeningRoundFacts";

/**
 * T-018's part of the coin page's execution contract (`CoinActionSlots`):
 * the `bid` slot, which the page renders only while the fresh launch object
 * is in its opening round. It shows the round's pooled facts and delivery
 * rules and says why Join (before the deadline) or Settle (once the launch
 * object read for this request shows the deadline passed) cannot be signed.
 */
export function openingBidActions(join: TradeUnavailable, settle: TradeUnavailable = join): Pick<CoinActionSlots, "bid"> {
  return {
    bid: ({ round, bidders }) => {
      const ended = round.endsAtMs !== null && round.readAtMs >= round.endsAtMs;
      return <OpeningRoundUnavailable round={round} bidders={bidders} reason={(ended ? settle : join).reason} />;
    },
  };
}
