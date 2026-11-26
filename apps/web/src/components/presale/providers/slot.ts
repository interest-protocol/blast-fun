import type { ReactNode } from "react";

import type { PresaleClientConfig, PresaleConfig } from "../config.ts";

export type PresaleSlotProps = Readonly<{
  config: PresaleClientConfig;
  nonce: string | null;
  /** The request carries a Privy session cookie, so the session's SDK loads at once. */
  privySession?: boolean;
  children: ReactNode;
}>;

export type PresaleShellProps = Omit<PresaleSlotProps, "config"> & Readonly<{ config: PresaleConfig }>;

export type PresaleLayoutSlotProps = Omit<PresaleShellProps, "children">;
