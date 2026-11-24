import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import type { z } from "zod";

import {
  socialPresaleDetailSchema,
  socialPresaleListPageSchema,
  socialPresaleSummarySchema,
  socialPresaleRowsSchema,
  socialPresaleViewerRequestSchema,
  socialPresaleViewerResponseSchema,
} from "./presale-schemas.ts";
import type {
  SocialPresaleSummary,
  SocialPresaleRaise,
  SocialPresaleViewerRequest,
  SocialPresaleViewerResponse,
} from "./presales.ts";
import type { SocialWatchlistPage } from "./watchlist.ts";
import { socialMePresalesSchema } from "./me-presales.ts";
import { socialWatchlistPageSchema } from "./watchlist.ts";

const id = `0x${"1".repeat(64)}`;
const asOf = { checkpoint: 0, timestamp_ms: 0, lag_ms: 0 };
const summary = {
  presale_id: id,
  name: "Sale",
  symbol: "SALE",
  icon_url: "",
  phase: "open",
  venue: "cetus",
  start_ms: 0,
  end_ms: 10,
  ended_ms: null,
  launched_ms: null,
  target_usd: "1.00",
  raised_usd: null,
  quote_symbol: "SUI",
  quote_type: "0x2::sui::SUI",
  quote_decimals: 9,
  target_atoms: "1000000000",
  raised_atoms: "0",
  fill_bps: 0,
  participants: 0,
  interested: 0,
  presale_price_usd: null,
  presale_price_quote: null,
  price_usd: null,
  multiple: null,
  verified_team: false,
  audited: false,
  metadata: null,
};
const momentum = {
  commits: 0,
  total_usd: "0.00",
  total_atoms: "0",
  backers: 0,
  average_usd: null,
  median_usd: null,
  average_atoms: null,
  median_atoms: null,
  big_bps: 0,
};
const detail = {
  presale: {
    ...summary,
    sale_token: "0x2::sale::SALE",
    sale_decimals: 9,
    allowlisted: false,
    min_commitment_usd: null,
    wallet_cap_usd: null,
    min_commitment_atoms: null,
    wallet_cap_atoms: null,
    opened_ms: null,
  },
  quote_price: null,
  momentum: { "5m": momentum, "1h": momentum, "4h": momentum, "1d": momentum },
  backers: { top: [], top10_bps: 0 },
  theses: [],
  activity: [],
  raise: { points: [], markers: [] },
  vesting: null,
  team_vesting: null,
  terms: null,
  as_of: asOf,
  creator: null,
};
const viewerEntry = {
  following: [],
  following_total_usd: null,
  following_total_atoms: "0",
  mine: null,
};

const ajv = new Ajv2020({ strict: false });
for (const name of ["as-of", "sale-metadata", "feed-item", "presale-summary"]) {
  ajv.addSchema(readSchema(name));
}

function readSchema(name: string) {
  return JSON.parse(
    readFileSync(
      new URL(`./schemas/${name}.schema.json`, import.meta.url),
      "utf8",
    ),
  );
}

function expectParity(
  name: string,
  schema: z.ZodType,
  values: readonly [unknown, boolean][],
) {
  const validate =
    ajv.getSchema(
      `https://blast-v2.invalid/social/contracts/${name}.schema.json`,
    ) ?? ajv.compile(readSchema(name));
  for (const [value, accepted] of values) {
    assert.equal(
      validate(value),
      accepted,
      `${name} published: ${JSON.stringify(validate.errors)}`,
    );
    assert.equal(
      schema.safeParse(value).success,
      accepted,
      `${name} Zod: ${JSON.stringify(value)}`,
    );
  }
}

test("presale viewer requests keep one exact scope, limits, duplicates and raw ids", () => {
  const cases: [unknown, boolean][] = [
    [{ mine: true }, true],
    [{ status: "live" }, true],
    [{ presale_ids: [id, id] }, true],
    [{ presale_ids: Array(50).fill(id) }, true],
    [{ presale_ids: [] }, false],
    [{ presale_ids: Array(51).fill(id) }, false],
    [{ status: "open" }, false],
    [{ mine: false }, false],
    [{ mine: true, status: "live" }, false],
    [{ presale_ids: ["0x1"] }, false],
    [{ presale_ids: [id.toUpperCase()] }, false],
    [{ mine: true, extra: 1 }, false],
    [{}, false],
    [null, false],
  ];
  expectParity(
    "presale-viewer-request",
    socialPresaleViewerRequestSchema,
    cases,
  );
  assert.deepEqual(
    socialPresaleViewerRequestSchema.parse({ presale_ids: [id, id] }),
    { presale_ids: [id, id] },
  );
});

test("presale summary retains optional cached fields and exact financial strings", () => {
  expectParity("presale-summary", socialPresaleSummarySchema, [
    [summary, true],
    [{ ...summary, target_usd: "-1.00" }, true],
    [{ ...summary, target_atoms: "9".repeat(100), participants: 1e20 }, true],
    [{ ...summary, target_atoms: "01" }, false],
    [{ ...summary, target_usd: "1" }, false],
    [{ ...summary, quote_type: "" }, false],
    [{ ...summary, sale_decimals: 256 }, false],
    [
      {
        ...summary,
        backers_sample: Array(4).fill({
          callsign: "test",
          display_name: null,
          avatar_url: null,
          verified: false,
        }),
      },
      false,
    ],
    [{ ...summary, participants: 0.5 }, false],
    [{ ...summary, extra: true }, false],
  ]);
});

test("detail rows preserve their independent optional fields and tuple limits", () => {
  expectParity("presale-detail", socialPresaleDetailSchema, [
    [detail, true],
    [{ ...detail, presale: { ...detail.presale, sale_decimals: 256 } }, true],
    [{ ...detail, presale: { ...detail.presale, backers_sample: [] } }, false],
    [{ ...detail, raise: { points: [[0, "1.00", "1"]], markers: [] } }, true],
    [{ ...detail, raise: { points: [[0, "1.00"]], markers: [] } }, false],
    [
      {
        ...detail,
        raise: { points: [[0, "1.00", "1", "extra"]], markers: [] },
      },
      false,
    ],
  ]);
});

test("presale pages and private answers validate their nested rows", () => {
  expectParity("presale-list-page", socialPresaleListPageSchema, [
    [{ presales: [summary], next_cursor: null, as_of: asOf }, true],
    [{ presales: [summary], next_cursor: "", as_of: asOf }, false],
    [
      { presales: Array(51).fill(summary), next_cursor: null, as_of: asOf },
      false,
    ],
  ]);
  expectParity("presale-viewer-response", socialPresaleViewerResponseSchema, [
    [{ presales: { [id]: viewerEntry }, rows: null }, true],
    [{ presales: { bad: viewerEntry }, rows: null }, false],
    [{ presales: { [id]: { ...viewerEntry, mine: {} } }, rows: null }, false],
  ]);
  const item = {
    presale: summary,
    added_ms: 0,
    starred: true,
    followed: false,
  };
  expectParity("watchlist-page", socialWatchlistPageSchema, [
    [{ items: [item], total: 1, next_cursor: null, as_of: asOf }, true],
    [
      {
        items: [{ ...item, starred: "true" }],
        total: 1,
        next_cursor: null,
        as_of: asOf,
      },
      false,
    ],
  ]);
  const me = {
    positions: [],
    watchlist: [],
    coins: [],
    vestings: [],
    created: [],
  };
  const profilePresale = {
    presale_id: id,
    name: "Sale",
    symbol: "SALE",
    icon_url: "",
    status: "open",
    venue: "cetus",
    start_ms: 0,
    end_ms: 10,
    fill_pct: 0,
    quote_symbol: "SUI",
    quote_decimals: 9,
    launched_ms: null,
    first_unlock_ms: null,
  };
  const position = {
    presale: profilePresale,
    committed_usd: null,
    committed_atoms: "100",
    status: "open",
    claimed_tokens: null,
    refunded_usd: null,
    refunded_atoms: null,
    value_usd: null,
    multiple: null,
    basis_usd: null,
    basis_complete: false,
    pnl_usd: "-1.00",
    pnl_multiple: null,
  };
  expectParity("me-presales-response", socialMePresalesSchema, [
    [me, true],
    [{ ...me, positions: [position], created: [profilePresale] }, true],
    [{ ...me, positions: [{ ...position, committed_usd: "-1.00" }] }, false],
    [{ ...me, positions: [{ ...position, pnl_usd: "1.0" }] }, false],
    [{ ...me, created: [{}] }, false],
    [{ ...me, extra: true }, false],
  ]);
});

test("inferred presale types accept immutable nested collections without changing parsing", () => {
  const request: SocialPresaleViewerRequest = {
    presale_ids: Object.freeze([id]),
  };
  const raise: SocialPresaleRaise = {
    points: Object.freeze([Object.freeze([0, "1.00", "1"] as const)]),
    markers: Object.freeze([]),
  };
  const sale: SocialPresaleSummary = {
    ...summary,
    phase: "open",
    backers_sample: Object.freeze([]),
  };
  const viewer: SocialPresaleViewerResponse = {
    presales: {
      [id]: {
        ...viewerEntry,
        following: Object.freeze([]),
        mine: {
          commitment_usd: null,
          commitment_atoms: "1",
          commits: Object.freeze([Object.freeze([0, null, "1"] as const)]),
          claimed: false,
          refund_usd: null,
          refund_atoms: "0",
        },
      },
    },
    rows: Object.freeze([sale]),
  };
  const watchlist: SocialWatchlistPage = {
    items: Object.freeze([
      { presale: sale, added_ms: 0, starred: true, followed: false },
    ]),
    total: 1,
    next_cursor: null,
    as_of: asOf,
  };
  assert.deepEqual(socialPresaleViewerRequestSchema.parse(request), request);
  assert.deepEqual(socialPresaleViewerResponseSchema.parse(viewer), viewer);
  assert.deepEqual(socialWatchlistPageSchema.parse(watchlist), watchlist);
  assert.equal(
    socialPresaleDetailSchema.safeParse({ ...detail, raise }).success,
    true,
  );
});

test("list, featured, creator and watchlist boundaries accept existing complete UI fixtures", async () => {
  const { fixtureList, fixtureSummaries } = await import(
    "../../../../test/fixtures/presale-pages/presale-fixtures.ts"
  );
  for (const status of ["live", "upcoming", "ended"] as const) {
    const page = fixtureList(status, "backed");
    assert.deepEqual(socialPresaleListPageSchema.parse(page), page);
  }
  const presales = fixtureSummaries();
  assert.deepEqual(socialPresaleRowsSchema.parse({ presales }), { presales });
  const watchlist = {
    items: presales.map((presale) => ({
      presale,
      added_ms: 1,
      starred: true,
      followed: false,
    })),
    total: presales.length,
    next_cursor: null,
    as_of: asOf,
  };
  assert.deepEqual(socialWatchlistPageSchema.parse(watchlist), watchlist);
  assert.equal(
    socialPresaleRowsSchema.safeParse({ presales: [{ presale_id: id }] })
      .success,
    false,
  );
  assert.equal(
    socialPresaleRowsSchema.safeParse({ presales: [] }).success,
    true,
  );
});
