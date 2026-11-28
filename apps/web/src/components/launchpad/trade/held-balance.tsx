"use client";

import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useSocialViewer } from "#web/components/social/SignInGate.tsx";

type Balances = Readonly<Record<string, bigint>>;

const Held = createContext<Balances>({});
const Publish = createContext<((coinType: string, atoms: bigint) => void) | null>(null);
const NONE = BigInt(0);
const EMPTY: Balances = {};

type Owner = Readonly<{ session: string | null; callsign: string | null }>;

/** One signed-in account: a session or callsign known on both sides must match; one not yet known matches. */
function sameOwner(stored: Owner | null, now: Owner | null): boolean {
  if (!stored || !now) return false;
  const agree = (a: string | null, b: string | null) => a === null || b === null || a === b;
  return agree(stored.session, now.session) && agree(stored.callsign, now.callsign);
}

const canonical = (coinType: string | null) => (coinType && isValidStructTag(coinType) ? normalizeStructTag(coinType) : null);

/**
 * The connected wallet's balance of each coin a trade rail on screen has read (the curve rail's own read,
 * or a swap side's), so a coin page's price row knows whether the trader holds its coin without reading
 * anything itself. The shell holds it: a sale's rail is in the shell's aside, not under its page.
 * The last read stands until a newer one: a rail that stops reading (a closed phone sheet, a hidden tab,
 * a failed read) or unmounts says nothing new, and two rails on one coin agree because both read the chain.
 * Every read belongs to the signed-in account: another account starts empty, so it never reads for a coin
 * only the last one held. Same account as the viewer cache scope: a session or callsign arriving later is
 * the same viewer.
 */
export function HeldBalanceProvider({ children }: Readonly<{ children: ReactNode }>) {
  const viewer = useSocialViewer();
  const owner: Owner | null = viewer.signedIn ? { session: viewer.sessionIdentity ?? null, callsign: viewer.callsign } : null;
  const [store, setStore] = useState<Readonly<{ owner: Owner | null; balances: Balances }>>({ owner, balances: EMPTY });
  const balances = sameOwner(store.owner, owner) ? store.balances : EMPTY;
  // Rails publish from passive effects, after this layout effect: a read lands with the account it was made for.
  // A ref, not a dependency, so a new account does not make every rail publish its last account's balance again.
  const ownerRef = useRef(owner);
  useLayoutEffect(() => {
    ownerRef.current = owner;
  });
  // Made once: a rail's effect depends on it, and must not run again for any other render.
  const [publish] = useState(() => (coinType: string, atoms: bigint) => {
    setStore((current) => {
      const at = ownerRef.current;
      if (!at) return current;
      if (!sameOwner(current.owner, at)) return { owner: at, balances: { [coinType]: atoms } };
      if (current.balances[coinType] === atoms && current.owner?.session === at?.session && current.owner?.callsign === at?.callsign) return current;
      return { owner: at, balances: { ...current.balances, [coinType]: atoms } };
    });
  });
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
