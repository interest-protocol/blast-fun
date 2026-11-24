"use client";

import type { ReactNode } from "react";

import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinLegacyMark } from "#web/components/blast-ui/Icons.tsx";
import { blastV1Coin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import type { WalletCoinView } from "./coin-model";
import styles from "./coins.module.css";
import { fullName } from "./swap-model";

/** `showName={false}` keeps the full-size mark but shows the symbol alone (a pay field: "SUI", never "SUI Sui"). */
export function CoinIdentity({ coin, children, compact = false, showName = !compact }: Readonly<{ coin: Pick<WalletCoinView, "key" | "iconUrl" | "round" | "symbol" | "name"> & Partial<Pick<WalletCoinView, "coinType">>; children?: ReactNode; compact?: boolean; showName?: boolean }>) {
  return <span className={styles.identity}>
    <CoinMark coin={coin} size={compact ? 22 : 28} />
    <span className={styles.identityText}><b>{coin.symbol}{coin.coinType && blastV1Coin(coin.coinType) ? <CoinLegacyMark /> : null}{children}</b>{showName && fullName(coin) !== coin.symbol ? <span>{fullName(coin)}</span> : null}</span>
  </span>;
}
