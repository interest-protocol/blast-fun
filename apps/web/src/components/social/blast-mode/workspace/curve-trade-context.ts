"use client";

import { createContext } from "react";

import type { CurveTradeSetup } from "#web/components/launchpad/trade/server-availability.ts";

/**
 * The request's curve trading setup, from the app layout through `SocialShell`
 * and `BlastModeHost`: a coin panel mounts the coin page's curve rail for a
 * live bonding-curve coin with it. Null while the launchpad is off (and in
 * tests that do not supply one): every panel keeps the aggregator box.
 */
export const CurveTradeSetupContext = createContext<CurveTradeSetup | null>(null);
