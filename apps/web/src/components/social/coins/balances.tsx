"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { invalidateAfter, type ServerChange } from "#web/lib/query/invalidate.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

/**
 * "Balances move" (the live design): every balance on the page reads again
 * after a deposit lands or a withdrawal goes out. `changed` invalidates the
 * balance reads (OA-38: the wallet, the portfolio, the viewer's presales and
 * the transaction log), so each active one reads again once, shared by every
 * surface showing it; `version` still changes each time for anything keyed on
 * it.
 */
type BalanceChange = Extract<ServerChange, { kind: "balances" | "commit" }>;
export type Balances = Readonly<{ version: number; changed: (change?: BalanceChange) => void }>;

const BalancesContext = createContext<Balances>({ version: 0, changed: () => undefined });

export function BalancesProvider({ value, children }: Readonly<{ value: Balances; children: ReactNode }>) {
  return <BalancesContext value={value}>{children}</BalancesContext>;
}

/** The balances' version: changes after a deposit landed or a withdrawal went out. */
export function useBalancesVersion(): number {
  return useContext(BalancesContext).version;
}

/** The shell's balances state: a version and `changed`, which invalidates every balance read (the shell's portfolio among them). */
export function useBalances(refreshPortfolio: () => void): Balances {
  const client = useAppQueryClient();
  const [version, setVersion] = useState(0);
  const latest = useRef(refreshPortfolio);
  useEffect(() => {
    latest.current = refreshPortfolio;
  }, [refreshPortfolio]);
  const changed = useCallback((change: BalanceChange = { kind: "balances" }) => {
    void invalidateAfter(client, change).catch(() => {});
    setVersion((value) => value + 1);
    latest.current();
  }, [client]);
  return useMemo(() => ({ version, changed }), [version, changed]);
}

/** The shell's balances (the coins sheet calls `changed`). */
export function useBalancesContext(): Balances {
  return useContext(BalancesContext);
}
