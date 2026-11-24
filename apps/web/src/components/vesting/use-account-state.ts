import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { SocialViewer } from "#web/components/social/SignInGate.tsx";

export function vestingAccountKey(viewer: SocialViewer, wallet: string | null) {
  if (!viewer.signedIn) return null;
  // Privy's principal exists before /me resolves. Cookie sessions share the
  // literal "wallet" principal, so distinguish those by their signing address.
  if (viewer.sessionIdentity && viewer.sessionIdentity !== "wallet")
    return `privy:${viewer.sessionIdentity}`;
  return wallet ? `wallet:${wallet}` : null;
}

/** Retain recovery for its owner without exposing it to another signed-in account.
 * Setters capture the owner, so a late response also updates only that account.
 */
export function useVestingAccountState<T>(owner: string | null, initial: T, adoptVisitor = false) {
  const key = JSON.stringify(owner);
  const [states, setStates] = useState<Record<string, T>>({});
  const visitor = adoptVisitor && owner !== null && "null" in states ? states.null! : initial;
  const value = key in states ? states[key]! : visitor;
  // Move an entered visitor draft into its first account before paint. Consume
  // it so another account cannot inherit that account's original visitor input.
  if (adoptVisitor && owner !== null && !(key in states) && "null" in states) {
    const next = { ...states, [key]: states.null! };
    delete next.null;
    setStates(next);
  }
  const setValue: Dispatch<SetStateAction<T>> = useCallback((next) => {
    setStates((previous) => {
      const current = key in previous ? previous[key]! : initial;
      const updated = typeof next === "function"
        ? (next as (value: T) => T)(current)
        : next;
      if (Object.is(current, updated)) return previous;
      return {
        ...previous,
        [key]: updated,
      };
    });
  }, [key, initial]);
  return [value, setValue] as const;
}
