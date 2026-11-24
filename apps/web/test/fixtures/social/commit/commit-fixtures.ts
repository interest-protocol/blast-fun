import { fixtureDetail } from "../../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import type { CommitSale, CommitViewer } from "@blast/core/modules/social/commit/quote.ts";

import type { CommitFacts } from "#web/components/social/commit/commit-kit.ts";

/**
 * Test facts for the commit suites, in the gate's own figures: Tidal
 * (`TIDE`) at $0.004, so `$50` is `≈ 12,500 TIDE`; a $10 minimum and a $20,000
 * wallet cap; Kai with $860 USDC. **Tests only**: nothing outside a
 * `*.test.ts(x)` imports this file.
 */

export const STORY_NOW = Date.UTC(2026, 9, 4, 17, 0, 0);

export const TIDE: CommitSale = Object.freeze({
  presaleId: "0x7ide",
  name: "Tidal",
  symbol: "TIDE",
  lifecycle: "open",
  endMs: STORY_NOW + 60 * 60 * 1_000,
  quoteCoin: "USDC",
  minCommitment: 10,
  walletCap: 20_000,
  allowlisted: false,
  raised: 300_000,
  target: 400_000,
  presalePrice: 0.004,
});

export const KAI: CommitViewer = Object.freeze({ usdc: 860, sui: 120, suiUsd: 3.42, committed: 0, allowlist: null });

export function tideFacts(overrides: Readonly<{ sale?: Partial<CommitSale>; viewer?: Partial<CommitViewer>; blockers?: CommitFacts["blockers"] }> = {}): CommitFacts {
  return {
    detail: fixtureDetail("tide"),
    sale: { ...TIDE, ...overrides.sale },
    viewer: { ...KAI, ...overrides.viewer },
    blockers: overrides.blockers ?? [],
    proof: null,
    wallet: null,
  };
}
