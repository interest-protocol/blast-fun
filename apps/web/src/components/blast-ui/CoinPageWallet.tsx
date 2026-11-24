"use client";

import { createContext, useContext, type ReactNode } from "react";

export const CoinPageWalletContext = createContext<ReactNode>(null);

/** The shell supplies the account controls for the coin detail’s back row. */
export function CoinPageWallet() {
  return useContext(CoinPageWalletContext);
}
