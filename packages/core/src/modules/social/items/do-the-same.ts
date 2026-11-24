import { DO_THE_SAME_LABELS, type DoTheSame } from "../contracts/items.ts";
import { LIFECYCLE_ENTRY_KINDS, MILESTONE_ENTRY_KINDS } from "../contracts/feed-entries.ts";
import { saleIsLive } from "../read-model/chain-presales.ts";
import { TRADE_ENTRY_KINDS } from "../read-model/naming.ts";

/** What the descriptor needs of an item's presale (`chain_read_v1.presales`). */
export type DoTheSamePresale = Readonly<{ presale_id: string; lifecycle: string; start_ms: number; end_ms: number }>;

/** Kinds whose action is committing to their presale: commits, claims, lifecycle and milestone posts. */
const COMMIT_KINDS: ReadonlySet<string> = new Set<string>([
  "presale_commit",
  "presale_claim",
  ...LIFECYCLE_ENTRY_KINDS,
  ...MILESTONE_ENTRY_KINDS,
]);
const TRADE_KINDS: ReadonlySet<string> = new Set<string>(TRADE_ENTRY_KINDS);

/** The presale page a disabled descriptor links to. */
export function presalePath(presaleId: string): string {
  return `/presale/${presaleId}`;
}

function viewSale(kind: string, presaleId: string): DoTheSame {
  return { kind, enabled: false, label: DO_THE_SAME_LABELS.view, href: presalePath(presaleId) };
}

/**
 * The "do the same" action of an item of `kind` in `presale` at `nowMs`, or
 * null when the item has none (an unknown kind, or no presale).
 *
 * - Commit, claim, lifecycle and milestone items: "Blast" (enabled, no
 *   href) while the presale takes commitments (`saleIsLive`); otherwise
 *   (pending, open before its start, funded, cancelled, migrated, an ended open
 *   sale, or a lifecycle not known yet) "View presale", disabled, linking
 *   `/presale/{id}`.
 * - Trades (which exist only once a presale migrated): "View presale" of kind
 *   `buy`, disabled. A later swap ticket turns migrated presales into "Buy too".
 *
 * The watcher matches a registered intent's action against this descriptor.
 */
export function doTheSameDescriptor(kind: string, presale: DoTheSamePresale | null, nowMs: number): DoTheSame | null {
  if (!presale) return null;
  if (COMMIT_KINDS.has(kind)) {
    return saleIsLive(presale, nowMs)
      ? { kind: "commit", enabled: true, label: DO_THE_SAME_LABELS.commit, href: null }
      : viewSale("commit", presale.presale_id);
  }
  if (TRADE_KINDS.has(kind)) return viewSale("buy", presale.presale_id);
  return null;
}
