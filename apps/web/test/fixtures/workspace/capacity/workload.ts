import {
  validateWorkspace,
  type WorkspaceWriteEnvelope,
} from "@blast/core/modules/social/blast-workspace/codec.ts";
import {
  emptyWorkspace,
  newPanel,
  type WorkspaceV1,
} from "@blast/core/modules/social/blast-workspace/setup.ts";

export const CAPACITY_COUNTS = [8, 35, 100] as const;
export const CAPACITY_SAMPLES = 5;
export const utf8Bytes = (value: string) =>
  new TextEncoder().encode(value).byteLength;

/** Synthetic complete setups, not a measured product traffic distribution. */
export function createCapacityWorkspace(count: number): WorkspaceV1 {
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error("Measurement workload must contain 1–100 panels");
  }
  const workspace = emptyWorkspace();
  const panels = Object.fromEntries(
    Array.from({ length: count }, (_, n) => {
      const panel = newPanel({
        panel_id: `capacity-${n}`,
        chain: "sui",
        network: "mainnet",
        coin_type: `0x2::capacity::C${n}`,
        presale_id: n % 2 ? `0x${(n + 1).toString(16)}` : null,
      });
      return [
        panel.panel_id,
        {
          ...panel,
          coin: {
            ...panel.coin,
            trade: {
              ...panel.coin.trade,
              side: n % 2 ? "sell" : "buy",
              buy: { typed: "00042.000000001", mode: "typed" },
              sell: { typed: "0.000000007", mode: "half" },
              slippage_bps: 125,
            },
            navigation: { scroll_top: n * 17, expanded_ids: [`coin-row-${n}`] },
          },
          presale: {
            ...panel.presale,
            terms_open: n % 2 === 1,
            friends_all: n % 3 === 0,
            trade: {
              ...panel.presale.trade,
              side: "sell",
              buy: { typed: "00015.", mode: "typed" },
              sell: { typed: "0.00025", mode: "all" },
            },
            commitment: {
              amount: "00025.000",
              why: "Synthetic research note · 雪 · separate namespace",
              payment_coin_type: "0x2::sui::SUI",
            },
            navigation: {
              scroll_top: n * 29,
              expanded_ids: [`presale-row-${n}`],
            },
          },
        },
      ];
    }),
  );
  const order = Object.keys(panels).reverse();
  const controls = workspace.data.controls;
  return validateWorkspace({
    ...workspace,
    panels,
    desktop_slots: Array.from({ length: workspace.desktop_capacity }, (_, index) => order[index] ?? null),
    visible_order: order.slice(0, 4),
    retained_order: order.slice(4),
    focused_panel_id: order[0],
    mobile_panel_id: order[0],
    data: {
      ...workspace.data,
      selected_view: "Portfolio",
      controls: {
        Coins: {
          ...controls.Coins,
          source: "watchlist",
          sort: "newest",
          min_participants: 5,
          age: "7d",
          tradable: true,
          page: 7,
          rows: 20,
          live: false,
          navigation: { scroll_top: 312, expanded_ids: ["coin-expanded"] },
        },
        Presales: {
          ...controls.Presales,
          status: "ended",
          sort: "backed",
          scope: "following",
          view: "calendar",
          layout: "list",
          calendar_range: "past",
          page: 4,
          rows: 5,
        },
        Traders: {
          ...controls.Traders,
          search: "雪 trader",
          search_draft: "雪 trader draft",
          window: "1h",
          page: 8,
          rows: 20,
          live: false,
          navigation: {
            scroll_top: 200,
            expanded_ids: ["actor-row"],
            anchor: { actor_key: "synthetic-actor", index: 2, offset: 12 },
          },
        },
        Activity: {
          ...controls.Activity,
          window: "1h",
          kinds: ["trade_sell", "presale_commit"],
          page: 3,
          rows: 5,
          cursors: [null, "synthetic-activity-2", "synthetic-activity-3"],
        },
        Feed: {
          ...controls.Feed,
          page: 2,
          rows: 20,
          cursors: [null, "synthetic-feed-2"],
        },
        Portfolio: {
          ...controls.Portfolio,
          tab: "presales",
          coins: { search: "coins 雪", page: 6, hide_small: true },
          presales: { search: "presales exact", page: 9 },
        },
      },
    },
  });
}

export function capacityEnvelope(
  workspace: WorkspaceV1,
  sequence: number,
  writerId: string,
): WorkspaceWriteEnvelope {
  return {
    initialize_if_absent: false,
    writer_id: writerId,
    sequence,
    workspace,
  };
}

/** Deliberately artificial boundary case; do not call this a realistic draft. */
export function exactEnvelope(
  targetBytes: number,
  writerId = "t018-boundary",
): WorkspaceWriteEnvelope {
  const workspace = createCapacityWorkspace(35);
  const id = workspace.visible_order[0]!;
  const panel = workspace.panels[id]!;
  const envelope = capacityEnvelope(
    {
      ...workspace,
      panels: {
        ...workspace.panels,
        [id]: {
          ...panel,
          coin: {
            ...panel.coin,
            trade: { ...panel.coin.trade, buy: { typed: "", mode: "typed" } },
          },
        },
      },
    },
    1,
    writerId,
  );
  const padding = targetBytes - utf8Bytes(JSON.stringify(envelope));
  if (padding < 0) throw new Error("Target smaller than base workload");
  return {
    ...envelope,
    workspace: validateWorkspace({
      ...envelope.workspace,
      panels: {
        ...envelope.workspace.panels,
        [id]: {
          ...envelope.workspace.panels[id]!,
          coin: {
            ...panel.coin,
            trade: {
              ...panel.coin.trade,
              buy: { typed: "7".repeat(padding), mode: "typed" },
            },
          },
        },
      },
    }),
  };
}

/** Stable ordering lets browser/private readback and JSONB compare without emitting content. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
