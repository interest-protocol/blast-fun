import assert from "node:assert/strict";
import test from "node:test";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import type { ActionPhase } from "../transaction/action-machine.ts";
import { createActionController, type SignerSource } from "../transaction/controller.ts";
import { fixturePrivySigner, fixtureWalletSigner, type FixtureSignerBehavior } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import type { LaunchpadSigner } from "../transaction/signer.ts";
import { venueTradeAdapter, type VenueTradeInput } from "./venue-adapter.ts";
import { readRecordedSwap, readVenueRoute } from "./venue-route.ts";
import { gateVenueTrades, venueProblem } from "./venue-session.ts";
import {
  BLUEFIN_LAUNCH_ID,
  BLUEFIN_MIGRATION_DIGEST,
  BLUEFIN_POOL_ID,
  BLUEFIN_VAULT_ID,
  CETUS_LAUNCH_ID,
  CETUS_MIGRATION_DIGEST,
  CETUS_POOL_ID,
  createVenueFixtureChain,
  VENUE_FIXTURE_MANIFEST,
  type VenueFixtureChain,
} from "../../../../test/fixtures/launchpad/trade/venue-fixtures.ts";

const IN_FLIGHT: ReadonlySet<ActionPhase> = new Set(["connecting", "preflighting", "signing", "reconciling"]);
const CETUS_PACKAGE = normalizeSuiAddress(VENUE_FIXTURE_MANIFEST.packages.cetusClmm.packageId);
const BLUEFIN_PACKAGE = normalizeSuiAddress(VENUE_FIXTURE_MANIFEST.packages.bluefinSpot.packageId);
/** The Bluefin-migrated launch's locator, as the page supplies it. */
const BLUEFIN: Partial<VenueTradeInput> = { launchId: BLUEFIN_LAUNCH_ID, migrationDigest: BLUEFIN_MIGRATION_DIGEST, poolKey: `bluefin:${BLUEFIN_POOL_ID}` };
const short = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;

function harness(
  input: Partial<VenueTradeInput> = {},
  options: Readonly<{ fixture?: VenueFixtureChain; kind?: "wallet" | "privy"; behavior?: FixtureSignerBehavior; now?: () => number }> = {},
) {
  const fixture = options.fixture ?? createVenueFixtureChain();
  const counts = { signatures: 0, signed: [] as string[], invalidated: [] as (readonly string[])[] };
  const behavior: FixtureSignerBehavior = {
    ...options.behavior,
    onRequest: () => {
      counts.signatures += 1;
      options.behavior?.onRequest?.();
    },
  };
  let connected: LaunchpadSigner | null = null;
  const signers: SignerSource = {
    kinds: ["wallet", "privy"],
    current: () => connected,
    async connect(kind) {
      connected = kind === "privy" ? fixturePrivySigner(behavior) : fixtureWalletSigner(behavior);
      return connected;
    },
  };
  const full: VenueTradeInput = {
    launchId: CETUS_LAUNCH_ID,
    migrationDigest: CETUS_MIGRATION_DIGEST,
    poolKey: `cetus:${CETUS_POOL_ID}`,
    direction: "buy",
    amount: "10",
    slippageBps: 100n,
    ...input,
  };
  let reviews = 0;
  const controller = createActionController({
    adapter: venueTradeAdapter(full.direction, { now: options.now }),
    chain: { client: fixture.client, manifest: VENUE_FIXTURE_MANIFEST, mode: "non-production" },
    signers,
    input: full,
    newReviewId: () => `review-${(reviews += 1)}`,
  });
  controller.onInvalidate((keys) => counts.invalidated.push(keys));
  return { fixture, counts, controller, kind: options.kind ?? "wallet" };
}

type Harness = ReturnType<typeof harness>;

async function settle({ controller }: Harness) {
  for (let turn = 0; turn < 400; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!IN_FLIGHT.has(controller.getState().phase)) return controller.getState();
  }
  throw new Error(`still ${controller.getState().phase}`);
}

async function review(h: Harness) {
  h.controller.submit();
  if (h.controller.getState().phase === "choosing-signer") h.controller.chooseSigner(h.kind);
  return settle(h);
}

function facts(state: Awaited<ReturnType<typeof review>>) {
  return state.phase === "review" ? Object.fromEntries(state.review.facts.map((fact) => [fact.key, fact.value])) : {};
}

/** The swap call of a simulated transaction: its target and the pure arguments the SDK set. */
function flashSwap(bytes: Uint8Array) {
  const data = Transaction.from(bytes).getData();
  const call = data.commands.find((command) => command.MoveCall?.function === "flash_swap")?.MoveCall;
  return call ? { target: `${normalizeSuiAddress(call.package)}::${call.module}::${call.function}` } : null;
}

/** The Bluefin `pool::swap` call of a transaction: its target. */
function bluefinSwap(bytes: Uint8Array) {
  const data = Transaction.from(bytes).getData();
  const call = data.commands.find((command) => command.MoveCall?.module === "pool" && command.MoveCall.function === "swap")?.MoveCall;
  return call ? `${normalizeSuiAddress(call.package)}::${call.module}::${call.function}` : null;
}

test("a Cetus buy review shows the exact fresh quote, simulates the SDK-built swap, signs it once, and completes after reconciliation", async () => {
  const h = harness({ amount: "10", slippageBps: 100n });
  const state = await review(h);
  assert.equal(state.phase, "review", state.phase === "blocked" ? `${state.block.message} ${state.block.details.join(" ")}` : "");
  const shown = facts(state);
  assert.equal(shown.trade, "Buy FROG with SUI");
  assert.equal(shown.venue, `Cetus CLMM pool ${CETUS_POOL_ID.slice(0, 6)}…${CETUS_POOL_ID.slice(-4)}, recorded at migration`);
  assert.equal(shown["amount-in"], "10 SUI");
  assert.equal(shown["amount-out"], "179,838.145668897 FROG");
  assert.equal(shown["minimum-out"], "178,039.764212208 FROG");
  assert.equal(shown.fee, "0.1 SUI (Cetus pool fee, included in what you pay)");
  assert.equal(shown.slippage, "1%");
  assert.match(shown["price-impact"] ?? "", /^\d+(\.\d+)?%$/);
  assert.equal(shown["balance-quote"], "100 SUI");
  assert.equal(shown["balance-meme"], "0 FROG");
  assert.equal(shown.network, "Sui mainnet");
  if (state.phase === "review") assert.ok(state.review.expiresAtMs && state.review.expiresAtMs > Date.now());
  // The quote (one probe) and the review each simulated the SDK-built Cetus swap.
  assert.equal(h.fixture.calls.simulate, 2);
  assert.equal(flashSwap(h.fixture.simulated.at(-1)!)?.target, `${CETUS_PACKAGE}::pool::flash_swap`);
  if (state.phase === "review") h.controller.approve(state.review.id);
  const done = await settle(h);
  assert.equal(done.phase, "succeeded", done.phase === "blocked" ? done.block.message : done.phase === "ambiguous" || done.phase === "failed" ? done.message : "");
  assert.equal(h.counts.signatures, 1);
  assert.equal(h.fixture.calls.execute, 1);
  // The signed bytes are exactly the SDK-built bytes simulated last before the signature.
  assert.equal(h.fixture.calls.simulate, 4);
  assert.deepEqual(h.fixture.executed, [h.fixture.simulated.at(-1)]);
  assert.equal(h.fixture.state.meme[fixtureWalletSigner().address], 179_838_145_668_897n);
  assert.deepEqual(h.counts.invalidated, [[
    `venue-pool:${CETUS_LAUNCH_ID}`,
    `venue-chart:${CETUS_LAUNCH_ID}`,
    `venue-activity:${CETUS_LAUNCH_ID}`,
    "wallet:balances",
  ]]);
});

test("a Bluefin buy review shows the exact fresh Bluefin quote, simulates the SDK-built Bluefin swap, signs it once, and completes after the SDK reconciles it", async () => {
  const h = harness({ ...BLUEFIN, amount: "10", slippageBps: 100n });
  const state = await review(h);
  assert.equal(state.phase, "review", state.phase === "blocked" ? `${state.block.message} ${state.block.details.join(" ")}` : "");
  const shown = facts(state);
  assert.equal(shown.trade, "Buy NEWT with SUI");
  assert.equal(shown.venue, `Bluefin Spot pool ${short(BLUEFIN_POOL_ID)}, recorded at migration`);
  assert.equal(shown["amount-in"], "10 SUI");
  // NEWT has six decimals, read from the launch's canonical supply.
  assert.equal(shown["amount-out"], "181,108.577044 NEWT");
  assert.equal(shown["minimum-out"], "179,297.491273 NEWT");
  assert.equal(shown.fee, "0.03 SUI (Bluefin pool fee, included in what you pay)");
  assert.match(shown["price-impact"] ?? "", /^\d+(\.\d+)?%$/);
  assert.match(shown["pool-price"] ?? "", /^1 NEWT = 0\.0000549\d* SUI$/);
  assert.equal(shown.slippage, "1%");
  assert.equal(shown.route, `LP vault ${short(BLUEFIN_VAULT_ID)}, tick spacing 60, 0.3% pool fee`);
  assert.equal(shown["balance-quote"], "100 SUI");
  assert.equal(shown["balance-meme"], "0 NEWT");
  assert.equal(shown.network, "Sui mainnet");
  if (state.phase === "review") assert.ok(state.review.expiresAtMs && state.review.expiresAtMs > Date.now());
  // The quote (one probe) and the review each simulated the SDK-built Bluefin swap.
  assert.equal(h.fixture.calls.simulate, 2);
  assert.equal(bluefinSwap(h.fixture.simulated.at(-1)!), `${BLUEFIN_PACKAGE}::pool::swap`);
  if (state.phase === "review") h.controller.approve(state.review.id);
  const done = await settle(h);
  assert.equal(done.phase, "succeeded", done.phase === "blocked" ? done.block.message : done.phase === "ambiguous" || done.phase === "failed" ? done.message : "");
  assert.equal(h.counts.signatures, 1);
  assert.equal(h.fixture.calls.execute, 1);
  // The signed bytes are exactly the SDK-built Bluefin bytes simulated last before the signature.
  assert.equal(h.fixture.calls.simulate, 4);
  assert.deepEqual(h.fixture.executed, [h.fixture.simulated.at(-1)]);
  assert.equal(bluefinSwap(h.fixture.executed[0]!), `${BLUEFIN_PACKAGE}::pool::swap`);
  assert.equal(h.fixture.state.newt[fixtureWalletSigner().address], 181_108_577_044n);
  assert.deepEqual(h.counts.invalidated, [[
    `venue-pool:${BLUEFIN_LAUNCH_ID}`,
    `venue-chart:${BLUEFIN_LAUNCH_ID}`,
    `venue-activity:${BLUEFIN_LAUNCH_ID}`,
    "wallet:balances",
  ]]);
  // The completed swap, read back by its digest through the Bluefin adapter, is the venue's own fact.
  if (done.phase !== "succeeded") return;
  const read = await readVenueRoute(h.fixture.client, defineBlastDeployment(VENUE_FIXTURE_MANIFEST), { launchId: BLUEFIN_LAUNCH_ID, migrationDigest: BLUEFIN_MIGRATION_DIGEST, poolKey: null }, Date.now());
  const landed = (await h.fixture.client.core.getTransaction({ digest: done.digest, include: { events: true } })).Transaction!;
  const trade = read.status === "ok" ? readRecordedSwap({ digest: done.digest, status: landed.status, events: landed.events ?? [] }, read.recorded) : null;
  assert.deepEqual(trade && { side: trade.side, quoteAmount: trade.quoteAmount, memeAmount: trade.memeAmount, quoteFee: trade.quoteFee }, {
    side: "buy",
    quoteAmount: 10_000_000_000n,
    memeAmount: 181_108_577_044n,
    quoteFee: 30_000_000n,
  });
});

test("a Cetus sell review states the SUI received and the fee in the coin sold, and completes on the reconciled swap", async () => {
  const fixture = createVenueFixtureChain();
  const owner = fixturePrivySigner().address;
  fixture.state.meme[owner] = 5_000_000_000_000_000n;
  const h = harness({ direction: "sell", amount: "1000000", slippageBps: 50n }, { fixture, kind: "privy" });
  const state = await review(h);
  assert.equal(state.phase, "review", state.phase === "blocked" ? `${state.block.message} ${state.block.details.join(" ")}` : "");
  const shown = facts(state);
  assert.equal(shown.trade, "Sell FROG for SUI");
  assert.equal(shown["amount-in"], "1,000,000 FROG");
  assert.equal(shown["amount-out"], "54.181800089 SUI");
  assert.equal(shown["minimum-out"], "53.910891088 SUI");
  assert.equal(shown.fee, "10,000 FROG (Cetus pool fee, included in what you sell)");
  assert.equal(shown["balance-meme"], "5,000,000 FROG");
  assert.equal(h.fixture.calls.simulate, 2);
  if (state.phase === "review") h.controller.approve(state.review.id);
  assert.equal((await settle(h)).phase, "succeeded");
  assert.equal(h.counts.signatures, 1);
  assert.equal(flashSwap(fixture.executed[0]!)?.target, `${CETUS_PACKAGE}::pool::flash_swap`);
  assert.deepEqual(fixture.executed, [fixture.simulated.at(-1)]);
  assert.equal(fixture.state.meme[owner], 4_000_000_000_000_000n);
  assert.equal(fixture.state.sui[owner], 100_000_000_000n + 54_181_800_089n);
});

test("a Bluefin sell review states the SUI received and the fee in the coin sold, simulates the exact SDK-built swap, and completes on the reconciled swap", async () => {
  const fixture = createVenueFixtureChain();
  const owner = fixturePrivySigner().address;
  fixture.state.newt[owner] = 5_000_000_000_000n;
  const h = harness({ ...BLUEFIN, direction: "sell", amount: "1000000", slippageBps: 50n }, { fixture, kind: "privy" });
  const state = await review(h);
  assert.equal(state.phase, "review", state.phase === "blocked" ? `${state.block.message} ${state.block.details.join(" ")}` : "");
  const shown = facts(state);
  assert.equal(shown.trade, "Sell NEWT for SUI");
  assert.equal(shown["amount-in"], "1,000,000 NEWT");
  assert.equal(shown["amount-out"], "54.563003427 SUI");
  assert.equal(shown["minimum-out"], "54.290188409 SUI");
  assert.equal(shown.fee, "3,000 NEWT (Bluefin pool fee, included in what you sell)");
  assert.equal(shown.slippage, "0.5%");
  assert.equal(shown["balance-meme"], "5,000,000 NEWT");
  assert.equal(h.fixture.calls.simulate, 2);
  if (state.phase === "review") h.controller.approve(state.review.id);
  assert.equal((await settle(h)).phase, "succeeded");
  assert.equal(h.counts.signatures, 1);
  assert.equal(bluefinSwap(fixture.executed[0]!), `${BLUEFIN_PACKAGE}::pool::swap`);
  assert.deepEqual(fixture.executed, [fixture.simulated.at(-1)]);
  assert.equal(fixture.state.newt[owner], 4_000_000_000_000n);
  assert.equal(fixture.state.sui[owner], 100_000_000_000n + 54_563_003_427n);
});

test("a quote that changed before approval replaces the review and needs confirmation; nothing is signed", async () => {
  const h = harness();
  const first = await review(h);
  h.fixture.competingBuy(500_000_000_000n);
  if (first.phase === "review") h.controller.approve(first.review.id);
  const replaced = await settle(h);
  assert.equal(replaced.phase, "review");
  if (replaced.phase !== "review") return;
  assert.ok(replaced.changes.some((change) => change.key === "amount-out"));
  assert.notEqual(replaced.review.id, first.phase === "review" ? first.review.id : "");
  assert.equal(h.counts.signatures, 0);
  h.controller.approve(replaced.review.id);
  assert.equal((await settle(h)).phase, "succeeded");
  assert.equal(h.counts.signatures, 1);
});

test("an unavailable Cetus venue disables signing with the SDK's reason, before any quote or simulation", async () => {
  const h = harness({}, { fixture: createVenueFixtureChain({ cetusConfig: "mismatch" }) });
  const state = await review(h);
  assert.equal(state.phase, "blocked");
  if (state.phase !== "blocked") return;
  assert.equal(state.block.code, "stale-route");
  assert.match(state.block.message, /^Cetus CLMM trading is unavailable for this Blast deployment \(venue-unavailable: runtime-mismatch\)\. Nothing can be signed\. Code: stale-route\.$/);
  assert.equal(h.fixture.calls.simulate, 0);
  assert.equal(h.counts.signatures, 0);
});

test("a substituted venue or pool is refused with its reason and never simulated, for either venue", async () => {
  // The Cetus adapter cannot be substituted for a launch that recorded Bluefin.
  const asCetus = harness({ ...BLUEFIN, poolKey: `cetus:${BLUEFIN_POOL_ID}` });
  const refused = await review(asCetus);
  assert.equal(refused.phase === "blocked" && refused.block.code, "stale-route");
  assert.match(refused.phase === "blocked" ? refused.block.message : "", /^The page names pool cetus:0x4b4b.*, but this launch recorded bluefin:0x4b4b/);
  assert.equal(asCetus.fixture.calls.simulate, 0);
  assert.equal(asCetus.counts.signatures, 0);
  const substituted = harness({ poolKey: `cetus:${normalizeSuiAddress(`0x${"7c".repeat(32)}`)}` });
  const blocked = await review(substituted);
  assert.equal(blocked.phase === "blocked" && blocked.block.code, "stale-route");
  assert.match(blocked.phase === "blocked" ? blocked.block.message : "", /but this launch recorded cetus:/);
  assert.equal(substituted.fixture.calls.simulate, 0);
});

test("a quote provider outage is retried once, then blocks the review with the reason; nothing is signed", async () => {
  const h = harness({}, { fixture: createVenueFixtureChain({ simulation: "unavailable" }) });
  const state = await review(h);
  assert.equal(state.phase, "blocked");
  if (state.phase !== "blocked") return;
  assert.equal(state.block.code, "fresh-read-unavailable");
  assert.deepEqual(state.block.details, ["The external service could not complete this request. Retry shortly. Code: service_unavailable."]);
  assert.doesNotMatch(JSON.stringify(state.block), /fixture node/);
  assert.equal(h.fixture.calls.simulate, 2);
  assert.equal(h.counts.signatures, 0);
});

test("a swap that aborts on chain fails without success, and a lost answer stays unresolved; neither refreshes venue facts as success", async () => {
  const aborted = harness({}, { fixture: createVenueFixtureChain({ execution: "abort" }) });
  const first = await review(aborted);
  if (first.phase === "review") aborted.controller.approve(first.review.id);
  const failed = await settle(aborted);
  assert.equal(failed.phase, "failed");
  const lost = harness({}, { fixture: createVenueFixtureChain({ execution: "unknown" }) });
  const second = await review(lost);
  if (second.phase === "review") lost.controller.approve(second.review.id);
  assert.equal((await settle(lost)).phase, "ambiguous");
  assert.deepEqual(lost.counts.invalidated, []);
});

test("an expired quote is never approved: approving it fetches a fresh quote for renewed confirmation, and only that one signs", async (t) => {
  let clock = 1_790_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const now = () => clock;
  const h = harness({}, { now });
  const gated = gateVenueTrades({ buy: h.controller, sell: h.controller }, now);
  const first = await review(h);
  assert.equal(first.phase, "review");
  if (first.phase !== "review") return;
  assert.equal(first.review.expiresAtMs, clock + 20_000);
  clock += 20_000;
  t.mock.timers.tick(20_000);
  gated.buy.approve(first.review.id);
  const renewed = await settle(h);
  assert.equal(renewed.phase, "review");
  if (renewed.phase !== "review") return;
  assert.notEqual(renewed.review.id, first.review.id);
  assert.equal(renewed.review.expiresAtMs, clock + 20_000);
  assert.equal(h.counts.signatures, 0);
  gated.buy.approve(renewed.review.id);
  assert.equal((await settle(h)).phase, "succeeded");
  assert.equal(h.counts.signatures, 1);
});

test("a changed or an expired Bluefin quote needs renewed confirmation; only a confirmed fresh quote signs", async (t) => {
  let clock = 1_790_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const now = () => clock;
  const h = harness({ ...BLUEFIN }, { now });
  const gated = gateVenueTrades({ buy: h.controller, sell: h.controller }, now);
  const first = await review(h);
  assert.equal(first.phase, "review");
  if (first.phase !== "review") return;
  assert.equal(first.review.expiresAtMs, clock + 20_000);
  // Another trader moves the Bluefin pool: approving replaces the review with the changed quote.
  h.fixture.competingBluefinBuy(500_000_000_000n);
  gated.buy.approve(first.review.id);
  const changed = await settle(h);
  assert.equal(changed.phase, "review");
  if (changed.phase !== "review") return;
  assert.ok(changed.changes.some((change) => change.key === "amount-out"));
  assert.equal(h.counts.signatures, 0);
  // The changed review's quote expires before approval: approving quotes again for a new confirmation.
  clock += 20_000;
  t.mock.timers.tick(20_000);
  gated.buy.approve(changed.review.id);
  const renewed = await settle(h);
  assert.equal(renewed.phase, "review");
  if (renewed.phase !== "review") return;
  assert.notEqual(renewed.review.id, changed.review.id);
  assert.equal(renewed.review.expiresAtMs, clock + 20_000);
  assert.equal(h.counts.signatures, 0);
  gated.buy.approve(renewed.review.id);
  assert.equal((await settle(h)).phase, "succeeded");
  assert.equal(h.counts.signatures, 1);
});

test("absent or mismatched recorded Bluefin objects disable Bluefin signing with the SDK's reason before any quote, while Cetus still trades", async () => {
  for (const [bluefinConfig, reason] of [
    ["mismatch", /^Bluefin Spot trading is unavailable for this Blast deployment \(venue-unavailable: runtime-mismatch\)\. Nothing can be signed\. Code: stale-route\.$/],
    ["absent", /^Bluefin Spot trading is unavailable for this Blast deployment \(venue-unavailable: runtime-unverified\)\. Nothing can be signed\. Code: stale-route\.$/],
  ] as const) {
    const fixture = createVenueFixtureChain({ bluefinConfig });
    const bluefin = harness({ ...BLUEFIN }, { fixture });
    const blocked = await review(bluefin);
    assert.equal(blocked.phase === "blocked" && blocked.block.code, "stale-route", bluefinConfig);
    assert.match(blocked.phase === "blocked" ? blocked.block.message : "", reason);
    assert.equal(fixture.calls.simulate, 0);
    assert.equal(bluefin.counts.signatures, 0);
    // A problem with Bluefin never blocks Cetus on the same node and deployment.
    const cetus = harness({}, { fixture });
    const state = await review(cetus);
    assert.equal(state.phase, "review", bluefinConfig);
    if (state.phase === "review") cetus.controller.approve(state.review.id);
    assert.equal((await settle(cetus)).phase, "succeeded", bluefinConfig);
  }
});

test("an unavailable Cetus venue never blocks a Bluefin trade", async () => {
  const fixture = createVenueFixtureChain({ cetusConfig: "mismatch" });
  const h = harness({ ...BLUEFIN }, { fixture });
  const state = await review(h);
  assert.equal(state.phase, "review", state.phase === "blocked" ? state.block.message : "");
  if (state.phase === "review") h.controller.approve(state.review.id);
  assert.equal((await settle(h)).phase, "succeeded");
});

test("a Bluefin quote provider outage is retried once, then blocks with the reason; nothing is signed and Cetus still quotes", async () => {
  const fixture = createVenueFixtureChain({ bluefinProvider: "unavailable" });
  const h = harness({ ...BLUEFIN }, { fixture });
  const state = await review(h);
  assert.equal(state.phase, "blocked");
  if (state.phase !== "blocked") return;
  assert.equal(state.block.code, "fresh-read-unavailable");
  assert.deepEqual(state.block.details, ["The external service could not complete this request. Retry shortly. Code: service_unavailable."]);
  assert.doesNotMatch(JSON.stringify(state.block), /fixture node/);
  assert.equal(fixture.calls.simulate, 2);
  assert.equal(h.counts.signatures, 0);
  assert.equal((await review(harness({}, { fixture }))).phase, "review");
});

test("a Bluefin swap whose completed effects do not reconcile with the signed quote is never a success and refreshes nothing", async () => {
  const h = harness({ ...BLUEFIN }, { fixture: createVenueFixtureChain({ execution: "no-swap-event" }) });
  const state = await review(h);
  if (state.phase === "review") h.controller.approve(state.review.id);
  const done = await settle(h);
  assert.equal(done.phase, "ambiguous");
  assert.equal(done.phase === "ambiguous" && done.reason, "evidence-missing");
  assert.equal(h.counts.signatures, 1);
  assert.deepEqual(h.counts.invalidated, []);
});

test("a Bluefin swap whose minimum is above what the pool now pays aborts in simulation with Bluefin's slippage_exceeds, and nothing is signed", async () => {
  // Another trader buys right after the quote, so the reviewed transaction's minimum (amount_limit) is above the pool's output.
  const fixture = createVenueFixtureChain({ bluefinRace: "after-quote" });
  const h = harness({ ...BLUEFIN, amount: "100", slippageBps: 50n }, { fixture });
  const state = await review(h);
  assert.equal(state.phase, "blocked");
  if (state.phase !== "blocked") return;
  assert.equal(state.block.code, "simulation-failed");
  assert.equal(state.block.message, "Sui refused this swap in simulation: the Bluefin pool would pay less than the fewest you accept. Nothing was signed. Code: simulation-failed.");
  assert.doesNotMatch(state.block.message, /abort code|pool::swap/);
  // The quote's probe and the exact reviewed transaction were simulated; the second is the one that aborted.
  assert.equal(fixture.calls.simulate, 2);
  assert.equal(bluefinSwap(fixture.simulated.at(-1)!), `${BLUEFIN_PACKAGE}::pool::swap`);
  assert.equal(h.counts.signatures, 0);
  assert.equal(fixture.calls.execute, 0);
});

test("on a node whose client estimates gas by simulating, Bluefin's slippage_exceeds still blocks as Sui's refusal in simulation, never as an outage", async () => {
  // A real Core API client simulates while it builds (to set the gas budget), so the abort arrives from the build.
  const fixture = createVenueFixtureChain({ gasBudget: "estimated", bluefinRace: "after-quote" });
  const h = harness({ ...BLUEFIN, amount: "100", slippageBps: 50n }, { fixture });
  const state = await review(h);
  assert.equal(state.phase, "blocked");
  if (state.phase !== "blocked") return;
  assert.equal(state.block.code, "simulation-failed", `${state.block.message} ${state.block.details.join(" ")}`);
  assert.equal(state.block.message, "Sui refused this swap in simulation: the Bluefin pool would pay less than the fewest you accept. Nothing was signed. Code: simulation-failed.");
  assert.doesNotMatch(state.block.message, /abort code|pool::swap/);
  assert.equal(venueProblem(state, defineBlastDeployment(VENUE_FIXTURE_MANIFEST)), "Sui refused this swap in simulation: the Bluefin pool would pay less than the fewest you accept. Nothing was signed. Code: simulation-failed.");
  assert.equal(h.counts.signatures, 0);
  assert.equal(fixture.calls.execute, 0);
  // Without the race, the same node quotes, simulates, and signs once.
  const ok = harness({ ...BLUEFIN }, { fixture: createVenueFixtureChain({ gasBudget: "estimated" }) });
  const reviewed = await review(ok);
  assert.equal(reviewed.phase, "review", reviewed.phase === "blocked" ? `${reviewed.block.message} ${reviewed.block.details.join(" ")}` : "");
  if (reviewed.phase === "review") ok.controller.approve(reviewed.review.id);
  assert.equal((await settle(ok)).phase, "succeeded");
  assert.equal(ok.counts.signatures, 1);
});

const { CREATE_TEST_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE } = await import("@blast/core/modules/social/contracts/create.ts");
  for (const [quoteType, symbol] of [[CREATE_TEST_SUI_QUOTE_TYPE, "TSUI"], [CREATE_QUOTE_TYPE, "USDC"]] as const) {
    for (const locator of [{}, BLUEFIN]) {
      for (const direction of ["buy", "sell"] as const) {
        test(`${symbol} ${"poolKey" in locator ? "Bluefin" : "Cetus"} ${direction} uses the actual quote amounts`, async () => {
        const fixture = createVenueFixtureChain({ quoteType });
        fixture.state.meme[fixtureWalletSigner().address] = 5_000_000_000_000_000n;
        fixture.state.newt[fixtureWalletSigner().address] = 5_000_000_000_000n;
        const h = harness({ ...locator, direction, amount: direction === "buy" ? "10" : "1000" }, { fixture });
        const state = await review(h);
        assert.equal(state.phase, "review", state.phase === "blocked" ? state.block.message : "");
        if (state.phase === "review") {
          const facts = Object.fromEntries(state.review.facts.map(fact => [fact.key, fact.value]));
          assert.match(facts["balance-quote"]!, new RegExp(` ${symbol}$`));
          assert.match(facts[direction === "buy" ? "amount-in" : "amount-out"]!, new RegExp(` ${symbol}$`));
          if (direction === "buy") assert.equal(facts["amount-in"], `10 ${symbol}`);
        }
        assert.equal(h.counts.signatures, 0);
        if (state.phase === "review") h.controller.approve(state.review.id);
        assert.equal((await settle(h)).phase, "succeeded");
        assert.equal(h.counts.signatures, 1);
        assert.equal(fixture.calls.execute, 1);
        });
      }
    }
  }
