"use client";

import { DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { useId, useState } from "react";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import pickerStyles from "../coins/coins.module.css";
import { TokenPicker } from "../coins/TokenPicker";
import { CoinIdentity } from "#web/components/social/coins/CoinIdentity.tsx";
import { PUBLIC_BASE_COINS, type WalletCoinView } from "../coins/coin-model";
import { useSwapPickerHoldings } from "../coins/use-wallet";
import { fetchListedTradeCoins } from "../coins/swap-client";
import { tradableCoinView } from "../coins/swap-model";
import styles from "./commit.module.css";

async function listPaymentCoins(query: string | null, signal: AbortSignal, cursor?: string | null) {
  const page = await fetchListedTradeCoins({ q: query, cursor }, signal);
  return { coins: page.coins.map(tradableCoinView), nextCursor: page.next_cursor };
}

/** Every presale surface uses Swap's searchable picker, holdings read, and catalog. Opening or searching reads the holdings again: the rows show balances as they are now. */
export function PaymentCoinSelector({ coins, busy, selected, accepted, onPick, purchase, inField = false }: Readonly<{
  coins: readonly WalletCoinView[]; busy: boolean; selected: WalletCoinView; accepted: WalletCoinView; onPick: (coin: WalletCoinView) => void;
  purchase: boolean; inField?: boolean;
}>) {
  const [opened, setOpen] = useState(false);
  const title = useId();
  const { amountsHidden } = useShellPrefs();
  const listHoldings = useSwapPickerHoldings(true);
  const choices = [...new Map([...PUBLIC_BASE_COINS, accepted, ...coins, selected].map(coin => [coin.coinType, coin])).values()];
  return <>
    <DisclosureButton data-layout={inField ? "field" : undefined} aria-label={`Pay with ${selected.symbol}`} aria-haspopup="dialog" aria-expanded={opened} className={purchase ? styles.currencyChoice : styles.paymentCoin} disabled={busy} onClick={() => setOpen(true)} type="button"><CoinIdentity coin={selected} compact={inField} showName={false} /></DisclosureButton>
    <Sheet className={pickerStyles.pickerSheet} labelledBy={title} onRequestClose={() => setOpen(false)} open={opened}>
      <SheetClose onClick={() => setOpen(false)} />
      <SheetHeading id={title} title="Select payment coin" />
      <p className={styles.context}>Sui mainnet</p>
      <TokenPicker quickChoices={[accepted]} current={selected} wallet={choices} pins={[]} hidden={amountsHidden} listCoins={listPaymentCoins} listHoldings={listHoldings} onPick={coin => { onPick(coin); setOpen(false); }} />
    </Sheet>
  </>;
}
