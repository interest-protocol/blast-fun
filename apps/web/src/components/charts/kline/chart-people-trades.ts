import { createContext } from "react";
import type { PersonTrade } from "./people-bubbles.ts";

/** Recent coin trades already loaded by a page whose activity uses public profiles or wallets. */
export const ChartPeopleTrades = createContext<readonly PersonTrade[] | null>(null);
