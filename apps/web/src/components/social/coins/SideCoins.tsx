"use client";

import { DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";

import { HIDDEN_AMOUNT, usd } from "@blast/core/web/format.ts";

import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import rowStyles from "./CoinRow.module.css";
import { coinAmt, type WalletCoinView } from "./coin-model";

/**
 * The coin row of Settings' "Your wallet" (R3-33), as the Settings board
 * draws it: a tonal row, the mark, the name over its category (or ticker),
 * the value over the amount, and the 16px chevron. A value without a price
 * is left out.
 */
export function CoinRow({ coin, hidden, onOpen }: Readonly<{ coin: WalletCoinView; hidden: boolean; onOpen: () => void }>) {
  const amount = hidden ? HIDDEN_AMOUNT : coinAmt(coin, coin.amount);
  const value = hidden ? HIDDEN_AMOUNT : coin.value === null ? null : usd(coin.value, 2);
  const second = coreCoin(coin.coinType)?.category ?? (coin.name === coin.symbol ? null : coin.symbol);
  return (
    <DisclosureButton
      aria-haspopup="dialog"
      aria-label={`${coin.name}, ${amount}: deposit, withdraw or trade`}
      className={rowStyles.row}
      onClick={onOpen}
      type="button"
      variant="ghost"
    >
      <CoinMark coin={coin} size={30} />
      <span className={rowStyles.name}>
        <b>{coin.name}</b>
        {second === null ? null : <span>{second}</span>}
      </span>
      <span className={rowStyles.value}>
        {value === null ? null : <b className="num">{value}</b>}
        <span className="num">{amount}</span>
      </span>
    </DisclosureButton>
  );
}
