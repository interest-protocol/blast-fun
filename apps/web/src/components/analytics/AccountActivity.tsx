"use client";

import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  createAccountActivity,
  type ActivitySession,
} from "./account-activity.ts";

/** Consumes only the account already resolved by SocialSession. */
export function AccountActivity({
  session,
}: Readonly<{ session: ActivitySession | null }>) {
  const [activity] = useState(() => createAccountActivity());
  const mode = session?.mode;
  const accountId = session?.accountId;
  const identity = session?.identity;
  const getAccessToken = useEffectEvent(async () =>
    session?.mode === "privy" ? session.getAccessToken() : null,
  );

  const stop = useRef<(() => void) | null>(null);
  // Cancel the previous identity during commit, before its late token can resume.
  useLayoutEffect(
    () => () => {
      stop.current?.();
      stop.current = null;
    },
    [mode, accountId, identity],
  );
  useEffect(() => {
    if (!mode || !accountId || !identity) {
      return;
    }
    const owner = { accountId, identity };
    const cleanup = activity.subscribe(
      mode === "privy"
        ? { ...owner, mode, getAccessToken }
        : { ...owner, mode },
      document,
    );
    stop.current = cleanup;
    return cleanup;
  }, [activity, mode, accountId, identity]);
  return null;
}
