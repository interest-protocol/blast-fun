"use client";

import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

type Balances = Readonly<Record<string, bigint>>;

const Held = createContext<Balances>({});
const Publish = createContext<((coinType: string, atoms: bigint | null) => void) | null>(null);
const NONE = BigInt(0);

const canonical = (coinType: string | null) => (coinType && isValidStructTag(coinType) ? normalizeStructTag(coinType) : null);

/**
 * The connected wallet's balance of each coin a trade rail on screen has read (the curve rail's own read,
 * or a swap side's), so a coin page's price row knows whether the trader holds its coin without reading
 * anything itself. The shell holds it: a sale's rail is in the shell's aside, not under its page.
 */
export function HeldBalanceProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [balances, setBalances] = useState<Balances>({});
  const publish = useCallback((coinType: string, atoms: bigint | null) => setBalances((current) => {
    if (atoms !== null) return current[coinType] === atoms ? current : { ...current, [coinType]: atoms };
    if (!(coinType in current)) return current;
    return Object.fromEntries(Object.entries(current).filter(([key]) => key !== coinType));
  }), []);
  return <Publish value={publish}><Held value={balances}>{children}</Held></Publish>;
}

/** A rail reports the wallet's balance of `coinType`; null while unknown. Unmounting forgets it. Outside the shell it does nothing. */
export function usePublishHeldBalance(coinType: string | null, atoms: bigint | null) {
  const publish = useContext(Publish);
  const key = canonical(coinType);
  useEffect(() => {
    if (publish && key) publish(key, atoms);
  }, [publish, key, atoms]);
  useEffect(() => () => {
    if (publish && key) publish(key, null);
  }, [publish, key]);
}

/** Whether a rail on screen has seen the wallet holding `coinType`: "unknown" until one has read it. */
export function useHeldCoin(coinType: string | null): "holds" | "none" | "unknown" {
  const balances = useContext(Held);
  const key = canonical(coinType);
  const atoms = key ? balances[key] : undefined;
  if (atoms === undefined) return "unknown";
  return atoms > NONE ? "holds" : "none";
}
