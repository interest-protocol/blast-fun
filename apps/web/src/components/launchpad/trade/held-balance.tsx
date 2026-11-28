"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const Held = createContext<bigint | null>(null);
const Publish = createContext<((atoms: bigint | null) => void) | null>(null);

/** A coin page's held balance: the trade rail's own wallet read of the page's coin, shared with the price row. */
export function HeldBalanceProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [atoms, setAtoms] = useState<bigint | null>(null);
  return <Publish value={setAtoms}><Held value={atoms}>{children}</Held></Publish>;
}

/** The rail reports the connected wallet's balance of the page's coin; null while unknown. Outside a coin page it does nothing. */
export function usePublishHeldBalance(atoms: bigint | null) {
  const publish = useContext(Publish);
  useEffect(() => {
    publish?.(atoms);
  }, [publish, atoms]);
  useEffect(() => () => publish?.(null), [publish]);
}

const NONE = BigInt(0);

/** True once the rail has read a positive balance of the page's coin. */
export function useHoldsPageCoin(): boolean {
  const atoms = useContext(Held);
  return atoms !== null && atoms > NONE;
}
