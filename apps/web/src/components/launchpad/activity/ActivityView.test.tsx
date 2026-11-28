import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup, renderToString } from "react-dom/server";

import { classifiedActivityBody, fixtureDigest, FIXTURE_ALLOCATION_DESTINATION, FIXTURE_TREASURY } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/activity-fixtures.ts";
import { COIN_FIXTURE, curvePoolBody } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { activityAnchor, isActivityTrade, parseClassifiedActivityPage, parseCurveFlow, type ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import type { LaunchLifecycle } from "@blast/core/modules/launchpad-contract/discovery.ts";
import { parseInfraProvenance } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { parseTraderProfilesRequest, traderProfileKey, type TraderProfileRequest } from "@blast/core/modules/social/contracts/trader-profiles.ts";
import { CREATE_QUOTE_TYPE } from "@blast/core/web/contracts/create.ts";
import { explorerAccountUrl } from "@blast/core/lib/explorer.ts";
import { shortAddress } from "@blast/core/lib/format.ts";
import { createTestQueryClient, settleQueries, withQueryClient } from "#web/lib/query/test-client.ts";

import { NON_PRODUCTION_MANIFEST } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import {
  activityKey,
  afterFlow,
  afterMore,
  afterRefresh,
  INITIAL_FLOW,
  initialList,
  type FlowState,
  type ListState,
} from "./activity-model";
import { WalletTradesProvider } from "./wallet-trades";
import { ActivityView, type ActivityViewProps } from "./ActivityView";
import { CoinActivity } from "./CoinActivity";

const NOW = 1_790_235_061_630;
const UNITS = {
  symbol: "FROGGY",
  memeDecimals: 6,
  coinType: COIN_FIXTURE.coinType,
  quoteSymbol: "SUI",
  quoteDecimals: 9,
  quoteType: COIN_FIXTURE.quoteType,
};
const EXPLORER = { environment: NON_PRODUCTION_MANIFEST.environment, explorer: NON_PRODUCTION_MANIFEST.explorer } as const;

function activity(lifecycle: LaunchLifecycle, lagMs?: number): ListState<ActivityRow> {
  const body = classifiedActivityBody(lifecycle, { limit: 100 }, NOW, lagMs);
  const page = parseClassifiedActivityPage(COIN_FIXTURE.launchId, body);
  return afterRefresh(
    initialList<ActivityRow>(),
    { kind: "rows", rows: page.activity, next: page.nextCursor, provenance: parseInfraProvenance(body.provenance), lagging: (lagMs ?? 0) > 30_000 },
    activityKey,
  );
}

function flow(lifecycle: LaunchLifecycle = "live"): FlowState {
  const body = curvePoolBody(lifecycle, NOW);
  return afterFlow(INITIAL_FLOW, {
    kind: "flow",
    flow: parseCurveFlow(COIN_FIXTURE.launchId, body),
    provenance: parseInfraProvenance(body.provenance),
    lagging: false,
  });
}

function activityElement(overrides: Partial<ActivityViewProps>, deployer: string | null = null) {
  const props: ActivityViewProps = {
    launchId: COIN_FIXTURE.launchId,
    activity: activity("migrated"),
    flow: flow(),
    window: "24h",
    units: UNITS,
    explorer: EXPLORER,
    anchor: null,
    pending: null,
    onRefresh: () => {},
    onMoreActivity: () => {},
    onShowNewerActivity: () => {},
    onWindow: () => {},
    ...overrides,
  };
  return <WalletTradesProvider deployer={deployer}><ActivityView {...props} /></WalletTradesProvider>;
}

function render(overrides: Partial<ActivityViewProps> = {}, deployer: string | null = null) {
  return renderToStaticMarkup(activityElement(overrides, deployer));
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

/** The activity table row of `position`, each cell's text by its column header. */
function cells(html: string, position: string): Record<string, string> {
  const start = html.indexOf(`id="activity-${position}"`);
  assert.ok(start >= 0, `row ${position}`);
  const row = html.slice(start, html.indexOf("</tr>", start));
  const texts = [...row.matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/g)].map((match) => text(match[2]!));
  const headers = ["Event", "Date", "Where", "Address", "Amounts", "Transaction"];
  assert.equal(texts.length, headers.length, `row ${position} cells`);
  return Object.fromEntries(headers.map((header, index) => [header, texts[index]!]));
}

/** The text of the activity table row of `position`. */
function rowText(html: string, position: string) {
  const start = html.indexOf(`id="activity-${position}"`);
  assert.ok(start >= 0, `row ${position}`);
  return text(html.slice(html.indexOf(">", start) + 1, html.indexOf("</tr>", start)));
}

test("every completed launch event has its own kind and source; the settlement is never a user buy", () => {
  const html = render();
  const rows: [string, RegExp][] = [
    ["325874009:1:2:1", /Opening round .* Launch/],
    ["325874009:1:3:0", /Pre-share buy .* Before launch was shared/],
    ["325880000:0:1:0", /Opening-round join .* Opening round/],
    ["325910100:0:1:0", /Settlement: pot buy .* Opening-round settlement/],
    ["325910100:0:1:1", /Live .* Launch/],
    ["325910100:0:2:0", /Settlement: round closed .* Opening-round settlement/],
    ["325910200:0:0:0", /Opening-round delivery .* Opening round/],
    ["325990000:2:0:0", /Sell .* Bonding curve/],
    ["325990000:3:0:0", /Buy .* Bonding curve/],
    ["326100000:2:3:0", /Migration allocation .* Paid to 0xd1d1…d1d1/],
    ["326100000:2:5:0", /Graduation .* Graduation/],
    ["326100000:2:5:1", /Migrated .* Launch/],
    ["326150000:0:1:0", /Creator fees claimed .* Bonding curve's creator fees/],
    ["326150000:1:1:0", /Protocol fees claimed .* Paid to the treasury 0x7e7e…7e7e/],
    ["326274000:1:1:0", /Venue buy .* Bluefin/],
    ["326254000:0:1:0", /Venue sell .* Bluefin/],
  ];
  for (const [position, pattern] of rows) assert.match(rowText(html, position), pattern, position);
  assert.doesNotMatch(rowText(html, "325910100:0:1:0"), /\bBuy\b/);
});

test("a row shows its address, time, exact and display amounts, and an explorer link", () => {
  const html = render();
  const buy = rowText(html, "325990000:3:0:0");
  assert.match(buy, /Buy 24 Sept ’26/);
  assert.match(html, new RegExp(`Inspect full address: 0x${"33".repeat(32)}`));
  assert.match(html, /aria-label="Link to event: 24 Sept ’26, 2026-09-24 00:59:59(?:\.\d{3})? UTC"/);
  assert.doesNotMatch(buy, /325990000:3:0:0|Checkpoint/);
  assert.equal(cells(html, "325990000:3:0:0").Amounts, "In 0.3 SUI Out 117,000 FROGGY");
  assert.equal(cells(html, "325990000:2:0:0").Amounts, "In 117,000 FROGGY Out 0.3 SUI");
  assert.match(html, /<dt data-direction="in">In<\/dt>/);
  assert.match(html, /<dt data-direction="out">Out<\/dt>/);
  assert.match(html, /<img [^>]*src="\/blast-ui\/dex\/bluefin\.svg"/);
  assert.match(html, /<dt class="sr-only">Payment<\/dt>/);
  assert.match(html, /<dt class="sr-only">Tokens<\/dt>/);
  assert.match(html, /<dt>Refund<\/dt>/);
  assert.match(html, /<image [^>]*href="\/blast-ui\/coins\/sui\.svg"/);
  assert.match(html, /data-coin-mark=""[^>]*><svg aria-hidden="true" data-generated=""/);
  const digest = fixtureDigest(325_990_000, 3);
  assert.match(html, /<a aria-label="View transaction"[^>]*><svg aria-hidden="true"/);
  assert.ok(html.includes(`href="http://127.0.0.1:9001/tx/${digest}"`), "the configured explorer's page");
  // No actor is guessed where the event names none, and every amount of the kind is listed.
  const settled = rowText(html, "325910100:0:2:0");
  assert.equal(cells(html, "325910100:0:2:0").Address, "Unavailable");
  assert.match(settled, /Pot 2\.5 SUI Tokens 830,000 FROGGY Refund 0 SUI/);
  assert.deepEqual(
    [cells(html, "326100000:2:5:1").Address, cells(html, "326100000:2:5:1").Amounts],
    ["Unavailable", "None"],
  );
  // A curve trade's actor is its signer's address, shown short and in full for assistive technology.
  assert.equal(cells(html, "325990000:3:0:0").Address, "0x3333…3333");
  // Without a configured explorer the digest stays, unlinked.
  const bare = render({ explorer: null });
  assert.ok(!bare.includes("/tx/"));
  assert.ok(bare.includes(digest));
  const missingUnits = render({ units: { ...UNITS, memeDecimals: null, quoteDecimals: null } });
  assert.equal(cells(missingUnits, "325990000:3:0:0").Amounts, "In — Out —");
  assert.match(text(missingUnits), /Net SUI flow —/);
  assert.doesNotMatch(missingUnits, /117000000000|300000000\b|21500000000|Inspect full FROGGY amount/);
});

test("each row is a durable link; a linked record is marked and the newest activity is one link away", () => {
  const html = render({ anchor: "325910100:0:1:1" });
  assert.ok(html.includes(`href="/coin/${COIN_FIXTURE.launchId}?activity=325910100:0:1:1"`));
  assert.match(html, /<tr[^>]*id="activity-325910100:0:1:1"[^>]*aria-current="true"/);
  assert.match(text(html), /Showing the linked event and earlier activity\. Show the newest activity/);
  assert.ok(html.includes(`href="/coin/${COIN_FIXTURE.launchId}"`));
  assert.doesNotMatch(render(), /aria-current="true"/);
});

test("flow retains the selected window, financial scope, exact figures and structured source", () => {
  const html = render({ window: "1h" });
  const words = sectionText(html, "Flow");
  assert.match(html, /aria-label="Flow, last 1 hour"/);
  assert.match(words, /Net SUI flow \+21\.5 SUI Buyers 3 Sellers 1/);
  assert.match(words, /Bonding curve trades only. Opening-round settlement is excluded/);
  assert.doesNotMatch(words, /Source Network Sui localnet/);
  assert.doesNotMatch(words, /Checkpoint 326,274,009/);
  assert.match(text(render({ window: "6h" })), /Net SUI flow −6\.4 SUI Buyers 6 Sellers 4/);
  const all = render({ window: "all" });
  assert.match(all, /aria-label="Flow, all time"/);
  assert.match(all, /<button[^>]*aria-pressed="true"[^>]*>All time<\/button>/);
  assert.match(html, /<button[^>]*aria-pressed="true"[^>]*>1h<\/button>/);
  assert.match(html, /<button[^>]*aria-pressed="false"[^>]*>24h<\/button>/);
});

test("after migration the venue pool's swaps are rows of the one list, in position order, with no guessed wallet labels", () => {
  const html = render();
  const swap = cells(html, "326274000:1:1:0");
  assert.equal(swap.Where, "Bluefin");
  assert.equal(swap.Address, "0x3232…3232");
  assert.equal(swap.Amounts, "In 1 SUI Out 64,000 FROGGY");
  assert.equal(cells(html, "326254000:0:1:0").Amounts, "In 70,400 FROGGY Out 1.1 SUI");
  // The swaps and the curve's claims interleave by position: the claims sit between two swaps.
  const order = ["326274000:1:1:0", "326154000:0:1:0", "326150000:1:1:0", "326150000:0:1:0", "326134000:0:1:0", "326100000:2:5:1"];
  const at = order.map((position) => html.indexOf(`id="activity-${position}"`));
  assert.ok(at.every((index, place) => index >= 0 && (place === 0 || index > at[place - 1]!)), JSON.stringify(at));
  assert.doesNotMatch(text(html), /whale|top.trader|Venue trades/i);
});

test("a claim and an allocation name who was paid; a protocol claim lists the SUI and the partner's share apart", () => {
  const html = render();
  const protocol = cells(html, "326150000:1:1:0");
  assert.equal(protocol.Address, "Unavailable");
  assert.equal(protocol.Where, "Paid to the treasury 0x7e7e…7e7e");
  assert.ok(html.includes(FIXTURE_TREASURY));
  assert.ok(html.includes(FIXTURE_ALLOCATION_DESTINATION));
  assert.equal(
    protocol.Amounts,
    "Payment 0.052 SUI Tokens 3,600 FROGGY SUI 1.8 SUI " +
      "Partner share 0 FROGGY Partner payment 0 SUI Partner SUI 0 SUI",
  );
  const creator = cells(html, "326150000:0:1:0");
  assert.equal(creator.Address, `${COIN_FIXTURE.creator.slice(0, 6)}…${COIN_FIXTURE.creator.slice(-4)}`);
  assert.equal(cells(html, "326100000:2:3:0").Where, "Paid to 0xd1d1…d1d1");
});

test("an outage keeps the last rows Stale with provenance; without them each section is Unavailable", () => {
  const live = activity("live");
  const failed = afterRefresh(live, { kind: "failed", reason: "unreachable" }, activityKey);
  const words = text(render({ activity: failed, flow: afterFlow(flow(), { kind: "failed", reason: "not_ready" }) }));
  assert.match(words, /Delayed Launch activity may be out of date/);
  assert.match(words, /Delayed Flow may be out of date/);
  assert.doesNotMatch(words, /Checkpoint 326,274,009/);
  const none = text(
    render({
      activity: afterRefresh(initialList<ActivityRow>(), { kind: "failed", reason: "not_ready" }, activityKey),
      flow: afterFlow(INITIAL_FLOW, { kind: "failed", reason: "unreachable" }),
    }),
  );
  assert.match(none, /Unavailable Launch activity couldn’t load/);
  assert.match(none, /Unavailable Flow couldn’t load/);
  assert.match(text(render({ activity: activity("live", 45_000) })), /Launch activity may be out of date/);
});

test("older pages load on request; a failed page keeps the rows and says why", () => {
  const body = classifiedActivityBody("live", {}, NOW);
  const page = parseClassifiedActivityPage(COIN_FIXTURE.launchId, body);
  const first = afterRefresh(
    initialList<ActivityRow>(),
    { kind: "rows", rows: page.activity, next: page.nextCursor, provenance: parseInfraProvenance(body.provenance), lagging: false },
    activityKey,
  );
  assert.match(text(render({ activity: first })), /Load older activity/);
  assert.match(text(render({ activity: first, pending: "more-activity" })), /Loading older activity/);
  const failed = afterMore(first, page.nextCursor!, { kind: "failed", reason: "unreachable" }, activityKey);
  assert.match(text(render({ activity: failed })), /Older activity couldn’t load. Try again\./);
  assert.doesNotMatch(text(render()), /Load older activity/);
});

test("a launch list cut at a link never claims there is no activity: it names the cut and links to the newest", () => {
  const provenance = activity("live").view!.provenance;
  const cut = afterRefresh(initialList<ActivityRow>(), { kind: "rows", rows: [], next: null, provenance, lagging: false }, activityKey);
  const words = text(render({ activity: cut, anchor: "1:0:0:0" }));
  assert.doesNotMatch(words, /No completed launch activity yet/);
  assert.doesNotMatch(words, /the linked record/);
  assert.match(words, /Launch activity No activity found at or before the linked event\. Show the newest activity/);
  assert.ok(render({ activity: cut, anchor: "1:0:0:0" }).includes(`href="/coin/${COIN_FIXTURE.launchId}"`));
  // Without a link, an empty list is the launch's own state.
  assert.match(text(render({ activity: cut })), /No completed launch activity yet/);
});

/** The text of the section headed `heading`. */
function sectionText(html: string, heading: string) {
  const start = html.indexOf(`>${heading}</h3>`);
  assert.ok(start >= 0, heading);
  const end = html.indexOf("<h3", start + 1);
  return text(html.slice(start + 1, end < 0 ? undefined : end));
}

test("a well-formed position no row has is not called the linked record", () => {
  const launchId = COIN_FIXTURE.launchId;
  const body = classifiedActivityBody("migrated", { cursor: activityAnchor(launchId, "325910150:0:0:0").cursor }, NOW);
  const page = parseClassifiedActivityPage(launchId, body);
  const cut = afterRefresh(
    initialList<ActivityRow>(),
    { kind: "rows", rows: page.activity, next: page.nextCursor, provenance: parseInfraProvenance(body.provenance), lagging: false },
    activityKey,
  );
  const html = render({ activity: cut, anchor: "325910150:0:0:0" });
  const words = sectionText(html, "Launch activity");
  assert.doesNotMatch(words, /the linked record/);
  assert.match(words, /Linked event unavailable. Showing earlier activity\. Show the newest activity/);
  assert.doesNotMatch(html, /aria-current="true"/);
});

test("the list's link note is an element a durable link can scroll to, a venue swap's link included", () => {
  const html = render({ anchor: "326274000:1:1:0" });
  assert.match(html, new RegExp(`<p[^>]*id="${COIN_FIXTURE.launchId}-activity-link"[^>]*>Showing the linked event and earlier activity`));
  assert.match(html, /<tr[^>]*id="activity-326274000:1:1:0"[^>]*aria-current="true"/);
});

test("rounded amounts keep their exact value available to inspect", () => {
  const words = sectionText(render(), "Launch activity");
  assert.doesNotMatch(words, /cut to two decimal places\./);
  // Below 1, four significant digits: 393700787401 atoms at 15 decimals is 0.000393700787401.
  const html = render({ units: { ...UNITS, memeDecimals: 15 } });
  assert.equal(cells(html, "325874009:1:3:0").Amounts, "In 1 SUI Out 0.0003937 FROGGY");
  assert.match(html, /Inspect full FROGGY amount: 0.000393700787401 FROGGY/);
});

test("while a cut list loads or is Unavailable its note says where it is read from, never what it shows", () => {
  const anchor = "326274000:1:1:0";
  const failed = afterRefresh(initialList<ActivityRow>(), { kind: "failed", reason: "not_ready" }, activityKey);
  for (const activityState of [initialList<ActivityRow>(), failed]) {
    const launch = sectionText(render({ anchor, activity: activityState }), "Launch activity");
    assert.match(launch, /(Loading linked activity|Linked activity couldn’t load)\. Show the newest activity/);
    assert.doesNotMatch(launch, /Showing/);
  }
});

test("compact trades preserve delayed-data warnings and keep lifecycle records in the ledger", () => {
  const html = render({ compact: true, activity: activity("migrated", 45_000) });
  assert.match(text(html), /Trade updates delayed/);
  assert.match(html, /aria-label="Recent trades"/);
  const preview = html.match(/<ol[^>]*aria-label="Recent trades"[^>]*>(.*?)<\/ol>/s)?.[1] ?? "";
  assert.equal((preview.match(/<li\b/g) ?? []).length, 4);
  assert.match(text(html), /Launch activity/);
  assert.doesNotMatch(text(html), /Lifecycle:|Migration allocation|Net SUI flow/);
});

test("the coin renders the recent trades from the server page before hydration", () => {
  const { rows, next, provenance } = activity("migrated").view!;
  const html = renderToStaticMarkup(<WalletTradesProvider deployer={null}>
    <CoinActivity
      compact
      source={{ launchId: COIN_FIXTURE.launchId, expected: null, units: UNITS, explorer: EXPLORER, anchor: null }}
      initialActivity={{ kind: "rows", rows, next, provenance, lagging: false }}
    />
  </WalletTradesProvider>);
  const preview = html.match(/<ol[^>]*aria-label="Recent trades"[^>]*>(.*?)<\/ol>/s)?.[1] ?? "";
  assert.equal((preview.match(/<li\b/g) ?? []).length, 4);
  assert.ok(preview.includes(rows[0]!.digest));
  assert.doesNotMatch(html, /Reading trades/);
});

test("recent trades hide sub-dollar trades until the switch is turned off", async (t) => {
  const state = activity("migrated");
  const [first, second, third, fourth] = state.view!.rows.filter(isActivityTrade);
  const earlier = { ...fourth!, position: "1:0:0:0", timestampMs: fourth!.timestampMs - 1_000 };
  const rows = [
    { ...first!, amounts: { ...first!.amounts, quote: 999_999n } },
    { ...second!, amounts: { ...second!.amounts, quote: 1_000_000n } },
    { ...third!, amounts: { ...third!.amounts, quote: 1_000_001n } },
    { ...fourth!, amounts: { ...fourth!.amounts, quote: 2_000_000n } },
    { ...earlier, amounts: { ...earlier.amounts, quote: 3_000_000n } },
  ];
  const confirmedActivity = { ...state, view: { ...state.view!, rows } };
  const element = activityElement({
    compact: true,
    activity: confirmedActivity,
    confirmedActivity,
    units: { ...UNITS, quoteType: CREATE_QUOTE_TYPE, quoteSymbol: "USDC", quoteDecimals: 6 },
  });
  assert.ok(earlier.actor);
  const earlierProfile = traderProfileKey({ address: earlier.actor, timestampMs: earlier.timestampMs });
  const requests: (readonly TraderProfileRequest[])[] = [];
  const now = Math.max(...rows.map((row) => row.timestampMs));
  t.mock.method(globalThis, "fetch", async (resource: string) => {
    const traders = parseTraderProfilesRequest(new URL(resource, "https://blast.fun"), now);
    assert.ok(traders);
    requests.push(traders);
    return Response.json(Object.fromEntries(traders.map((trader) => {
      const key = traderProfileKey(trader);
      return [key, key === earlierProfile ? { callsign: "alice", avatarUrl: null } : null];
    })));
  });
  const { document } = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  await act(async () => root.render(withQueryClient(client, element)));
  await act(async () => settleQueries(client));

  const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
  const times = () => [...container.querySelectorAll('[aria-label="Recent trades"] time')].map((time) => time.getAttribute("datetime"));
  const dates = rows.map((row) => new Date(row.timestampMs).toISOString());
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.deepEqual(times(), dates.slice(1));
  assert.deepEqual(requests.map((traders) => traders.map((trader) => trader.timestampMs)), [rows.slice(1).map((row) => row.timestampMs)]);
  assert.ok(container.querySelector('[aria-label="Recent trades"] a[href="/@alice"]'));
  await act(async () => toggle.click());
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.deepEqual(times(), dates.slice(0, 4));
  assert.equal(requests.length, 1);
});

test("a vault claim preserves the trades and appears only in the full activity ledger", () => {
  const body = classifiedActivityBody("migrated", { limit: 100 }, NOW);
  assert.ok(Array.isArray(body.activity));
  const claim = {
    position: "326274000:2:0:0",
    checkpoint: 326_274_000,
    timestamp_ms: NOW,
    digest: fixtureDigest(326_274_000, 2),
    kind: "owner_balances_claimed",
    source: null,
    actor: COIN_FIXTURE.creator,
    lifecycle: null,
    amounts: { meme: "4200000000", quote: "61000000" },
  };
  const page = parseClassifiedActivityPage(COIN_FIXTURE.launchId, { ...body, activity: [claim, ...body.activity] });
  const state = afterRefresh(initialList<ActivityRow>(), {
    kind: "rows",
    rows: page.activity,
    next: page.nextCursor,
    provenance: parseInfraProvenance(body.provenance),
    lagging: false,
  }, activityKey);

  const compact = render({ compact: true, activity: state });
  const preview = compact.match(/<ol[^>]*aria-label="Recent trades"[^>]*>(.*?)<\/ol>/s)?.[1] ?? "";
  const trades = text(preview);
  assert.match(trades, /Buy/);
  assert.match(trades, /Sell/);
  assert.ok(!preview.includes(claim.digest));
  assert.match(rowText(render({ activity: state }), claim.position), /Vault balances claimed .* Launch vault/);
});

test("recent buys and sells show both amounts in their own units", () => {
  const state = activity("migrated");
  const buy = state.view!.rows.find((row) => row.kind === "venue_buy")!;
  const sell = state.view!.rows.find((row) => row.kind === "curve_sell")!;
  const rows = [
    { ...buy, amounts: { meme: 9_510_000_000_000n, quote: 100_000_000_000n } },
    { ...sell, amounts: { meme: 2_500_000n, quote: 370_000_000n } },
  ];
  const html = render({ compact: true, activity: { ...state, view: { ...state.view!, rows } } });
  assert.match(text(html), /9\.51M FROGGY for 100 SUI/);
  assert.match(text(html), /2\.5 FROGGY for 0\.37 SUI/);
  assert.match(html, /Inspect full FROGGY amount: 9,510,000 FROGGY/);
});

test("trade rows lead with a short age that ticks and keeps the exact time", async (t) => {
  const state = activity("migrated");
  const trades = state.view!.rows.filter(isActivityTrade);
  const dates = [
    new Date(2026, 0, 1, 23, 59, 53),
    new Date(2026, 0, 1, 23, 59, 0),
    new Date(2026, 0, 1, 17, 59, 59),
  ];
  const rows = dates.map((date, index) => ({ ...trades[index]!, timestampMs: date.getTime() }));
  const element = activityElement({ compact: true, activity: { ...state, view: { ...state.view!, rows } } });
  const html = renderToString(element);
  const { document, window } = installTestDom();
  const { act } = await import("react");
  const { hydrateRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 0, 1, 23, 59, 59) });
  const errors: unknown[] = [];
  const root = await act(async () => hydrateRoot(container, element, { onRecoverableError: (error) => errors.push(error) }));
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const labels = () => [...container.querySelectorAll('[aria-label="Recent trades"] time')].map((time) => time.textContent);

  assert.deepEqual(errors, []);
  assert.deepEqual(labels(), ["6s", "59s", "6h"]);
  const first = container.querySelector('[aria-label="Recent trades"] li')?.firstElementChild;
  assert.match(first?.textContent ?? "", /^(Buy|Sell) · 6s$/);
  assert.ok(first?.querySelector('button[aria-label="Trade time, 6 seconds ago"]'));
  assert.deepEqual(
    [...container.querySelectorAll('[aria-label="Recent trades"] time')].map((time) => time.getAttribute("datetime")),
    dates.map((date) => date.toISOString()),
  );

  await act(async () => { t.mock.timers.tick(1_000); });
  assert.deepEqual(labels(), ["7s", "1m", "6h"]);
  // Away from the tab for two days, then back: the ages are right at once.
  let visibility = "hidden";
  Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });
  t.after(() => { delete (document as { visibilityState?: string }).visibilityState; });
  await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
  await act(async () => {
    t.mock.timers.setTime(new Date(2026, 0, 3, 12).getTime());
    visibility = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  assert.deepEqual(labels(), ["2d", "2d", "2d"]);
});

test("compact mode preserves the complete durable-link view", () => {
  const html = render({ compact: true, anchor: "325874009:1:3:0" });
  assert.match(html, /id="activity-325874009:1:3:0"/);
  assert.match(text(html), /Showing the linked event and earlier activity/);
});

test("recent trades link only named event-time profiles and retain wallet identities", () => {
  const state = activity("migrated");
  const row = state.view!.rows.find((row) => row.actor && (row.kind === "venue_buy" || row.kind === "curve_buy"))!;
  const other = { ...row, timestampMs: row.timestampMs - 1, position: "1:1:1:0" };
  const rows = [row, other];
  const confirmedActivity = { ...state, view: { ...state.view!, rows } };
  const client = createTestQueryClient();
  client.setQueryData(["trader-profiles", COIN_FIXTURE.launchId, true], { [`${row.actor}:${row.timestampMs}`]: { callsign: "alice", avatarUrl: "https://example.com/avatar.png" } });
  const html = renderToStaticMarkup(withQueryClient(client, activityElement({ compact: true, activity: confirmedActivity, confirmedActivity })));
  client.clear();
  assert.match(html, /href="\/@alice"/);
  assert.match(html, /View @alice/);
  // The same wallet at a time with no profile opens on the viewer's explorer (Suiscan by default).
  assert.equal((html.match(/aria-label="Wallet trader"/g) ?? []).length, 0);
  assert.equal(html.split(`href="${explorerAccountUrl("suiscan", row.actor!)}"`).length - 1, 1);
  assert.match(html, new RegExp(`aria-label="View wallet ${shortAddress(row.actor!)} on Suiscan"`));
  assert.equal((html.match(/href="\/@/g) ?? []).length, 1);
  assert.ok(text(html).includes(shortAddress(row.actor!)));
});

test("the trade address explains every matching wallet icon on buys and sells", () => {
  const state = activity("migrated");
  const row = state.view!.rows.find((item) => item.kind === "venue_sell")!;
  const tagged = { ...row, labels: ["whale", "sniper"] as const };
  const history = { ...state, view: { ...state.view!, rows: [tagged, { ...row, kind: "venue_buy" as const, position: "1:0:0:0" }] } };
  for (const compact of [true, false]) {
    const html = render({ compact, activity: history }, row.actor);
    assert.match(html, /Deployer\. This wallet launched the coin\./);
    assert.match(html, /Whale\. This trade met/);
    assert.match(html, /Sniper\. This wallet bought/);
    assert.match(html, /data-wallet-label="deployer".*data-wallet-label="whale".*data-wallet-label="sniper"/);
    const unknown = render({ compact, activity: history });
    assert.doesNotMatch(unknown, /Deployer\.|data-wallet-label="deployer"/);
    assert.match(unknown, /data-wallet-label="whale".*data-wallet-label="sniper"/);
  }
});
