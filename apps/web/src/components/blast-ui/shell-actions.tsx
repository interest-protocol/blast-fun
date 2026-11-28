"use client";

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

import type { ShellActionName } from "./nav.ts";

export type { ShellActionName } from "./nav.ts";

/**
 * The overlays the shell opens but later sections build (FEATURE-MAP §8, §12,
 * §14.1, §15). The shell's buttons and keyboard shortcuts call these by name;
 * a section mounts its overlay anywhere under the shell and registers the
 * opener with `useShellAction`. With nothing registered:
 *
 * - `openSignIn` falls back to the `/sign-in` page (the control is a link);
 * - `openSearch` (rail Search, top-bar search icon, `/`), `openNotifications`
 *   (the rail and top-bar bell while there is no notifications page),
 *   `openFund` (the header), `openDeposit` (the portfolio card's Deposit, Settings' Deposit), `openWithdraw` (Settings'
 *   Withdraw), `openBridge` (Bridge beside them) and `openCoin` (a coin row of the profile's holdings) do nothing.
 *
 * An action may take one argument: `openCoin`
 * the coin's key (UI-14), `openTrade` the side and the sale's coin
 * (`coins/swap-model.ts` `encodeTradeAction`, R3-34; none opens the plain
 * swap, USDC for SUI: Blast mode's dock Swap).
 */

/** A registered action: the argument is the caller's (a coin key), or none. */
export type ShellActionHandler = (argument?: string) => void;

type Registry = Readonly<{
  register: (name: ShellActionName, handler: ShellActionHandler) => () => void;
  /** Runs the registered handler with `argument`; false when none is registered. */
  run: (name: ShellActionName, argument?: string) => boolean;
}>;

const NO_REGISTRY: Registry = { register: () => () => undefined, run: () => false };
const ShellActionsContext = createContext<Registry>(NO_REGISTRY);

/** Provides the registry; the app shell mounts it. */
export function ShellActionsProvider({ children }: Readonly<{ children: ReactNode }>) {
  const handlers = useRef(new Map<ShellActionName, ShellActionHandler>());
  const registry = useMemo<Registry>(
    () => ({
      register(name, handler) {
        handlers.current.set(name, handler);
        return () => {
          if (handlers.current.get(name) === handler) handlers.current.delete(name);
        };
      },
      run(name, argument) {
        const handler = handlers.current.get(name);
        if (!handler) return false;
        handler(argument);
        return true;
      },
    }),
    [],
  );
  return <ShellActionsContext value={registry}>{children}</ShellActionsContext>;
}

/** Runs shell actions by name (the rail, top bar and shortcuts use it). */
export function useShellActions(): Registry["run"] {
  return useContext(ShellActionsContext).run;
}

/** Registers `handler` as the shell's `name` action while the caller is mounted. */
export function useShellAction(name: ShellActionName, handler: ShellActionHandler): void {
  const { register } = useContext(ShellActionsContext);
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  }, [handler]);
  useEffect(() => register(name, (argument) => latest.current(argument)), [name, register]);
}
