"use client";

import { useCallback, useState } from "react";

import type { AppShellProps } from "#web/components/blast-ui/AppShell.tsx";

export type HeaderSession = Required<Pick<AppShellProps, "signedIn" | "viewer" | "viewerLoading" | "viewerError">>;

/** Use the verified server answer only until the browser's first session resolution. */
export function useHeaderSession(
  initial: HeaderSession | null,
  live: HeaderSession,
  signOut?: () => Promise<void>,
): HeaderSession & Pick<AppShellProps, "onSignOut"> {
  const [resolved, setResolved] = useState(false);
  if (!resolved && !live.viewerLoading) setResolved(true);
  const onSignOut = useCallback(async () => {
    await signOut?.();
    setResolved(true);
  }, [signOut]);
  return { ...(!resolved && live.viewerLoading && initial ? initial : live), onSignOut: signOut ? onSignOut : undefined };
}
