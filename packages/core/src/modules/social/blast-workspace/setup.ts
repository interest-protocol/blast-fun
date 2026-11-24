import { z } from "zod";
import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import { WorkspaceLayoutSchema } from "./workspace-layout-model.ts";
import { PRICE_WINDOWS } from "../contracts/prices.ts";
import { CANDLE_INTERVALS } from "../../launchpad-contract/venue-history.ts";
import { DISCOVERY_VIEWS } from "../../launchpad-contract/discovery-views.ts";

export const DATA_VIEWS = [
  "Coins",
  "Presales",
  "Bonding",
  "Traders",
  "Activity",
  "Feed",
  "Portfolio",
] as const;
export type DataView = (typeof DATA_VIEWS)[number];
/** The Sui networks a saved workspace may name. */
export const NETWORKS = ["mainnet", "testnet", "devnet", "localnet"] as const;
export type Network = (typeof NETWORKS)[number];
const id = z.string().min(1);
const coinType = id
  .refine(isValidStructTag, "Invalid Sui coin type")
  .transform(normalizeStructTag);
const navigation = z.strictObject({
  scroll_top: z.number().finite().nonnegative(),
  expanded_ids: z.array(id),
});
const listNavigation = navigation.extend({
  anchor: z
    .strictObject({
      coin_type: coinType,
      index: z.number().int().nonnegative(),
      offset: z.number().finite(),
    })
    .nullable()
    .optional(),
});
const tabs = z.strictObject({
  selected: z.enum(["overview", "people", "activity"]).nullable(),
  enabled: z.array(z.enum(["overview", "people", "activity"])),
});
const viewport = z
  .strictObject({ from_ms: z.number().finite(), to_ms: z.number().finite() })
  .refine((value) => value.from_ms < value.to_ms, "Invalid chart viewport");
const chart = z.discriminatedUnion("renderer", [
  z.strictObject({ renderer: z.literal("sparkline") }),
  z.strictObject({
    renderer: z.literal("recharts"),
    window: z.enum(PRICE_WINDOWS),
    interval: z.enum(CANDLE_INTERVALS).optional(),
    style: z.enum(["line", "candles"]).optional(),
    volume: z.boolean().optional(),
    viewport: viewport.nullable(),
  }),
]);
const sideDraft = z.strictObject({
  typed: z.string(),
  mode: z.enum(["typed", "all", "half", "quarter"]),
  unit: z.enum(["usd", "token"]).optional(),
});
const trade = z.strictObject({
  side: z.enum(["buy", "sell"]),
  buy: sideDraft,
  sell: sideDraft,
  slippage_bps: z.number().int().min(1).max(500),
});
const namespace = { tabs, chart, trade, navigation };
export const PanelSchema = z.strictObject({
  panel_id: id,
  chain: z.literal("sui"),
  network: z.enum(NETWORKS),
  coin_type: coinType,
  presale_id: id.nullable(),
  active_namespace: z.enum(["coin", "presale"]),
  coin: z.strictObject({...namespace,tabs:z.strictObject({
    selected:z.enum(["overview","people","activity","posts"]).nullable(),
    enabled:z.array(z.enum(["overview","people","activity","posts"])),
  })}),
  presale: z.strictObject({
    ...namespace,
    tabs: z.strictObject({ selected: z.enum(["overview", "people", "activity", "posts"]).nullable(), enabled: z.array(z.enum(["overview", "people", "activity", "posts"])) }),
    views_version: z.literal(2).optional(),
    terms_open: z.boolean(),
    friends_all: z.boolean(),
    commitment: z.strictObject({
      amount: z.string(),
      why: z.string().max(280 * 4),
      payment_coin_type: coinType.nullable(),
    }),
  }),
});
export const PanelPatchSchema = PanelSchema.pick({
  active_namespace: true,
  coin: true,
  presale: true,
}).partial();
const page = z.number().int().min(1).max(9999);
const rows = z.union([z.literal(5), z.literal(10), z.literal(20)]);
const window = z.enum(["1h", "24h"]);
const list = z.strictObject({ search: z.string().max(200), page });
export const DataControlsSchema = z.strictObject({
  Coins: z.strictObject({
    source: z.enum(["discover", "following", "watchlist"]),
    sort: z.enum(["relevant", "trending", "newest", "held"]),
    window,
    min_participants: z.union([
      z.literal(0),
      z.literal(2),
      z.literal(5),
      z.literal(10),
    ]),
    age: z.enum(["24h", "7d", "30d", "all"]),
    tradable: z.boolean(),
    page,
    rows,
    live: z.boolean(),
    navigation: listNavigation,
  }),
  Presales: z.strictObject({
    window: window.optional(),
    page: page.optional(),
    rows: rows.optional(),
    status: z.enum(["live", "upcoming", "ended"]),
    sort: z.enum(["ending", "backed", "opening", "interest", "recent", "best"]),
    scope: z.enum(["all", "watch", "following"]),
    view: z.enum(["list", "calendar", "backed", "mine"]),
    layout: z.enum(["list", "cards"]),
    calendar_range: z.enum(["past", "all", "upcoming"]),
    navigation: listNavigation,
  }),
  // Launchpad curves by stage (`GET /api/launchpad/discovery?view=`). Optional in a saved setup (those from before the view parse with its defaults); always present once parsed.
  Bonding: z.strictObject({
    view: z.enum(DISCOVERY_VIEWS),
    navigation,
  }).default(() => ({ view: "new" as const, navigation: { scroll_top: 0, expanded_ids: [] } })),
  Traders: z.strictObject({
    window,
    search: z.string().max(128),
    search_draft: z.string().max(128),
    page,
    rows,
    live: z.boolean(),
    navigation: navigation.extend({
      anchor: z
        .strictObject({
          actor_key: id,
          index: z.number().int().nonnegative(),
          offset: z.number().finite(),
        })
        .nullable()
        .optional(),
    }),
  }),
  Activity: z.strictObject({
    window,
    kinds: z.array(
      z.enum(["trade_buy", "trade_sell", "presale_commit", "presale_claim"]),
    ),
    page: page.optional(),
    rows: rows.optional(),
    cursors: z.array(z.string().min(1).nullable()).optional(),
    navigation: navigation.extend({
      anchor: z.strictObject({
        entry_id: id,
        index: z.number().int().nonnegative(),
        offset: z.number().finite(),
      }).nullable().optional(),
    }),
  }),
  Feed: z.strictObject({
    tab: z.literal("for_you"),
    page: page.optional(),
    rows: rows.optional(),
    cursors: z.array(z.string().min(1).nullable()).optional(),
    navigation: navigation.extend({
      anchor: z.strictObject({
        entry_id: id,
        index: z.number().int().nonnegative(),
        offset: z.number().finite(),
      }).nullable().optional(),
    }),
  }),
  Portfolio: z.strictObject({
    tab: z.enum(["summary", "coins", "presales"]),
    coins: z.strictObject({ ...list.shape, hide_small: z.boolean() }),
    presales: list,
    navigation: navigation.extend({
      anchor: z.strictObject({
        row_id: id,
        index: z.number().int().nonnegative(),
        offset: z.number().finite(),
      }).nullable().optional(),
    }),
  }),
});
export const WorkspaceSchema = z.strictObject({
  schema_version: z.literal(1),
  presentation: z.enum(["focus", "compare"]).optional(),
  layout: WorkspaceLayoutSchema.optional(),
  panels: z.record(id, PanelSchema),
  visible_order: z.array(id),
  retained_order: z.array(id),
  desktop_capacity: z.number().int().min(1).max(4),
  desktop_slots: z.array(id.nullable()).optional(),
  focused_panel_id: id.nullable(),
  mobile_panel_id: id.nullable(),
  data: z.strictObject({
    selected_view: z.enum(DATA_VIEWS).nullable(),
    enabled_views: z.array(z.enum(DATA_VIEWS)),
    collapsed: z.boolean(),
    controls: DataControlsSchema,
  }),
});
type Immutable<T> = T extends object
  ? { readonly [K in keyof T]: Immutable<T[K]> }
  : T;
export type WorkspaceV1 = Immutable<z.infer<typeof WorkspaceSchema>>;
export type PanelSetup = WorkspaceV1["panels"][string];
export type PanelInput = Pick<
  PanelSetup,
  "panel_id" | "chain" | "network" | "coin_type" | "presale_id"
>;
export type PanelPatch = Partial<
  Pick<PanelSetup, "active_namespace" | "coin" | "presale">
>;
export type DataControls = WorkspaceV1["data"]["controls"];

const nav = () => ({ scroll_top: 0, expanded_ids: [] });
const panelNamespace = () => ({
  tabs: { selected: "overview", enabled: ["overview", "people", "activity"] },
  chart: { renderer: "recharts", window: "24h", viewport: null },
  trade: {
    side: "buy",
    buy: { typed: "", mode: "typed" },
    sell: { typed: "", mode: "typed", unit: "token" },
    slippage_bps: 50,
  },
  navigation: nav(),
});

export function newPanel(input: PanelInput): PanelSetup {
  return PanelSchema.parse({
    ...input,
    active_namespace: input.presale_id === null ? "coin" : "presale",
    coin: {...panelNamespace(),tabs:{selected:"overview",enabled:["overview","people","activity","posts"]}},
    presale: {
      ...panelNamespace(),
      tabs: { selected: "overview", enabled: ["overview", "activity", "posts"] },
      views_version: 2,
      terms_open: false,
      friends_all: false,
      commitment: { amount: "", why: "", payment_coin_type: null },
    },
  });
}

export function emptyWorkspace(): WorkspaceV1 {
  return WorkspaceSchema.parse({
    schema_version: 1,
    presentation: "focus",
    panels: {},
    visible_order: [],
    retained_order: [],
    desktop_capacity: 4,
    desktop_slots: [null, null, null, null],
    focused_panel_id: null,
    mobile_panel_id: null,
    data: {
      selected_view: "Coins",
      // Every view starts enabled, Posts (the Feed view) included: the owner wants posts discoverable in Blast mode (2026-10-27).
      enabled_views: [...DATA_VIEWS],
      collapsed: false,
      controls: {
        Coins: {
          source: "discover",
          sort: "trending",
          window: "24h",
          min_participants: 0,
          age: "all",
          tradable: false,
          page: 1,
          rows: 10,
          live: true,
          navigation: nav(),
        },
        Presales: {
          status: "live",
          sort: "ending",
          scope: "all",
          view: "list",
          layout: "cards",
          calendar_range: "upcoming",
          navigation: nav(),
        },
        Bonding: { view: "new", navigation: nav() },
        Traders: {
          window: "24h",
          search: "",
          search_draft: "",
          page: 1,
          rows: 5,
          live: true,
          navigation: nav(),
        },
        Activity: { window: "24h", kinds: [], navigation: nav() },
        Feed: { tab: "for_you", navigation: nav() },
        Portfolio: {
          tab: "summary",
          coins: { search: "", page: 1, hide_small: false },
          presales: { search: "", page: 1 },
          navigation: nav(),
        },
      },
    },
  });
}
