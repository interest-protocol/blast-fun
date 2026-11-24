"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether this deployment previews TSUI at SUI's price (`testSuiPriceEnabled`, server-only):
 * the page shows TestPricingNotice, and Blast mode, which covers that notice, shows its compact
 * form beside its balance (Blast mode audit 31).
 */
const TestPricingContext = createContext(false);

export function TestPricingProvider({ enabled, children }: Readonly<{ enabled: boolean; children: ReactNode }>) {
  return <TestPricingContext value={enabled}>{children}</TestPricingContext>;
}

export function useTestPricing() {
  return useContext(TestPricingContext);
}
