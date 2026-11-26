import { z } from "zod";

import { EVENT_CURSOR } from "../launchpad-contract/cursor.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * What of blast-infra's `/v1/ws` crosses to a browser as a hint. The market
 * stream relay uses it, carrying hints beside a chart's trades.
 *
 * A hint is a signal, not data: "look now" plus the fields that select which
 * reads it affects. Nothing else of the engine's frame crosses, so neither a
 * malformed nor a malicious upstream frame can paint anything; the page reads
 * its own route.
 */

/** A canonical coin type, as blast-infra names one: `0x<64 hex>::<module>::<Name>`. */
const LIFECYCLE_STATES = ["opened", "funded", "migrated", "cancelled"] as const;
type LifecycleState = (typeof LIFECYCLE_STATES)[number];

const U64_MAX = 2n ** 64n - 1n;

const presaleTradeHint = z.object({
  kind: z.enum(["trade_buy", "trade_sell"]),
  presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN).nullish().catch(undefined),
  coin_type: z.string().max(320).regex(COIN_TYPE).nullish().catch(undefined),
  /** The trader's wallet: lets a signed-in tab tell a buy by someone it follows without a read. */
  actor: z.string().regex(SUI_OBJECT_ID_PATTERN).nullish().catch(undefined),
  /** The trade's quote amount in atoms (a u64), its quote coin and its USD value: enough for a buy cue without a read. */
  quote_atoms: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/).refine((value) => BigInt(value) <= U64_MAX).nullish().catch(undefined),
  // Bounded so a hint with every field stays under its 1,024-byte budget.
  quote_type: z.string().max(160).regex(COIN_TYPE).nullish().catch(undefined),
  usd: z.string().max(48).regex(/^(?:0|[1-9][0-9]{0,28})(?:\.[0-9]{1,18})?$/).nullish().catch(undefined),
});

export type Hint =
  | Readonly<{ type: "activity"; activity_id: string } & Partial<{ kind: z.infer<typeof presaleTradeHint>["kind"]; presale_id: string; coin_type: string; actor: string; quote_atoms: string; quote_type: string; usd: string }>>
  | Readonly<{ type: "presale_lifecycle"; presale_id: string; state: LifecycleState }>
  /** A coin's identity (name, symbol, description, icon) changed: blast-infra's `metadata` state message. */
  | Readonly<{ type: "metadata"; coin: string; cursor: string }>;

export const hintSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("activity"), activity_id: z.string().max(128) }),
  z.object({ type: z.literal("presale_lifecycle"), presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN), state: z.enum(LIFECYCLE_STATES) }),
  z.object({ type: z.literal("metadata"), coin: z.string().regex(COIN_TYPE), cursor: z.string().regex(EVENT_CURSOR) }),
]);

/** The fields that hold a value. */
function present<T extends Record<string, string | null | undefined>>(fields: T): { [K in keyof T]?: NonNullable<T[K]> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) as { [K in keyof T]?: NonNullable<T[K]> };
}

/** The hint `frame` becomes in a browser, or null when it carries none. */
export function hintOf(frame: Readonly<Record<string, unknown>>): Hint | null {
  const parsed = hintSchema.safeParse(frame);
  if (!parsed.success) return null;
  if (parsed.data.type === "activity" && EVENT_CURSOR.test(parsed.data.activity_id)) {
    const trade = presaleTradeHint.safeParse(frame);
    if (trade.success) {
      const { kind, presale_id, coin_type, actor, quote_atoms, quote_type, usd } = trade.data;
      if (presale_id || coin_type) {
        // A presale's trade names its coin too: Home matches rows by either.
        const fields = { presale_id, coin_type, actor, quote_atoms, quote_type, usd };
        return { ...parsed.data, kind, ...present(fields) };
      }
    }
  }
  return parsed.data;
}
