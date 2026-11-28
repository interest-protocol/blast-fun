"use client";

import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

type Balances = Readonly<Record<string, bigint>>;

const Held = createContext<Balances>({});
const Publish = createContext<((coinType: string, atoms: bigint) => void) | null>(null);
const NONE = BigInt(0);

const canonical = (coinType: string | null) => (coinType && isValidStructTag(coinType) ? normalizeStructTag(coinType) : null);

/**
 * The connected wallet's balance of each coin a trade rail on screen has read (the curve rail's own read,
 * or a swap side's), so a coin page's price row knows whether the trader holds its coin without reading
 * anything itself. The shell holds it: a sale's rail is in the shell's aside, not under its page.
 * The last read stands until a newer one: a rail that stops reading (a closed phone sheet, a hidden tab,
 * a failed read) or unmounts says nothing new, and two rails on one coin agree because both read the chain.
 */
export function HeldBalanceProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [balances, setBalances] = useState<Balances>({});
  const publish = useCallback((coinType: string, atoms: bigint) => setBalances((current) => (
    current[coinType] === atoms ? current : { ...current, [coinType]: atoms }
  )), []);
  return <Publish value={publish}><Held value={balances}>{children}</Held></Publish>;
}

/** A rail reports the wallet's balance of `coinType` once it has read one; null says nothing new. Outside the shell it does nothing. */
export function usePublishHeldBalance(coinType: string | null, atoms: bigint | null) {
  const publish = useContext(Publish);
  const key = canonical(coinType);
  useEffect(() => {
    if (publish && key && atoms !== null) publish(key, atoms);
  }, [publish, key, atoms]);
}

/** Whether a rail on screen has seen the wallet holding `coinType`: "unknown" until one has read it. */
export function useHeldCoin(coinType: string | null): "holds" | "none" | "unknown" {
  const balances = useContext(Held);
  const key = canonical(coinType);
  const atoms = key ? balances[key] : undefined;
  if (atoms === undefined) return "unknown";
  return atoms > NONE ? "holds" : "none";
}
