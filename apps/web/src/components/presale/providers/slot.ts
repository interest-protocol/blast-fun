import type { ReactNode } from "react";

import type { PresaleConfig } from "../config.ts";

export type PresaleSlotProps = Readonly<{
  config: PresaleConfig;
  nonce: string | null;
  /** The request carries a Privy session cookie, so the session's SDK loads at once. */
  privySession?: boolean;
  children: ReactNode;
}>;

export type PresaleShellProps = PresaleSlotProps;

export type PresaleLayoutSlotProps = Omit<PresaleShellProps, "children">;
