"use client";

import { createContext, useContext } from "react";

import type { PresaleConfig } from "../config";
import type { PresaleSlotProps } from "./slot";

const PresaleConfigContext = createContext<PresaleConfig | null>(null);

/** Slot 1: makes the server-validated presale configuration available to the tree. */
export function ConfigProvider({ config, children }: PresaleSlotProps) {
  return <PresaleConfigContext value={config}>{children}</PresaleConfigContext>;
}

export function usePresaleConfig(): PresaleConfig {
  const config = useContext(PresaleConfigContext);
  if (!config) throw new Error("usePresaleConfig must be used inside the presale provider root.");
  return config;
}
