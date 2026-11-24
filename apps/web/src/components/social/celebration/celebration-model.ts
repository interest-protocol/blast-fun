import { venueName } from "@blast/core/web/format.ts";
import type { HappeningPresale, SocialHappeningResponse } from "@blast/core/web/contracts/happening.ts";
import type { FeedItemPresale } from "@blast/core/web/contracts/items.ts";

import { PRESALES_PATH } from "#web/components/blast-ui/nav.ts";

import { presaleHref } from "../feed-ui/shell-bridge-model";
import { blastModeCovering } from "../blast-mode/live/mode-cover";

/**
 * Live presale notices: lifecycle changes, concise copy, and device memory.
 * Pure, so every rule is tested once.
 */

/**
 * Whether the page's own celebration may play now. Not while Blast mode
 * covers the page: the mode already announces its own moves.
 */
export function pageCelebrates(): boolean {
  return !blastModeCovering();
}

/** Lifecycles that mean "closed funded" (a funded sale may already have migrated by the next read). */
const FUNDED = new Set(["funded", "migrated"]);

/**
 * The presales Home showed open that became funded or migrated, and funded
 * presales that migrated between reads this tab saw. First reads and cancelled
 * closes do not announce anything.
 */
export function fundedSince(previous: SocialHappeningResponse | null, next: SocialHappeningResponse): HappeningPresale[] {
  if (!previous) return [];
  const lifecycles = new Map(
    [...previous.today, ...previous.fastest].map((row) => [row.presale.presale_id, row.presale.lifecycle]),
  );
  const seen = new Set<string>();
  return next.today.filter((row) => {
    const id = row.presale.presale_id;
    const before = lifecycles.get(id);
    const after = row.presale.lifecycle;
    if (!(before === "open" && FUNDED.has(after) || before === "funded" && after === "migrated") || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Keep a busy live batch to one notice, with lifecycle-accurate copy. */
export function presaleNotice(presales: readonly FeedItemPresale[]) {
  const presale = presales[0];
  if (!presale) return null;
  if (presales.length > 1) {
    const migrated = presales.every((sale) => sale.lifecycle === "migrated");
    const funded = presales.every((sale) => sale.lifecycle === "funded");
    return {
      title: `${presales.length} presales ${migrated ? "migrated" : funded ? "funded" : "updated"}`,
      sub: `${presales.slice(0, 2).map((sale) => sale.name).join(", ")}${presales.length > 2 ? ` and ${presales.length - 2} more` : ""}. View their latest status.`,
      href: PRESALES_PATH,
      link: "View presales",
    };
  }
  return {
    title: `${presale.name} ${presale.lifecycle === "migrated" ? "has migrated" : "is funded"}`,
    sub: presale.lifecycle === "migrated" ? `Migrated to ${venueName(presale.venue)}. View trading and claim details.` : "Funding complete. The pool has not launched yet.",
    href: presaleHref(presale.presale_id),
    link: `View ${presale.symbol}`,
  };
}

/** Where this device remembers the sales it celebrated (the prototype's `blast.<name>` keys, JSON). */
export const CELEBRATED_KEY = "blast.celebrated";
/** It keeps the latest this many. */
export const CELEBRATED_MAX = 100;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** The sales this device celebrated; anything unreadable is none. */
export function readCelebrated(storage: Storage | null): string[] {
  try {
    const raw = storage?.getItem(CELEBRATED_KEY);
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Remembers `presaleId` as celebrated and says whether it is new: false when
 * this device already celebrated it (never twice). Storage that refuses
 * writes still answers from what it read; the caller keeps a per-tab set too.
 */
export function rememberCelebrated(storage: Storage | null, presaleId: string): boolean {
  const known = readCelebrated(storage);
  if (known.includes(presaleId)) return false;
  try {
    storage?.setItem(CELEBRATED_KEY, JSON.stringify([...known, presaleId].slice(-CELEBRATED_MAX)));
  } catch {
    // Private windows may refuse; the tab's own set still holds.
  }
  return true;
}
