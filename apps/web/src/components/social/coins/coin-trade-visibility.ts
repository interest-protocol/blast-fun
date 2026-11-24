"use client";

import { createContext } from "react";

/** A retained coin-page trade panel may be mounted while its mobile sheet is closed. */
export const CoinTradeVisibility = createContext(true);
