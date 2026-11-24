import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { NO_COST_BASIS } from "@blast/core/modules/social/contracts/portfolio.ts";
import type { ProfileCall, SocialProfileCalls } from "@blast/core/modules/social/contracts/profile-page.ts";
import type { SocialProfile } from "@blast/core/modules/social/contracts/profiles.ts";

import { FIXTURE_NOW } from "../../../test/fixtures/social/feed-fixtures.ts";
import { trendFrom } from "./profile/portfolio-trend";
import { ProfileAsideCards } from "./profile/ProfileAside";
import { ProfileScreen, type ProfileScreenData } from "./profile/ProfileScreen";
import { ProfileView } from "./ProfileView";
import { SocialViewerProvider } from "./SignInGate";

/** Social-feed UI-06 (canonical UI §6): `/@<callsign>`'s view, rendered on the server as the app router would. */

const KAI: Omit<SocialProfile, "as_of"> = {
  callsign: "kai",
  display_name: "Kai <b>Moreno</b>",
  avatar_url: null,
  x_handle: "kai_x",
  verified: true,
  private: false,
  portfolio_public: false,
};
const AS_OF = { checkpoint: 40_000, timestamp_ms: FIXTURE_NOW - 1_000, lag_ms: 1_000 };

function call(status: ProfileCall["presale"]["status"], over: Partial<ProfileCall> = {}): ProfileCall {
  return {
    presale: { presale_id: `0x${"1".padStart(64, "0")}`, symbol: "KSTL", name: "Kestrel", icon_url: "https://cdn.example/k.png", status, venue: "cetus", start_ms: 0, end_ms: FIXTURE_NOW + 3_600_000, fill_pct: 73, quote_symbol: "USDC", quote_decimals: 6, launched_ms: null, first_unlock_ms: null },
    committed_usd: "300.00",
    committed_atoms: "300000000",
    entry_price_usd: "0.0005",
    price_usd: "0.0021",
    multiple: "4.2000",
    value_usd: "1260.00",
    pnl_usd: "960.00",
    last_commit_ms: FIXTURE_NOW,
    series: null,
    ...over,
  };
}

const CALLS: SocialProfileCalls = {
  calls: [call("trading")],
  track_record: { presales_backed: 1, launched: 1, pnl_usd: "960.00" },
  as_of: AS_OF,
};

const router: AppRouterInstance = {
  bfcacheId: "profile-test",
  back: () => undefined,
  forward: () => undefined,
  refresh: () => undefined,
  push: () => undefined,
  replace: () => undefined,
  prefetch: () => undefined,
};

function at(node: ReactNode, viewer?: { callsign: string | null }): string {
  const tree = viewer ? (
    <SocialViewerProvider signedIn callsign={viewer.callsign} getAccessToken={async () => "token"}>
      {node}
    </SocialViewerProvider>
  ) : node;
  return renderToStaticMarkup(
    <AppRouterContext value={router}>
      <PathnameContext value="/crew/kai">{tree}</PathnameContext>
    </AppRouterContext>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, "");

test("UI-06, KA-2: the server HTML is the public profile with no back bar: identity, rosette, X chip, Follow, three tiles and the calls", () => {
  const html = at(<ProfileView initialCalls={CALLS} nowMs={FIXTURE_NOW} profile={KAI} />);
  assert.doesNotMatch(html, /data-back-bar/);
  // Names render as text, never markup.
  assert.ok(html.includes("Kai &lt;b&gt;Moreno&lt;/b&gt;"));
  assert.match(html, /aria-label="Verified"/);
  assert.doesNotMatch(html, /Unverified/);
  assert.match(html, /href="https:\/\/x\.com\/kai_x"[^>]*rel="noopener noreferrer"[^>]*target="_blank"/);
  // A visitor's Follow is the sign-in link back to /@kai.
  assert.match(html, /<a class="btn btn-ink follow" data-gated="sign-in" href="\/sign-in\?next=%2F%40kai">Follow/);
  // OA-14: exactly three tiles.
  assert.deepEqual([...text(html).matchAll(/(Presales backed|Backed, now trading|Launched|PnL|Best call|Hit rate)/g)].map((m) => m[1]), ["Presales backed", "Backed, now trading", "PnL"]);
  assert.match(text(html), /PnL since launchPrivate/);
  assert.match(text(html), /Kestrel\$300 at \$0\.0005 · now \$0\.00214\.2×since presale/);
  assert.match(html, /role="group" aria-label="Profile sections"|aria-label="Profile sections"[^>]*role="group"/);
  // No viewer part on the server: no Edit profile, no gold card (the portfolio is not public), no holdings.
  assert.doesNotMatch(html, /Edit profile|Presale portfolio|Your holdings|Sharing activity/);
});

test("Ansem's call sign is marked Unverified until the profile has a verified link to @blknoiz06", () => {
  const ansem = { ...KAI, callsign: "ansem", display_name: "Ansem" };
  const loading = at(<ProfileView initialCalls={CALLS} nowMs={FIXTURE_NOW} profile={{ ...ansem, x_handle: null, verified: false }} />, { callsign: "ansem" });
  assert.doesNotMatch(loading, /Unverified/);

  const unlinked = at(<ProfileView initialCalls={CALLS} nowMs={FIXTURE_NOW} profile={{ ...ansem, x_handle: null, verified: false }} />);
  assert.match(text(unlinked), /@ansemUnverified/);
  assert.doesNotMatch(unlinked, /aria-label="Verified"/);

  const differentX = at(<ProfileView initialCalls={CALLS} nowMs={FIXTURE_NOW} profile={{ ...ansem, x_handle: "ansem" }} />);
  assert.match(text(differentX), /@ansemUnverified/);
  assert.doesNotMatch(differentX, /aria-label="Verified"/);

  const unverifiedX = at(<ProfileView initialCalls={CALLS} nowMs={FIXTURE_NOW} profile={{ ...ansem, x_handle: "blknoiz06", verified: false }} />);
  assert.match(text(unverifiedX), /@ansemUnverified/);

  const verifiedX = at(<ProfileView initialCalls={CALLS} nowMs={FIXTURE_NOW} profile={{ ...ansem, x_handle: "BlkNoiz06" }} />);
  assert.doesNotMatch(verifiedX, /Unverified/);
  assert.match(verifiedX, /aria-label="Verified"/);
});

test("UI-06: an owner's server HTML uses the profile skeleton until hydration resolves ownership", () => {
  const owner = at(<ProfileView initialCalls={CALLS} nowMs={FIXTURE_NOW} profile={KAI} />, { callsign: "kai" });
  assert.match(owner, /aria-label="Loading profile"/);
  assert.doesNotMatch(owner, /data-gated="sign-in"|class="gold gold2"/);
  assert.match(owner, /Created/);
});

test("UI-06 (§6.2): a private account shows its identity and the private note: no tiles, portfolio or sections", () => {
  const html = at(<ProfileView initialCalls={null} nowMs={FIXTURE_NOW} profile={{ ...KAI, private: true }} />);
  assert.match(text(html), /This account is privateTheir actions don&#x27;t appear on Blast\./);
  assert.doesNotMatch(text(html), /Presales backed|Presale calls|Presale portfolio/);
});

test("UI-06 (OA-10, R3-08): someone's public portfolio shows the gold2 card marked Public, with no composition bar and no actions", () => {
  const html = at(<ProfileView initialCalls={CALLS} nowMs={FIXTURE_NOW} profile={{ ...KAI, portfolio_public: true }} />);
  assert.match(html, /aria-label="Kai &lt;b&gt;Moreno&lt;\/b&gt;&#x27;s presale portfolio"/);
  assert.match(html, /class="gold gold2"/);
  assert.match(text(html), /Presale portfolioPublic/);
  // The composition bar, the legend and the actions are the owner's only.
  assert.doesNotMatch(text(html), /Committed|Claimable|Deposit|Withdraw/);
  // R3-08: the helmet mark and the chips row of the old `.gold` are gone.
  assert.doesNotMatch(html, /goldMark|goldChips/);
  // Less than a month of daily snapshots (OA-25 Q16, R3-08-AC-5): the line's box is kept and empty — no line, no caption,
  // no placeholder figure.
  assert.match(html, /<div aria-hidden="true" class="g2Chart"><div class="g2Spark" data-slot="portfolio-sparkline"><\/div><\/div>/);
  assert.doesNotMatch(text(html), /30 days/);
});

const OWN_DATA: ProfileScreenData = {
  own: true,
  calls: { status: "ready", value: CALLS },
  mutuals: { status: "none" },
  gold: { status: "none" },
};
const LUCA_GOLD: ProfileScreenData["gold"] = { status: "ready", value: { total: 173_200, committed: null, claimable: null, tokens: null, usdc: null, sui: null, suiQty: null } };

test("R3-76-AC-1 (OA-14): one's own profile: the Profile header, Edit profile (a dialog) alone (Invites and Settings live in the account menu), status; no gold card or holdings", () => {
  const html = at(<ProfileScreen data={OWN_DATA} nowMs={FIXTURE_NOW} onEdit={() => {}} profile={KAI} />, { callsign: "kai" });
  assert.match(html, /<h1[^>]*>Profile<\/h1>/);
  // All owner actions are the shared secondary control with decorative icons; Edit opens the sheet.
  assert.match(
    html,
    /<div class="profActs"><button aria-haspopup="dialog" aria-label="Edit profile"[^>]*data-ui-icon=""[^>]*><svg aria-hidden="true"[^>]*>.*?<\/svg><\/button><\/div>/,
  );
  assert.match(text(html), /Sharing activity/);
  // R3-04: the chip uses the one app-wide `.status` definition (Open pink, Trading neutral),
  // not a hashed module class that would miss it.
  assert.match(html, /<span class="status" data-tone="trading">Sharing activity<\/span>/);
  // The gold card, its composition, Deposit / Withdraw and the holdings are on Portfolio (R3-74), even with figures to hand.
  const withFigures = at(<ProfileScreen data={{ ...OWN_DATA, gold: LUCA_GOLD }} nowMs={FIXTURE_NOW} onEdit={() => {}} profile={{ ...KAI, portfolio_public: true }} />, { callsign: "kai" });
  for (const page of [html, withFigures]) {
    assert.doesNotMatch(page, /gold2|Presale portfolio|Your holdings|Committed|Claimable|Deposit|Withdraw|Hide amounts/);
    assert.match(text(page), /CreatedBackedActivity/);
  }
  // Someone else's profile: Follow, no Settings.
  const other = at(<ProfileScreen data={{ ...OWN_DATA, own: false }} nowMs={FIXTURE_NOW} onEdit={() => {}} profile={KAI} />, { callsign: "mira" });
  assert.doesNotMatch(other, /Edit profile|href="\/settings"|profActs/);
});

test("R3-76-AC-1 (OA-10): another account's public portfolio keeps its gold card", () => {
  const html = at(<ProfileScreen data={{ ...OWN_DATA, own: false, gold: LUCA_GOLD }} nowMs={FIXTURE_NOW} onEdit={() => {}} profile={{ ...KAI, portfolio_public: true }} />, { callsign: "mira" });
  assert.match(html, /class="gold gold2"/);
  assert.match(text(html), /Presale portfolioPublic\$173,200\.00/);
  // Not public: no card.
  assert.doesNotMatch(at(<ProfileScreen data={{ ...OWN_DATA, own: false, gold: LUCA_GOLD }} nowMs={FIXTURE_NOW} onEdit={() => {}} profile={KAI} />), /gold2/);
});

test("OA-25 Q16 (R3-08): with a month of daily snapshots the slot draws the line and the read's change; the box is the same", () => {
  const points = Array.from({ length: 31 }, (_, day) => ({
    day: new Date(Date.UTC(2026, 8, 5 + day)).toISOString().slice(0, 10),
    value_usd: day === 30 ? "4760.34" : `${4000 + day * 10}.00`,
  }));
  const trend = trendFrom({ days: 30, points, change_bps: "1901" });
  const PUBLIC = { ...KAI, portfolio_public: true };
  const html = at(<ProfileScreen data={{ ...OWN_DATA, own: false, gold: LUCA_GOLD, trend }} nowMs={FIXTURE_NOW} onEdit={() => {}} profile={PUBLIC} />);
  // OA-28 M4: the line is recharts, drawn in the browser only; the server writes its box (empty) and the caption.
  assert.match(html, /<div aria-label="30-day trend: up 19%" class="g2Chart" role="img"><div class="g2Spark" data-slot="portfolio-sparkline"><\/div>/);
  assert.match(html, /<span class="g2Cap">30 days <b>\+19%<\/b><\/span>/);
  // An undefined change (zero 30 days ago): the line, no figure.
  const flat = at(<ProfileScreen data={{ ...OWN_DATA, own: false, gold: LUCA_GOLD, trend: trendFrom({ days: 30, points, change_bps: null }) }} nowMs={FIXTURE_NOW} onEdit={() => {}} profile={PUBLIC} />);
  assert.match(flat, /<div aria-label="30-day trend" class="g2Chart" role="img">/);
  assert.doesNotMatch(flat, /g2Cap/);
});

test("UI-06: calls load, fail and come back empty with the design's copy", () => {
  const screen = (calls: ProfileScreenData["calls"]) => text(at(<ProfileScreen data={{ ...OWN_DATA, own: false, calls }} nowMs={FIXTURE_NOW} onEdit={() => {}} profile={KAI} />));
  assert.match(at(<ProfileScreen data={{ ...OWN_DATA, own: false, calls: { status: "loading" } }} nowMs={FIXTURE_NOW} onEdit={() => {}} profile={KAI} />), /aria-label="Loading presale calls"/);
  assert.match(screen({ status: "error" }), /Calls could not load/);
  assert.match(screen({ status: "ready", value: { ...CALLS, calls: [], track_record: { presales_backed: 0, launched: 0, pnl_usd: null } } }), /No presales backed yet/);
});

test("UI-06 (§5.5): the right column: someone's open calls and the presales backed together; one's own watchlist", () => {
  const open = call("open", { multiple: null, price_usd: null, value_usd: null, pnl_usd: null, committed_usd: "15000.00" });
  const others = at(
    <ProfileAsideCards
      calls={{ ...CALLS, calls: [open] }}
      firstName="Luca"
      hidden={false}
      me={{ created: [], positions: [{ presale: open.presale, committed_usd: "100.00", committed_atoms: "100000000", status: "open", claimed_tokens: null, refunded_usd: null, refunded_atoms: null, value_usd: null, multiple: null, ...NO_COST_BASIS }], watchlist: [], coins: [], vestings: [] }}
      nowMs={FIXTURE_NOW}
      own={false}
    />,
  );
  assert.match(text(others), /In right nowKestrel73% filled · 1h 0m left\$15,000/);
  assert.match(text(others), /Backed together1KestrelYou \$100 · Luca \$15,000Open/);
  const own = at(<ProfileAsideCards calls={null} firstName="Kai" hidden={false} me={{ created: [], positions: [], watchlist: [], coins: [], vestings: [] }} nowMs={FIXTURE_NOW} own />);
  assert.match(text(own), /WatchlistNo saved presales/);
  assert.doesNotMatch(text(own), /In right now/);
});
