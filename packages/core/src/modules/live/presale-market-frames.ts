import { z } from "zod";

import { COIN_TYPE_WITH_GENERICS, SUI_OBJECT_ID_PATTERN } from "../../lib/sui/ids.ts";
import { EVENT_CURSOR } from "../launchpad-contract/cursor.ts";
import { POOL_KEY } from "../launchpad-contract/venues.ts";

const atoms = z.string().regex(/^[1-9][0-9]{0,19}$/);
const fields = {
  presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
  cursor: z.string().regex(EVENT_CURSOR).max(60),
  timestamp_ms: z.number().int().positive().max(8_640_000_000_000_000),
  coin_atoms: atoms,
  quote_atoms: atoms,
};

/** The public display fields of a committed sale trade or actual migration-pool swap. */
export const presaleMarketFrameSchema = z.discriminatedUnion("type", [
  z.object({
    ...fields,
    type: z.literal("presale_trade"),
    kind: z.enum(["trade_buy", "trade_sell"]),
    actor: z.string().regex(SUI_OBJECT_ID_PATTERN),
    digest: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    quote_type: z.string().max(2_048).regex(COIN_TYPE_WITH_GENERICS),
    usd: z.string().regex(/^[0-9]+(?:\.[0-9]{1,18})?$/).max(64).nullable(),
  }),
  z.object({
    ...fields,
    type: z.literal("presale_pool_swap"),
    pool_key: z.string().regex(POOL_KEY),
    side: z.enum(["buy", "sell"]),
  }),
]);

export type PresaleMarketFrame = Readonly<z.infer<typeof presaleMarketFrameSchema>>;
export type PresaleMarketTrade = Extract<PresaleMarketFrame, { type: "presale_trade" }>;
export type PresalePoolSwap = Extract<PresaleMarketFrame, { type: "presale_pool_swap" }>;
