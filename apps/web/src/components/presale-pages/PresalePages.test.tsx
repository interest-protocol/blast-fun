import assert from "node:assert/strict";
import test from "node:test";
import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { renderToStaticMarkup } from "react-dom/server";

import { CLAIM_IDLE, claimSettled, type ClaimView } from "#web/components/social/claim/claims.ts";
import type { Claims } from "#web/components/social/claim/use-claims.tsx";
import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";
import { PREFERRED_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";

import { FIXTURE_NOW, fixtureDetail, fixtureId, fixtureList, fixtureMine, fixtureViewer } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { PresaleCalendar, PresaleRow, PresalesList } from "./PresalesList";
import { SaleAside, SideBox } from "./SaleAside";
import { SaleView, TrustBadges } from "./SaleView";

const text = (html: string) => html.replace(/<style[^>]*>[^<]*<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const signedIn = (node: React.ReactNode, mine = fixtureMine()) => {
  const queries = createTestQueryClient();
  queries.setQueryData([...queryKeys.me.presaleViewerAll, "mine"], mine);
  const entries = fixtureViewer();
  for (const id of Object.keys(entries)) queries.setQueryData(queryKeys.me.presaleViewer([id]), { presales: entries });
  queries.setQueryData(queryKeys.me.presaleViewer(Object.keys(entries)), { presales: entries });
  return withQueryClient(queries, <SocialViewerProvider callsign="kaimoreno" signedIn>{node}</SocialViewerProvider>);
};

test("a newly migrated Bluefin sale shows its claimable amount before any price exists", () => {
  const base = fixtureDetail("kstl");
  const detail = { ...base, presale: { ...base.presale, venue: "bluefin", price_usd: null, presale_price_usd: null, presale_price_quote: null, multiple: null } };
  const entry = { ...fixtureViewer()[fixtureId("kstl")]!, mine: { ...fixtureViewer()[fixtureId("kstl")]!.mine!, claimed: false, claimable_tokens: "440000000000000000", claimed_tokens: "0" } };
  const claims: Claims = { available: true, supports: () => true, view: () => CLAIM_IDLE, run: () => undefined };
  const html = renderToStaticMarkup(signedIn(<SideBox claims={claims} detail={detail} entry={entry} now={FIXTURE_NOW} />));
  assert.match(text(html), /440,000,000 KSTL/);
  assert.match(text(html), /Any refund goes to your wallet with your tokens\. Claim tokens/);
  assert.doesNotMatch(text(html), /Trade KSTL/, "entitlements do not launch a second trade flow");
  assert.doesNotMatch(text(html), /\$0|Your KSTL –/);
  for (const [state, label] of [["claiming", /Claiming tokens/], ["done", /Claim confirmed\. Updating balances\./]] as const) {
    const active = { ...claims, view: () => state === "claiming" ? { state } : { state, digest: "confirmed" } };
    assert.match(renderToStaticMarkup(signedIn(<SideBox claims={active} detail={detail} entry={entry} now={FIXTURE_NOW} />)), label);
  }
  const empty = { ...entry, mine: { ...entry.mine, claimable_tokens: "0" } };
  const atTarget = { ...detail, presale: { ...detail.presale, raised_atoms: detail.presale.target_atoms } };
  assert.doesNotMatch(renderToStaticMarkup(signedIn(<SideBox claims={claims} detail={atTarget} entry={empty} now={FIXTURE_NOW} />)), /data-claim="claim_tokens"/);
  const oversubscribed = { ...detail, presale: { ...detail.presale, raised_atoms: (BigInt(detail.presale.target_atoms) + 1n).toString() } };
  const refund = renderToStaticMarkup(signedIn(<SideBox claims={claims} detail={oversubscribed} entry={empty} now={FIXTURE_NOW} />));
  assert.match(refund, /data-claim="claim_tokens" type="button">Claim<\/button>/);
  const alreadyClaimed = { ...empty, mine: { ...empty.mine, claim_wallet_claimed: true } };
  assert.doesNotMatch(renderToStaticMarkup(signedIn(<SideBox claims={claims} detail={oversubscribed} entry={alreadyClaimed} now={FIXTURE_NOW} />)), /data-claim="claim_tokens"/);
  const otherWallet = { ...empty, mine: { ...empty.mine, claim_wallet_participated: false } };
  assert.doesNotMatch(renderToStaticMarkup(signedIn(<SideBox claims={claims} detail={oversubscribed} entry={otherWallet} now={FIXTURE_NOW} />)), /data-claim="claim_tokens"/);
  const vesting = { ...oversubscribed, terms: { ...detail.terms!, buyer_vesting: { cliff_ms: "86400000", duration_ms: "604800000" } } };
  const vestingRefund = renderToStaticMarkup(signedIn(<SideBox claims={claims} detail={vesting} entry={empty} now={FIXTURE_NOW} />));
  assert.match(vestingRefund, /data-claim="claim_tokens" type="button">Claim<\/button>/);
  assert.doesNotMatch(text(vestingRefund), /starts vesting|Start your vesting/);
});

test("UI-09: the list renders the design's rows, sorts and the empty and error states", () => {
  const live = fixtureList("live", "ending");
  const listQueries = createTestQueryClient();
  listQueries.setQueryData(queryKeys.me.presaleViewer(live.presales.map(s => s.presale_id)), {presales: fixtureViewer()});
  const html = renderToStaticMarkup(withQueryClient(listQueries, <SocialViewerProvider callsign="kaimoreno" signedIn>
    <PresalesList initial={live} layout="list" nowMs={FIXTURE_NOW} sort="ending" status="live" view="list" />,
  </SocialViewerProvider>));
  const words = text(html);
  assert.match(words, /Presales/);
  assert.match(html, /aria-label="Filters, Ending soon"/);
  assert.doesNotMatch(words, /Fastest filling|Most backed|Backed by people you follow/);
  assert.ok(!words.includes("Watchlist"), "no Watchlist chip without a watchlist");
  assert.match(words, /Tidal Known deployer TIDE Ends in 2m 99\.65% 398,600 USDC raised of a 400,000 USDC target, 99\.65 percent funded\. 398,600 of 400,000 USDC 2,216 backers/);
  assert.match(words, /Meridian Known deployer MRDN Audited Ends in 6h 13m 73\.68% 184,221 USDC raised of a 250,000 USDC target, 73\.68 percent funded\. 184,221 of 250,000 USDC 1,012 backers/);
  assert.match(words, /\d+ people you follow backed/);
  assert.match(html, /href="\/presale\/0x0{56}6d72646e"/);
  assert.match(html, /aria-label="Filters, Ending soon"/);

  const watch = renderToStaticMarkup(<PresalesList initial={live} nowMs={FIXTURE_NOW} sort="watch" status="live" view="list" watchlist={{ ids: new Set(), signedIn: true }} />);
  assert.match(text(watch), /No saved presales yet/);
  assert.match(text(watch), /Add to watchlist/);
  assert.match(text(watch), /Show all live presales/);
  const signedOutWatch = renderToStaticMarkup(<PresalesList initial={live} nowMs={FIXTURE_NOW} sort="ending" scope="watch" status="live" view="list" watchlist={{ ids: new Set(live.presales.map((sale) => sale.presale_id)), signedIn: false }} />);
  assert.match(text(signedOutWatch), /Sign in to see your saved presales, or show all live presales ?\. Sign in/);
  // One action per empty state: Show all is a link inside the sentence, to the unscoped list.
  const showAll = signedOutWatch.match(/<a class="[^"]*empty-link[^"]*" href="([^"]+)">show all live presales<\/a>/);
  assert.ok(showAll, "show all is an in-sentence link");
  assert.doesNotMatch(showAll[1]!, /scope=/);
  assert.doesNotMatch(signedOutWatch, /class="[^"]*sr-name/);

  const failed = renderToStaticMarkup(<PresalesList initial={null} nowMs={FIXTURE_NOW} sort="ending" status="live" view="list" />);
  assert.match(failed, /role="alert"/);
  assert.match(text(failed), /Presales couldn’t load/);
});

test("the calendar renders grouped UTC events with exact targets and one link per row", () => {
  const sales = fixtureList("upcoming", "opening").presales;
  const html = renderToStaticMarkup(<PresaleCalendar now={FIXTURE_NOW} range="all" sales={sales} />);
  const words = text(html);
  assert.match(words, /14 Oct ’26/);
  assert.match(html, /aria-label="Wednesday, October 14, 2026"/);
  assert.match(html, /title="2026-10-14 18:00:00 UTC"/);
  assert.match(words, /18:00 Sable SABL Opening Raise target 400,000 USDC/);
  assert.equal((words.match(/All times UTC/g) ?? []).length, 1);
  assert.doesNotMatch(words, /View presale/);
  assert.equal((html.match(/<a /g) ?? []).length, sales.length * 2);
  assert.match(text(renderToStaticMarkup(<PresaleCalendar now={FIXTURE_NOW} sales={[]} />)), /No upcoming events/);
});

test("the calendar renders seeded live, upcoming, and ended events independently of lifecycle status", () => {
  const live = fixtureList("live", "ending");
  const upcoming = fixtureList("upcoming", "opening");
  const ended = fixtureList("ended", "recent");
  const html = renderToStaticMarkup(withQueryClient(createTestQueryClient(), <PresalesList initial={live} calendar={upcoming} calendarLive={live} calendarEnded={ended} nowMs={FIXTURE_NOW} sort="ending" status="live" view="calendar" />));
  const words = text(html);
  assert.match(words, /Closing/);
  assert.ok(words.includes(live.presales[0]!.name));
  assert.ok(words.includes(upcoming.presales[0]!.name));
  assert.match(html, /aria-label="Calendar event range"/);
  assert.match(html, /aria-pressed="true"[^>]*>Upcoming/);
  assert.doesNotMatch(html, /role="tablist"/);
});

test("Owner 2026-10-28: a trading coin's right column is the ticket, then Tokenomics; no followed-holders line (less text)", () => {
  const html = renderToStaticMarkup(signedIn(<SaleAside detail={fixtureDetail("kstl")} kit={null} nowMs={FIXTURE_NOW} />));
  assert.match(text(html), /Tokenomics/);
  assert.doesNotMatch(html, /coin-followed|coin-faces/);
  assert.doesNotMatch(text(html), /you follow,? holds?/);
});

test("UI-10: the sale page shows the design's figures, backers and terms; a visitor signs in to blast in", () => {
  const mrdn = fixtureDetail("mrdn");
  const viewer = fixtureViewer()[fixtureId("mrdn")];
  const words = text(renderToStaticMarkup(signedIn(<SaleView detail={mrdn} nowMs={FIXTURE_NOW} viewerEntry={viewer} />)));
  // The Sale board: name, ticker and pills; the raise in its coin with its target and four tiles; the state line.
  assert.match(words, /Meridian \$MRDN Known deployer Live Audited Created by Luca Romano/);
  // A USDC sale's money figures name the coin, as every other sale's do (owner, 2026-10-27); prices stay in dollars.
  // The committed tween still counts with `usd` (pinned by blast-ui/number-spots.test.ts).
  assert.match(words, /184,221 USDC of 250,000 USDC 73\.68% funded Total supply 1 billion · Fixed Ends in 6h 12m Backers 1,012 Launches on Cetus/);
  assert.match(words, /Opened 2 Oct ’26 Closes 4 Oct ’26 Then trades on Cetus/);
  assert.match(words, /People you follow Luca Romano .* 15,000 USDC/);
  assert.match(words, /Top 10 backers hold \d+\.\d% of the raise/);
  assert.match(words, /Luca Romano Following 15,000 USDC 8\.14%/);
  assert.match(words, /The 25 largest of 1,012 backers/);
  // The 2 × 2 terms, then Terms: the raise, the launch price and the team's vesting.
  assert.match(words, /Tokenomics Presale buyers 45% 450M MRDN/);
  assert.match(words, /Where the money goes Of 250K USDC Liquidity pool 75% 187,500 USDC/);
  assert.match(words, /Rules Per wallet 10 USDC to 25,000 USDC Can raise above target Tokens are split by share of commitments\. Excess payment is refunded\. Under target Full refund Withdrawals Not allowed Commit fee None/);
  assert.match(words, /Terms Raise 250,000 USDC Launch price \$0\.000625 Team vesting Vests 12 mo, 3-mo cliff/);
  assert.doesNotMatch(words, /\$[\d,.]+[kKMB]? USDC/, "no figure carries two units");

  const visitor = renderToStaticMarkup(<SideBox detail={mrdn} entry={null} now={FIXTURE_NOW} />);
  assert.match(text(visitor), /Blast Sign in to commit/);
  assert.match(visitor, /href="\/sign-in\?next=/);
  const member = renderToStaticMarkup(signedIn(<SideBox detail={mrdn} entry={viewer} now={FIXTURE_NOW} />));
  assert.match(member, /<button[^>]*disabled=""[^>]*>Commit USDC<\/button>/);
  assert.match(text(member), /Commits open here once the sale contract is live on Sui\. You've committed 100 USDC/);
});

test("a delayed funding cap preserves the allocation and refund terms above target", () => {
  const base = fixtureDetail("mrdn");
  const detail = {
    ...base,
    presale: {
      ...base.presale,
      hard_cap: true,
      raised_atoms: (BigInt(base.presale.target_atoms) + 1n).toString(),
    },
    terms: {
      ...base.terms!,
      hard_cap: true,
      public_buy: {
        from_ms: base.presale.start_ms,
        min_atoms: "1",
        hard_cap_from_ms: base.presale.start_ms + 60_000,
      },
    },
  };
  const words = text(renderToStaticMarkup(<SaleView detail={detail} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  assert.match(words, /Funding cap 250,000 USDC from .*? Above target Tokens are split by share of commitments\. Excess payment is refunded\./);
  const cancelled = { ...detail, presale: { ...detail.presale, phase: "cancelled" as const } };
  const refund = text(renderToStaticMarkup(<SaleView detail={cancelled} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  assert.match(refund, /Sale cancelled\. Everyone can claim a full refund\./);
  assert.match(refund, /Above target Full refund\. No tokens are allocated\./);
  assert.doesNotMatch(refund, /The target was missed/);
});

test("the sale header names its creator and links their profile, with a wallet fallback", () => {
  const detail = fixtureDetail("mrdn");
  const render = (creator: typeof detail.creator) => renderToStaticMarkup(<SaleView detail={{ ...detail, creator }} nowMs={FIXTURE_NOW} viewerEntry={null} />).split('</section>')[0]!;
  const named = render(detail.creator);
  assert.match(text(named), /Created by Luca Romano/);
  assert.match(named, /href="\/@lucaromano"/);
  assert.match(text(render({ wallet: detail.creator!.wallet, account: { ...detail.creator!.account!, display_name: null } })), /Created by @lucaromano/);
  const wallet = render({ wallet: detail.creator!.wallet, account: null });
  assert.match(text(wallet), /Created by 0x/);
  assert.match(wallet, /aria-label="Created by 0x[\da-f]{4}…[\da-f]{4}\. Copy creator wallet address"/);
  assert.doesNotMatch(wallet, /lucaromano|Luca Romano/);
  assert.doesNotMatch(render(null), /Created by/);
});

test("R3-23: the sale page's trust pills read the operator-set flags in the boards' words; the coin page states the LP lock (OA-26); a known deployer gets the pink helmet by the name", () => {
  const badges = (flags: Readonly<{ verified_team: boolean; audited: boolean }>, lpLocked = false) => renderToStaticMarkup(<TrustBadges lpLocked={lpLocked} sale={flags} />);
  const none = badges({ verified_team: false, audited: false });
  assert.equal(text(none).trim(), "Project team unconfirmed", "a sale nobody checked: the gate's warning");
  assert.match(none, /class="[^"]*sale-pill warn[^"]*"/);
  assert.equal(text(badges({ verified_team: true, audited: false })).trim(), "", "the Known deployer badge sits by the name");
  assert.equal(text(badges({ verified_team: false, audited: true })).trim(), "Project team unconfirmed Audited");
  assert.equal(text(badges({ verified_team: true, audited: true })).trim(), "Audited");
  assert.equal(text(badges({ verified_team: true, audited: false }, true)).trim(), "LP locked");
  assert.doesNotMatch(badges({ verified_team: true, audited: true }), /sale-pill warn/);

  // The page renders the pills from its own payload: Meridian is verified and audited in the dev fixture.
  const meridian = renderToStaticMarkup(signedIn(<SaleView detail={fixtureDetail("mrdn")} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  const words = text(meridian);
  assert.match(words, /Meridian \$MRDN Known deployer Live Audited/);
  assert.match(meridian, /class="coinVerifiedPill" title="Known deployer"><svg aria-hidden="true" class="coinVerified lg"/, "the pill owns the hover title and its helmet is decorative");
  assert.doesNotMatch(words, /LP locked/, "a sale that has not launched has no pool to lock yet");
  const ondine = renderToStaticMarkup(signedIn(<SaleView detail={fixtureDetail("ondn")} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  assert.match(text(ondine), /Project team unconfirmed/);
  assert.doesNotMatch(ondine, /coinVerified/, "an unchecked deployer gets no helmet");
  assert.doesNotMatch(text(ondine), /Audited/);
  const trading = text(renderToStaticMarkup(signedIn(<SaleView detail={fixtureDetail("kstl")} nowMs={FIXTURE_NOW} viewerEntry={null} />)));
  assert.match(trading, /Known deployer.*LP locked/);
  const cancelled = text(renderToStaticMarkup(signedIn(<SaleView detail={fixtureDetail("hlcn")} nowMs={FIXTURE_NOW} viewerEntry={null} />)));
  assert.doesNotMatch(cancelled, /LP locked|No team unlocks — sale cancelled/);
  assert.match(cancelled, /full refund/);
});

test("UI-10: each phase's side box says the design's words", () => {
  const box = (key: string, signed = true) => text(renderToStaticMarkup(
    signed ? signedIn(<SideBox detail={fixtureDetail(key)} entry={fixtureViewer()[fixtureId(key)]} now={FIXTURE_NOW} />)
      : <SideBox detail={fixtureDetail(key)} entry={null} now={FIXTURE_NOW} />,
  ));
  assert.equal(box("sabl").trim(), "Blast Open to everyone No whitelist You can buy 25 USDC to 20,000 USDC Per wallet · ≈ 25,000 to 20M SABL You can buy when the sale opens. Notify me");
  assert.match(box("cblt"), /Funded 1\.25× Claims open when trading starts on Bluefin ?\. Everyone gets 80% of their amount in tokens and the rest back\. You committed 500 USDC Estimated tokens 401,413 CBLT Estimated refund 98\.587026 USDC/);
  assert.match(box("kstl"), /Your KSTL \$1,260 600,000 KSTL · 4\.2× since the presale/);
  assert.equal(box("kstl", false), "");
  assert.match(box("hlcn"), /Your refund 250 USDC Claim refund/);
  assert.match(box("hlcn", false), /Refunds are open/);
});

test("R3-63: with the shell's claim path the side box claims: the refund and a launched sale's tokens, `Claiming`, the refusal, `Claimed`", () => {
  const views: Record<string, ClaimView> = {};
  const runs: string[] = [];
  const claims: Claims = {
    available: true,
    supports: (kind) => kind !== "claim_vesting",
    view: (key) => views[key] ?? CLAIM_IDLE,
    run: (target) => void runs.push(target.key),
  };
  const box = (key: string, entry = fixtureViewer()[fixtureId(key)] ?? null) =>
    renderToStaticMarkup(signedIn(<SideBox claims={claims} detail={fixtureDetail(key)} entry={entry} now={FIXTURE_NOW} />));
  const hlcn = fixtureId("hlcn");
  const refund = box("hlcn");
  assert.match(refund, /class="coin-amount" title="USDC">250/);
  assert.match(refund, /<button class="[^"]*btn-primary[^"]*" data-claim="claim_refund" type="button">Claim refund<\/button>/);
  const usdSui = PREFERRED_COINS[2];
  const detail = fixtureDetail("hlcn");
  const usdSuiDetail = { ...detail, presale: { ...detail.presale, quote_symbol: usdSui.symbol, quote_type: usdSui.coinType } };
  const usdSuiRefund = renderToStaticMarkup(signedIn(<SideBox claims={claims} detail={usdSuiDetail} entry={fixtureViewer()[hlcn]} now={FIXTURE_NOW} />));
  assert.match(usdSuiRefund, /class="coin-amount" title="USDsui">250/);
  assert.ok(usdSuiRefund.includes(usdSui.logoUrl));
  assert.match(text(usdSuiRefund), /Your refund 250 USDsui Claim refund/);
  assert.doesNotMatch(refund, /once the sale contract is live/, "a working claim carries no 'not yet' note");
  views[`refund:${hlcn}`] = { state: "claiming" };
  assert.match(box("hlcn"), /aria-busy="true" aria-disabled="true"[^>]*data-claim="claim_refund" type="button"><span aria-label="Claiming"[^>]*role="status">/);
  views[`refund:${hlcn}`] = claimSettled({ status: "failed", code: "already_claimed" });
  assert.match(
    box("hlcn"),
    /data-claim-refusal="already_claimed" role="alert">There(&#x27;|’|')s nothing left to claim here\. It may already be in your wallet\. Code: already_claimed\.<\/p>/,
  );
  views[`refund:${hlcn}`] = claimSettled({ status: "confirmed", digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" });
  assert.match(text(box("hlcn")), /Refunded/);
  assert.doesNotMatch(box("hlcn"), /data-claim=/);

  // A launched sale the viewer has not claimed: claim the tokens (OA-13); once claimed, no button.
  const kstl = fixtureViewer()[fixtureId("kstl")]!;
  const unclaimed = { ...kstl, mine: { ...kstl.mine!, claimed: false } };
  assert.match(text(box("kstl", unclaimed)), /Your KSTL \$1,260 600,000 KSTL · 4\.2× since the presale Any refund goes to your wallet with your tokens\. Claim tokens/);
  assert.doesNotMatch(box("kstl"), /data-claim=/);

  // Without a path (no mainnet deployment, a visitor): the refund stays the disabled button with its note.
  const off = renderToStaticMarkup(signedIn(<SideBox detail={fixtureDetail("hlcn")} entry={fixtureViewer()[hlcn]} now={FIXTURE_NOW} />));
  assert.match(off, /disabled=""[^>]*>Claim refund<\/button>/);
  assert.match(text(off), /Refunds are claimed here once the sale contract is live on Sui\./);
  assert.doesNotMatch(renderToStaticMarkup(signedIn(<SideBox detail={fixtureDetail("kstl")} entry={unclaimed} now={FIXTURE_NOW} />)), /Claim tokens/);
  assert.deepEqual(runs, []);
});

test("UI-10: the Terms card states the team's chain schedule, or says when it will exist", () => {
  const mrdn = fixtureDetail("mrdn");
  const withSchedule = text(renderToStaticMarkup(<SaleView detail={mrdn} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  // The row names the exact cliff and duration in the schedule's units.
  assert.match(withSchedule, /Team vesting Vests 12 mo, 3-mo cliff/);
  const noCliff = text(renderToStaticMarkup(<SaleView detail={{ ...mrdn, team_vesting: { ...mrdn.team_vesting!, cliff_end_ms: mrdn.team_vesting!.start_ms } }} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  assert.match(noCliff, /Team vesting Vests 12 mo (?!,)/);
  const before = text(renderToStaticMarkup(<SaleView detail={{ ...mrdn, team_vesting: null, terms: { ...mrdn.terms!, supply: { ...mrdn.terms!.supply, recipients: mrdn.terms!.supply.recipients.map((recipient) => ({ ...recipient, vesting: null })) } } }} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  assert.match(before, /Team vesting Team schedule not confirmed yet/);
  const trading = text(renderToStaticMarkup(<SaleView detail={{ ...fixtureDetail("kstl"), team_vesting: null }} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  assert.match(trading, /Team vesting No confirmed team schedule available/);
});

test("a presale with one backer uses singular count copy", () => {
  const sale = { ...fixtureList("live", "ending").presales[0]!, participants: 1 };
  const words = text(renderToStaticMarkup(<PresaleRow sale={sale} now={FIXTURE_NOW} viewer={null} />));
  assert.match(words, /1 backer/);
  assert.doesNotMatch(words, /1 backers/);
});

test("buyer vesting distinguishes the initial escrow claim from releases to the active wallet", () => {
  const base = fixtureDetail("kstl");
  const detail = { ...base, terms: { ...base.terms!, buyer_vesting: { cliff_ms: "86400000", duration_ms: "604800000" } } };
  const entry = fixtureViewer()[base.presale.presale_id]!;
  const mine = { ...entry.mine!, claimed: false, claim_wallet_claimed: false, claim_wallet_participated: true, claimable_tokens: "440000000000000001", buyer_vesting: null };
  const claims: Claims = { available: true, supports: () => true, view: () => CLAIM_IDLE, run: () => {} };
  const render = (position: typeof mine | (Omit<typeof mine, "buyer_vesting"> & { buyer_vesting: { schedule_id: string; beneficiary: string; total: string; claimed: string; remaining: string } })) => renderToStaticMarkup(signedIn(<SideBox claims={claims} detail={detail} entry={{ ...entry, mine: position }} now={FIXTURE_NOW} />));
  const initial = text(render(mine));
  assert.match(initial, /Your buyer vesting/);
  assert.match(initial, /Start your vesting/);
  assert.doesNotMatch(initial, /receive your tokens in your wallet|Presale tokens claimed/);
  const active = render({ ...mine, claim_wallet_claimed: true, buyer_vesting: { schedule_id: `0x${"cd".repeat(32)}`, beneficiary: `0x${"ab".repeat(32)}`, total: "440000000000000001", claimed: "100000000000000001", remaining: "340000000000000000" } });
  assert.match(text(active), /Claimed to date ≈ 100.00M KSTL Unclaimed ≈ 340.00M KSTL/);
  assert.match(active, /href="\/vesting\/0xcd/);
  assert.doesNotMatch(active, /Start your vesting/);
  const otherWallet = text(render({ ...mine, claim_wallet_participated: false, claimable_tokens: null } as unknown as typeof mine));
  assert.match(otherWallet, /another linked wallet/);
  assert.doesNotMatch(otherWallet, /Start your vesting|Claimed to date 0/);
  const unavailable = text(render({ ...mine, claim_wallet_participated: true, claimable_tokens: null } as unknown as typeof mine));
  assert.match(unavailable, /Awaiting vesting Unavailable/);
  assert.doesNotMatch(unavailable, /Start your vesting/);
});
