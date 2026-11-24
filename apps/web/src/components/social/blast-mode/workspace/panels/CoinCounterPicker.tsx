"use client";
import theme from "../WorkspaceTheme.module.css";
import { DisclosureButton } from "#web/components/blast-ui/Button.tsx";

import { useCallback, useId, useState } from "react";
import type { SocialWallet } from "@blast/core/web/contracts/coins.ts";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { TOKEN_PICKER_SHEET, TokenPicker } from "#web/components/social/coins/TokenPicker.tsx";
import { PUBLIC_BASE_COINS, walletCoinViews, type WalletCoinView } from "#web/components/social/coins/coin-model.ts";
import { fetchListedTradeCoins } from "#web/components/social/coins/swap-client.ts";
import { ECOSYSTEM_COIN_VIEWS, tradableCoinView } from "#web/components/social/coins/swap-model.ts";
import { useSwapPickerHoldings } from "#web/components/social/coins/use-wallet.ts";
import styles from "./CoinTrade.module.css";
import { counterFacts, type Choice } from "./counter-facts";

/**
 * The payment (buy) or receive (sell) coin. Until the person picks one, it is the first base coin that is not the
 * coin being traded, so a USDC panel opens paying with SUI rather than on a USDC-for-USDC pair (audit Buy/Sell).
 */
export function useCoinCounter(side:"buy"|"sell",wallet:SocialWallet|null,coinType:string) {
  const [choices,setChoices]=useState<Partial<Record<"buy"|"sell",Choice>>>({});
  const listCoins=useCallback(async(q:string|null,signal?:AbortSignal,cursor?:string|null)=>{
    const page=await fetchListedTradeCoins({q,cursor},signal);
    return {coins:page.coins.map(tradableCoinView),nextCursor:page.next_cursor};
  },[]);
  const choice=choices[side] ?? {coin:PUBLIC_BASE_COINS.find(coin=>coin.coinType !== coinType) ?? PUBLIC_BASE_COINS[0]!};
  return {choice,facts:counterFacts(choice,wallet),listCoins,
    pick:(coin:WalletCoinView)=>{
      const next={coin};
      setChoices(current=>({...current,[side]:next}));
    }};
}

export function CoinCounterPicker({active=true,side,counter,wallet,hidden,disabled,onChange}:Readonly<{
  active?:boolean;side:"buy"|"sell";counter:ReturnType<typeof useCoinCounter>;wallet:SocialWallet|null;hidden:boolean;disabled:boolean;onChange:()=>void;
}>) {
  const [open,setOpen]=useState(false);
  const [lastActive,setLastActive]=useState(active);
  if(lastActive !== active){setLastActive(active);if(!active)setOpen(false);}
  const title=useId();
  const listHoldings=useSwapPickerHoldings();
  const label=side === "buy" ? "Pay with" : "Receive";
  return <>
    <DisclosureButton variant="secondary" size="md" className={styles.pay} type="button" disabled={disabled} aria-label={`${label} ${counter.facts.symbol}`} title={`${label} ${counter.facts.symbol}`} aria-haspopup="dialog" aria-expanded={open && !disabled} onClick={()=>setOpen(true)}
      leadingIcon={<CoinMark coin={counter.choice.coin} size={22}/>}>
      <span className={styles.payText}><span className={styles.payLabel}>{label}</span><span className={styles.paySymbol}>{counter.facts.symbol}</span></span>
    </DisclosureButton>
    <Sheet className={`${theme.theme} ${TOKEN_PICKER_SHEET}`} open={open && !disabled} onRequestClose={()=>setOpen(false)} labelledBy={title}>
      <SheetClose onClick={()=>setOpen(false)}/><SheetHeading id={title} title={label}/>
      {open && !disabled && <TokenPicker current={counter.choice.coin} wallet={walletCoinViews(wallet)} pins={[]} hidden={hidden} listCoins={counter.listCoins} listHoldings={listHoldings} catalogCoins={ECOSYSTEM_COIN_VIEWS} onPick={coin=>{if(disabled)return;onChange();counter.pick(coin);setOpen(false);}}/>}
    </Sheet>
  </>;
}
