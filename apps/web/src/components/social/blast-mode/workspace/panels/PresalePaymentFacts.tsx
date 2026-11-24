import type { SocialTradeQuote } from "@blast/core/web/contracts/trades.ts";
import type { CommitInput } from "@blast/core/modules/social/commit/quote.ts";
import { saleQuoteCoin } from "#web/components/social/commit/commit-payment.ts";
import type { WalletCoinView } from "#web/components/social/coins/coin-model.ts";
import { impactText } from "#web/components/social/trades/trade-quote-view.ts";
import { PresaleAmount } from "./PresaleContent";
import styles from "./PresalePanel.module.css";

export function PresalePaymentFacts({
  quote,
  input,
  coin,
}: Readonly<{ quote: SocialTradeQuote | null; input: CommitInput | null; coin: WalletCoinView | null }>) {
  const source = coin;
  const out = input && saleQuoteCoin(input.sale);
  const incoming = (atoms: string | null | undefined, label: string) => (
    <PresaleAmount
      atoms={atoms}
      decimals={source?.decimals ?? 0}
      symbol={source?.symbol ?? ""}
      label={label}
    />
  );
  const outgoing = (atoms: string | null | undefined, label: string) => (
    <PresaleAmount
      atoms={atoms}
      decimals={out?.decimals ?? 0}
      symbol={out?.symbol ?? ""}
      label={label}
    />
  );
  return (
    <dl className={styles.facts} aria-label="Payment route facts">
      <div>
        <dt>Route</dt>
        <dd>{quote?.route_label ?? "Unavailable"}</dd>
      </div>
      <div>
        <dt>Spending</dt>
        <dd>{incoming(quote?.amount_in, "payment spend")}</dd>
      </div>
      <div>
        <dt>Estimated commitment</dt>
        <dd>{outgoing(quote?.amount_out, "estimated commitment")}</dd>
      </div>
      <div>
        <dt>Minimum commitment</dt>
        <dd>{outgoing(quote?.min_out, "minimum commitment")}</dd>
      </div>
      <div>
        <dt>Price impact</dt>
        <dd>
          {quote?.price_impact_bps == null
            ? "Unavailable"
            : impactText(quote.price_impact_bps)}
        </dd>
      </div>
      <div>
        <dt>Slippage</dt>
        <dd>{quote ? impactText(quote.slippage_bps) : "Unavailable"}</dd>
      </div>
      <div>
        <dt>Venue fee</dt>
        <dd>{incoming(quote?.fee_amount, "venue fee")}</dd>
      </div>
      <div>
        <dt>Blast swap fee</dt>
        <dd>{outgoing(quote?.blast_fee_amount, "Blast swap fee")}</dd>
      </div>
      <div>
        <dt>Route network fee</dt>
        <dd>
          {quote?.network_fee?.label ?? "Unavailable"} ·{" "}
          <PresaleAmount
            atoms={quote?.network_fee?.estimate_mist}
            decimals={9}
            symbol="SUI"
            label="route network fee"
          />
        </dd>
      </div>
    </dl>
  );
}
