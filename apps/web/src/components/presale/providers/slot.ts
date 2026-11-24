import type { ReactNode } from "react";

import type { PresaleClientConfig, PresaleConfig } from "../config.ts";

export type PresaleSlotProps = Readonly<{
  config: PresaleClientConfig;
  nonce: string | null;
  children: ReactNode;
}>;

export type PresaleShellProps = Omit<PresaleSlotProps, "config"> & Readonly<{ config: PresaleConfig }>;

export type PresaleLayoutSlotProps = Omit<PresaleShellProps, "children">;
