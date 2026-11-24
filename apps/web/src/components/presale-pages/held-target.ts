import { viaEntryOf } from "#web/components/social/commit/commit-view.ts";
import type { HeldBlastTarget } from "#web/components/social/commit/use-held-blast.ts";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";
import { bpsRatio } from "@blast/core/lib/bps.ts";

/**
 * The sale as hold to blast reads it (R3-13): open while its phase is, the
 * raise's fill for where the ball lands, and the post a shared link came
 * through (`?via=`, T-024) credited at the release, as the dialog credits it.
 */
export function heldTargetOfSale(sale: SocialPresaleDetail["presale"]): HeldBlastTarget {
  return {
    presaleId: sale.presale_id,
    name: sale.name,
    open: sale.phase === "open",
    fill: Math.min(1, Math.max(0, bpsRatio(sale.fill_bps))),
    source: () => ({ entryId: viaEntryOf(window.location.search), through: null }),
  };
}
