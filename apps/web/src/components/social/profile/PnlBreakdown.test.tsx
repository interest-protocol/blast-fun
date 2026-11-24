import assert from "node:assert/strict";
import test from "node:test";

import { PROFILE_PNL } from "../../../../test/fixtures/social/profile/pnl-fixtures.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import type { SocialProfile } from "@blast/core/modules/social/contracts/profiles.ts";
import { keysChangedBy } from "#web/lib/query/invalidate.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { isSocialPnl } from "./pnl-client";
import { pnlFigure } from "./pnl-model";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient } = await import("@tanstack/react-query");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { SocialViewerProvider } = await import("../SignInGate");
const { ProfileScreen } = await import("./ProfileScreen");
const { PnlBreakdown, PnlTile } = await import("./PnlBreakdown");
const { useProfilePnl } = await import("./use-profile-data");

test("PnL validates every financial field and formats losses, zero, tiny amounts and large cents exactly", () => {
  assert.equal(isSocialPnl(PROFILE_PNL), true);
  for (const patch of [{ total_usd: 12 }, { total_usd: "NaN" }, { total_usd: undefined }]) {
    assert.equal(isSocialPnl({ ...PROFILE_PNL, totals: { ...PROFILE_PNL.totals, ...patch } }), false);
  }
  assert.equal(isSocialPnl({ ...PROFILE_PNL, assets: [{ ...PROFILE_PNL.assets[0], tracked_balance: "-1" }] }), false);
  assert.deepEqual(pnlFigure("-0.01"), { text: "−$0.01", tone: "down" });
  assert.deepEqual(pnlFigure("0.00"), { text: "$0.00", tone: null });
  assert.deepEqual(pnlFigure(null), { text: "Unavailable", tone: null });
  assert.deepEqual(pnlFigure("-250.00", true), { text: "••••", tone: null });
  assert.equal(pnlFigure("9007199254740993.12").text, "+$9,007,199,254,740,993.12");
  assert.equal(pnlFigure("81100.00", false, true).text, "+$81.1K");
  assert.equal(pnlFigure("-170.00", false, true).text, "−$170");
  assert.equal(pnlFigure("-0.01", false, true).text, "−$0.01");
});

const profile: Omit<SocialProfile, "as_of"> = {
  callsign: "nova", display_name: "Nova", avatar_url: null, x_handle: null, verified: false,
  private: false, portfolio_public: true,
};

test("the PnL tile distinguishes unavailable values from zero and hidden amounts", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const onToggle = t.mock.fn();
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  async function render(total: string | null, hidden = false) {
    await act(async () => root.render(<PnlTile allowed controls="pnl-details" expanded={false} hidden={hidden} onToggle={onToggle} pnl={{ status: "ready", value: { ...PROFILE_PNL, totals: { ...PROFILE_PNL.totals, total_usd: total } } }} />));
  }
  await render(null);
  const tile = container.querySelector("button")!;
  assert.equal(tile.querySelector("b"), null);
  assert.doesNotMatch(tile.textContent!, /Unavailable|—/);
  assert.doesNotMatch(tile.textContent!, /\$0/);
  assert.equal(tile.getAttribute("aria-controls"), "pnl-details");
  assert.equal(tile.getAttribute("aria-expanded"), "false");
  await act(async () => tile.click());
  assert.equal(onToggle.mock.callCount(), 1);
  await render("0.00");
  assert.equal(tile.querySelector("b")?.textContent, "$0");
  assert.doesNotMatch(tile.textContent!, /Unavailable/);
  await render(null, true);
  assert.equal(tile.querySelector("b")?.textContent, "••••");
  assert.doesNotMatch(tile.textContent!, /Unavailable|—/);
});

test("profile tile opens lifetime breakdown with closed losses, filters and private/hidden states", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ nova: null, followers: 0, following: 0 }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  async function render(own = true, hidden = false, shown = profile) {
    await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider signedIn={false}>
      <ProfileScreen profile={shown} nowMs={1_800_000_000_000} onEdit={() => undefined} data={{
        own, hidden, pnl: { status: "ready", value: PROFILE_PNL },
        calls: { status: "ready", value: { calls: [], track_record: { presales_backed: 2, launched: 1, pnl_usd: "999999.00" }, as_of: { checkpoint: 10, timestamp_ms: 1_800_000_000_000, lag_ms: 0 } } },
        created: { status: "ready", value: [] }, mutuals: { status: "none" }, gold: { status: "none" },
      }} />
    </SocialViewerProvider></QueryProvider>));
  }
  await render();
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="View PnL breakdown since launch"]')!;
  // The Profile board's tile: "View details ⌄" beside the label, over the figure.
  assert.match(toggle.textContent!, /PnL since launchView details−\$170/);
  assert.equal(toggle.parentElement?.querySelectorAll(":scope > button").length, 1, "The entire tile is the button");
  assert.equal(toggle.querySelector("button, a, input, [tabindex]"), null, "No nested interactive elements");
  assert.doesNotMatch(container.textContent!, /999999/);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.match(toggle.textContent!, /View details/);
  await act(async () => toggle.click());
  const breakdown = container.querySelector('[aria-label="PnL since launch"]')!;
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.match(toggle.textContent!, /Hide details/);
  assert.match(breakdown.textContent!, /LUMNClosedRealized−\$250\.00/);
  assert.match(breakdown.textContent!, /Unrealized−\$40\.00/);
  assert.equal([...breakdown.querySelectorAll("button")].filter((button) => button.textContent?.includes("Create")).length, 3);
  const filter = (label: string) => [...breakdown.querySelectorAll<HTMLButtonElement>('[aria-label="PnL positions"] button')].find((button) => button.textContent === label)!;
  await act(async () => filter("Closed").click());
  assert.doesNotMatch(breakdown.querySelector("ul")!.textContent!, /KSTL/);
  assert.match(breakdown.querySelector("ul")!.textContent!, /LUMN/);
  await act(async () => filter("Open").click());
  assert.doesNotMatch(breakdown.querySelector("ul")!.textContent!, /LUMN/);
  await render(true, true);
  assert.doesNotMatch(container.querySelector('[aria-label="PnL since launch"]')!.textContent!, /\$/);
  assert.doesNotMatch(toggle.textContent!, /\$/);
  assert.equal(container.querySelector('[aria-label="PnL since launch"]')!.querySelector('[aria-haspopup="dialog"]') === null, true);
  await render(false);
  assert.equal(container.querySelector('[aria-label="PnL since launch"]')!.querySelector('[aria-haspopup="dialog"]'), null);
  await render(false, false, { ...profile, portfolio_public: false });
  assert.equal(container.querySelector('[aria-label="PnL since launch"]'), null);
  assert.equal(container.querySelector('[aria-label="View PnL breakdown since launch"]'), null);
  assert.doesNotMatch(container.textContent!, /−\$170|LUMN/);
  assert.match(container.textContent!, /PnL since launchPrivate/);
  await render(false, false, { ...profile, private: true });
  assert.equal(container.querySelector('[aria-label="PnL since launch"]'), null);
});

test("card creation waits for history and prices, while a fully priced coin remains shareable", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  async function render(historyComplete: boolean) {
    await act(async () => root.render(<PnlBreakdown hidden={false} ownerCallsign="nova" pnl={{ status: "ready", value: {
      ...PROFILE_PNL, history_complete: historyComplete, totals: { ...PROFILE_PNL.totals, total_usd: null },
    } }} />));
  }
  await render(true);
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[aria-haspopup="dialog"]')];
  assert.equal(buttons[0]!.disabled, true);
  assert.equal(buttons[1]!.disabled, false);
  assert.equal(buttons[2]!.disabled, false);
  await render(false);
  assert.ok([...container.querySelectorAll<HTMLButtonElement>('[aria-haspopup="dialog"]')].every((button) => button.disabled));
});

test("breakdown keeps unknowns separate from zero, names loading/empty/error states and retries", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<PnlBreakdown hidden={false} pnl={{ status: "loading" }} />));
  assert.match(container.textContent!, /Loading PnL since launch/);
  let retried = false;
  await act(async () => root.render(<PnlBreakdown hidden={false} pnl={{ status: "error" }} retry={() => { retried = true; }} />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  assert.equal(retried, true);
  await act(async () => root.render(<PnlBreakdown hidden={false} ownerCallsign="nova" pnl={{ status: "ready", value: { ...PROFILE_PNL, assets: [], totals: { realized_usd: "0.00", unrealized_usd: "0.00", total_usd: "0.00" } } }} />));
  assert.match(container.textContent!, /No trading PnL yet/);
  assert.equal(container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.disabled, false, "A complete $0 PnL can create a card");
  await act(async () => root.render(<PnlBreakdown hidden={false} pnl={{ status: "ready", value: { ...PROFILE_PNL, totals: { ...PROFILE_PNL.totals, unrealized_usd: null, total_usd: null }, assets: [{ ...PROFILE_PNL.assets[0]!, total_usd: null, unrealized_usd: null }] } }} />));
  assert.doesNotMatch(container.textContent!, /Unavailable|unavailable/);
  assert.deepEqual([...container.querySelectorAll("dt")].map((label) => label.textContent), ["Realized", "Realized"]);
  assert.match(container.textContent!, /Realized−\$130\.00/);
});

test("all-unknown PnL omits the tile and breakdown, while privacy, pending reads and errors remain accessible", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const unknown = { ...PROFILE_PNL, totals: { realized_usd: null, unrealized_usd: null, total_usd: null }, assets: [] };
  async function render(hidden = false, allowed = true) {
    await act(async () => root.render(<><PnlTile allowed={allowed} controls="pnl-details" expanded={false} hidden={hidden} onToggle={() => undefined} pnl={{ status: "ready", value: unknown }} /><PnlBreakdown hidden={hidden} pnl={{ status: "ready", value: unknown }} /></>));
  }
  await render();
  assert.equal(container.innerHTML, "");
  await render(true);
  assert.match(container.textContent!, /••••/);
  assert.doesNotMatch(container.textContent!, /Unavailable/);
  await render(false, false);
  assert.match(container.textContent!, /PnL since launchPrivate/);
  await act(async () => root.render(<PnlTile allowed controls="pnl-details" expanded={false} hidden={false} onToggle={() => undefined} pnl={{ status: "loading" }} />));
  assert.equal(container.querySelector("button")?.getAttribute("aria-busy"), "true");
  await act(async () => root.render(<PnlTile allowed controls="pnl-details" expanded={false} hidden={false} onToggle={() => undefined} pnl={{ status: "error" }} />));
  assert.match(container.textContent!, /View details/);
  assert.doesNotMatch(container.textContent!, /Unavailable|—/);
});

test("unknown figures preserve real wallet syncing and never imply that indexed open positions are empty", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const unknownFigures = { realized_usd: null, unrealized_usd: null, total_usd: null };
  const syncing = { ...PROFILE_PNL, totals: unknownFigures, assets: [], wallet_sync: { ...PROFILE_PNL.wallet_sync, status: "syncing" as const } };
  await act(async () => root.render(<><PnlTile allowed controls="pnl-details" expanded hidden={false} onToggle={() => undefined} pnl={{ status: "ready", value: syncing }} /><PnlBreakdown hidden={false} pnl={{ status: "ready", value: syncing }} /></>));
  assert.equal(container.querySelector("button")?.getAttribute("aria-busy"), "true");
  assert.match(container.querySelector('[role="status"]')!.textContent!, /Syncing wallet history/);
  assert.equal(container.querySelector('[aria-label="Syncing PnL since launch"]')?.getAttribute("aria-busy"), "true");
  const assets = [{ ...PROFILE_PNL.assets[0]!, ...unknownFigures }, PROFILE_PNL.assets[1]!];
  await act(async () => root.render(<PnlBreakdown hidden={false} pnl={{ status: "ready", value: { ...PROFILE_PNL, assets } }} />));
  const open = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="PnL positions"] button')].find(button => button.textContent === "Open")!;
  await act(async () => open.click());
  assert.doesNotMatch(container.textContent!, /No open positions|No trading PnL|Unavailable|unavailable/);
  assert.equal(container.querySelector("ul"), null, "unpriced open positions leave no empty metric list");
});

test("PnL hook uses authenticated owner vs public queries, clears owner data on logout, and follows transaction invalidation", async (t) => {
  const requests: { path: string; authorization: string | null }[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ path: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json(PROFILE_PNL);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  function Read({ own, isPublic }: Readonly<{ own: boolean; isPublic: boolean }>) {
    const pnl = useProfilePnl("nova", own, isPublic);
    return <span>{pnl.status}</span>;
  }
  async function render(own: boolean, isPublic: boolean) {
    await act(async () => {
      root.render(<QueryProvider client={client}><SocialViewerProvider signedIn={own} callsign={own ? "nova" : null} getAccessToken={async () => "owner-token"}><Read own={own} isPublic={isPublic} /></SocialViewerProvider></QueryProvider>);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  await render(true, false);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(requests[0], { path: "/api/social/me/pnl", authorization: "Bearer owner-token" });
  assert.deepEqual(client.getQueryData(queryKeys.me.pnl()), PROFILE_PNL);
  await render(false, false);
  assert.equal(client.getQueryData(queryKeys.me.pnl()), undefined);
  assert.equal(container.textContent, "none");
  assert.equal(requests.length, 1);
  await render(false, true);
  assert.deepEqual(requests[1], { path: "/api/social/profiles/nova/pnl", authorization: null });
  for (const kind of ["trade", "balances", "commit", "claim"] as const) {
    assert.ok(keysChangedBy({ kind, presaleId: "sale" }).some((key) => queryKeys.me.pnl().slice(0, key.length).every((part, i) => part === key[i])));
  }
});
