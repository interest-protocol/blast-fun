"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";

/**
 * A not-found page under a known path (`/coin/0x1`) belongs to no rail item:
 * it marks itself missing, and while it is mounted the shell shows no current item.
 */
const MissingPageContext = createContext<(missing: boolean) => void>(() => undefined);

export function MissingPageProvider({ onChange, children }: Readonly<{ onChange: (missing: boolean) => void; children: ReactNode }>) {
  return <MissingPageContext value={onChange}>{children}</MissingPageContext>;
}

/**
 * Rendered by a not-found page: the rail and tab bar mark nothing as current while it shows.
 * The hidden marker covers the server's first paint (the shell's CSS reads it); the effect then clears aria-current.
 */
export function MissingPageMarker() {
  const setMissing = useContext(MissingPageContext);
  useEffect(() => {
    setMissing(true);
    return () => setMissing(false);
  }, [setMissing]);
  return <span data-missing-page="" hidden />;
}
