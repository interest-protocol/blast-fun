import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { defineBlastDeployment, type VenueAvailability } from "@interest-protocol/blast-sdk/deployments";

import type { ActionState } from "../transaction/action-machine";
import type { ActionController } from "../transaction/controller";
import { LaunchpadSignerProvider } from "../transaction/LaunchpadSignerProvider";
import { coinTradeActions } from "./coin-trade-slot";
import type { VenueTradeInput } from "./venue-adapter";
import { readVenueAvailability, readVenueRoute, type VenueLocator, type VenueRouteRead } from "./venue-route";
import { BLUEFIN_LAUNCH_ID, BLUEFIN_MIGRATION_DIGEST, BLUEFIN_POOL_ID, CETUS_LAUNCH_ID, CETUS_MIGRATION_DIGEST, CETUS_POOL_ID, createVenueFixtureChain, VENUE_FIXTURE_MANIFEST, type VenueFixtureChain } from "../../../../test/fixtures/launchpad/trade/venue-fixtures.ts";
import { VenueTradeProvider } from "./VenueTradeProvider";
import { VenueTradeRail } from "./VenueTradeRail";
import { describeVenueTrade } from "./venue-trade-rail-model";

const deployment = defineBlastDeployment(VENUE_FIXTURE_MANIFEST);
const NOW = 1_790_000_000_000;
const CETUS: VenueLocator = { launchId: CETUS_LAUNCH_ID, migrationDigest: CETUS_MIGRATION_DIGEST, poolKey: `cetus:${CETUS_POOL_ID}` };
const BLUEFIN: VenueLocator = { launchId: BLUEFIN_LAUNCH_ID, migrationDigest: BLUEFIN_MIGRATION_DIGEST, poolKey: `bluefin:${BLUEFIN_POOL_ID}` };

/** Controllers frozen in `state` (both directions), for rendering one phase. */
function frozen(state: ActionState<VenueTradeInput>) {
  const controller: ActionController<VenueTradeInput> = {
    getState: () => state,
    subscribe: () => () => {},
    edit() {},
    submit() {},
    chooseSigner() {},
    cancel() {},
    approve() {},
    recheck() {},
    acknowledge() {},
    onInvalidate: () => () => {},
  };
  return { buy: controller, sell: { ...controller, getState: () => ({ phase: "editing", input: { ...state.input, direction: "sell" }, attempt: 0, notice: null }) as ActionState<VenueTradeInput> } };
}

function render(
  fixture: VenueFixtureChain,
  locator: VenueLocator,
  route: VenueRouteRead,
  availability?: VenueAvailability,
  controllers?: ReturnType<typeof frozen>,
) {
  let bridges = 0;
  const html = renderToStaticMarkup(
    <LaunchpadSignerProvider kinds={["wallet", "privy"]} renderBridge={() => void (bridges += 1)}>
      <VenueTradeProvider
        chain={{ client: fixture.client, manifest: VENUE_FIXTURE_MANIFEST, mode: "non-production" }}
        locator={locator}
        initialRoute={route}
        initialAvailability={availability}
        controllers={controllers}
      >
        <VenueTradeRail />
      </VenueTradeProvider>
    </LaunchpadSignerProvider>,
  );
  return { html, text: html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " "), bridges };
}

async function cetus(fixture = createVenueFixtureChain()) {
  const chain = { client: fixture.client, manifest: VENUE_FIXTURE_MANIFEST, mode: "non-production" as const };
  return { fixture, route: await readVenueRoute(fixture.client, deployment, CETUS, NOW), availability: await readVenueAvailability(chain, "cetus") };
}

test("signed out, the venue rail offers Buy and Sell on the recorded Cetus pool, with the pool price it observed and no venue choice", async () => {
  const { fixture, route, availability } = await cetus();
  assert.deepEqual(availability, { available: true });
  const { html, text, bridges } = render(fixture, CETUS, route, availability);
  assert.match(text, /Buy Sell/);
  assert.match(text, /You pay \(SUI\)/);
  assert.match(text, /You sell \(FROG\)/);
  assert.match(text, /Pool price 1 FROG = 0\.0₄55 SUI/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Review buy<\/button>/);
  // No control names another venue or pool: the route is the launch's own.
  assert.doesNotMatch(html, /<select|Bluefin/);
  assert.doesNotMatch(text, /\b(long|short|leverage|leveraged|margin|liquidat)/i);
  assert.equal(bridges, 0);
  assert.equal(fixture.calls.simulate, 0);
});

test("an unavailable Cetus venue keeps the route and price readable and names the SDK's reason", async () => {
  const { fixture, route, availability } = await cetus(createVenueFixtureChain({ cetusConfig: "mismatch" }));
  assert.equal(availability.available, false);
  const { html, text } = render(fixture, CETUS, route, availability);
  assert.match(html, /data-venue-unavailable=""/);
  assert.match(text, /Cetus CLMM trading is unavailable for this Blast deployment \(venue-unavailable: runtime-mismatch\)\. Nothing can be signed\./);
  assert.match(text, /Pool price 1 FROG = /);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Review buy<\/button>/);
});

async function bluefin(fixture = createVenueFixtureChain()) {
  const chain = { client: fixture.client, manifest: VENUE_FIXTURE_MANIFEST, mode: "non-production" as const };
  return { fixture, route: await readVenueRoute(fixture.client, deployment, BLUEFIN, NOW), availability: await readVenueAvailability(chain, "bluefin") };
}

test("signed out, a Bluefin-migrated launch offers Buy and Sell on its recorded Bluefin pool, with the pool price it observed and no venue choice", async () => {
  const { fixture, route, availability } = await bluefin();
  assert.deepEqual(availability, { available: true });
  const { html, text, bridges } = render(fixture, BLUEFIN, route, availability);
  assert.match(text, /You sell \(NEWT\)/);
  assert.match(text, /Pool price 1 NEWT = 0\.0₄55 SUI/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Review buy<\/button>/);
  assert.doesNotMatch(html, /<select|Cetus/);
  assert.equal(bridges, 0);
  assert.equal(fixture.calls.simulate, 0);
});

test("an unavailable Bluefin venue keeps the route and price readable and names the SDK's reason; nothing can be signed", async () => {
  const { fixture, route, availability } = await bluefin(createVenueFixtureChain({ bluefinConfig: "absent" }));
  assert.equal(availability.available, false);
  const { html, text } = render(fixture, BLUEFIN, route, availability);
  assert.match(html, /data-venue-unavailable=""/);
  assert.match(text, /Bluefin Spot trading is unavailable for this Blast deployment \(venue-unavailable: runtime-unverified\)\. Nothing can be signed\./);
  assert.match(text, /Pool price 1 NEWT = /);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Review buy<\/button>/);
});

test("a Bluefin fee change closes the route with its reason; the launch's history stays readable and nothing can be entered", async () => {
  const fixture = createVenueFixtureChain({ bluefinFeeRate: 2_500n });
  const route = await readVenueRoute(fixture.client, deployment, BLUEFIN, NOW);
  const { html, text } = render(fixture, BLUEFIN, route);
  assert.match(html, /data-venue-refused="route-substitution"/);
  assert.match(text, /The recorded Bluefin Spot route does not match this launch\. Nothing can be signed\. Code: route-substitution\./);
  assert.match(html, /<input[^>]*disabled=""[^>]*inputMode="decimal"|<input[^>]*inputMode="decimal"[^>]*disabled=""/);
});

test("a Bluefin swap refused in simulation for slippage is told in words with what to do, never as a raw Move abort", async () => {
  const { fixture, route, availability } = await bluefin();
  const message = `Sui rejected this transaction in simulation: MoveAbort in 3rd command, abort code: 1010, in '${deployment.packages.bluefinSpot!.originalPackageId}::pool::swap' (instruction 51) Nothing was signed.`;
  const input: VenueTradeInput = { ...BLUEFIN, direction: "buy", amount: "100", slippageBps: 50n };
  const state: ActionState<VenueTradeInput> = { phase: "blocked", input, attempt: 2, block: { stage: "simulation", code: "simulation-failed", message, details: [] } };
  const { html, text } = render(fixture, BLUEFIN, route, availability, frozen(state));
  assert.match(text, /Sui refused this swap in simulation: the Bluefin pool would pay less than the fewest you accept\. Nothing was signed\./);
  assert.match(text, /The Bluefin pool moved past your slippage tolerance after the quote/);
  assert.match(html, /data-guidance="refresh"/);
  assert.doesNotMatch(text, /MoveAbort|abort code/);
});

test("a node outage leaves the route unavailable with a way to read it again", async () => {
  const fixture = createVenueFixtureChain({ reads: "unavailable" });
  const route = await readVenueRoute(fixture.client, deployment, CETUS, NOW);
  const { text } = render(fixture, CETUS, route);
  assert.match(text, /The venue route could not be read from Sui: The external service could not complete this request\. Retry shortly\. Code: service_unavailable\./);
  assert.match(text, /Read the route again/);
  assert.doesNotMatch(text, /fixture node|config::AdminCap/);
});

test("the coin page's trade slot keeps the curve and venue rails apart and names an unsupported venue", () => {
  const actions = coinTradeActions({ status: "unavailable", reason: "Trading opens once this app serves a released Blast deployment. Nothing can be signed here yet." });
  const slot = (venue: string) =>
    renderToStaticMarkup(<>{actions.trade?.({ launchId: CETUS_LAUNCH_ID, coinType: "0x2::sui::SUI", poolKey: `${venue}:${CETUS_POOL_ID}`, venue })}</>);
  assert.match(slot("cetus"), /Trading opens once this app serves a released Blast deployment/);
  // Bluefin Spot has its own driver now: only the deployment reason remains.
  assert.match(slot("bluefin"), /Trading opens once this app serves a released Blast deployment/);
  assert.doesNotMatch(slot("bluefin"), /cannot trade yet/);
  assert.match(slot("other"), /This launch trades on other, which this app cannot trade yet/);
  assert.match(slot("blast_curve"), /data-trade-unavailable/);
  for (const venue of ["cetus", "bluefin", "other", "blast_curve"]) assert.doesNotMatch(slot(venue), /<button/);
});

test("a completed Bluefin swap is described from its own event in the coin's real units", () => {
  const price = { numerator: 1n, denominator: 1n };
  const trade = { side: "buy" as const, quoteAmount: 10_000_000_000n, memeAmount: 181_108_577_044n, quoteFee: 30_000_000n, memeFee: 0n, priceBefore: price, priceAfter: price };
  assert.equal(describeVenueTrade(trade, { symbol: "NEWT", decimals: 6, venue: "bluefin", quote: { coinType: "0x2::sui::SUI", symbol: "SUI", decimals: 9, iconUrl: null } }), "Bought 181,108.577044 NEWT for 10 SUI on Bluefin Spot.");
  assert.equal(
    describeVenueTrade({ ...trade, side: "sell", quoteAmount: 54_563_003_427n, memeAmount: 1_000_000_000_000n }, { symbol: "NEWT", decimals: 6, venue: "bluefin", quote: { coinType: "0x2::sui::SUI", symbol: "SUI", decimals: 9, iconUrl: null } }),
    "Sold 1,000,000 NEWT for 54.563003427 SUI on Bluefin Spot.",
  );
});
