import { z } from "zod";

import { EVENT_CURSOR } from "../launchpad-contract/cursor.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * What of blast-infra's `/v1/ws` crosses to a browser as a hint. Both relays
 * use it: the activity relay (`packages/server/.../hint-relay.ts`) and the
 * market stream relay, which carries the same hints beside a chart's trades.
 *
 * A hint is a signal, not data: "look now" plus the fields that select which
 * reads it affects. Nothing else of the engine's frame crosses, so neither a
 * malformed nor a malicious upstream frame can paint anything; the page reads
 * its own route.
 */

/** A canonical coin type, as blast-infra names one: `0x<64 hex>::<module>::<Name>`. */
const LIFECYCLE_STATES = ["opened", "funded", "migrated", "cancelled"] as const;
type LifecycleState = (typeof LIFECYCLE_STATES)[number];

const presaleTradeHint = z.object({
  kind: z.enum(["trade_buy", "trade_sell"]),
  presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN).nullish().catch(undefined),
  coin_type: z.string().regex(COIN_TYPE).nullish().catch(undefined),
});

export type Hint =
  | Readonly<{ type: "activity"; activity_id: string } & Partial<{ kind: z.infer<typeof presaleTradeHint>["kind"]; presale_id: string; coin_type: string }>>
  | Readonly<{ type: "presale_lifecycle"; presale_id: string; state: LifecycleState }>
  /** A coin's identity (name, symbol, description, icon) changed: blast-infra's `metadata` state message. */
  | Readonly<{ type: "metadata"; coin: string; cursor: string }>;

export const hintSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("activity"), activity_id: z.string().max(128) }),
  z.object({ type: z.literal("presale_lifecycle"), presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN), state: z.enum(LIFECYCLE_STATES) }),
  z.object({ type: z.literal("metadata"), coin: z.string().regex(COIN_TYPE), cursor: z.string().regex(EVENT_CURSOR) }),
]);

/** The hint `frame` becomes in a browser, or null when it carries none. */
export function hintOf(frame: Readonly<Record<string, unknown>>): Hint | null {
  const parsed = hintSchema.safeParse(frame);
  if (!parsed.success) return null;
  if (parsed.data.type === "activity" && EVENT_CURSOR.test(parsed.data.activity_id)) {
    const trade = presaleTradeHint.safeParse(frame);
    if (trade.success) {
      const { kind, presale_id, coin_type } = trade.data;
      if (presale_id) return { ...parsed.data, kind, presale_id };
      if (coin_type) return { ...parsed.data, kind, coin_type };
    }
  }
  return parsed.data;
}
