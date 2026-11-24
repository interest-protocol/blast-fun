import assert from "node:assert/strict";
import test from "node:test";

import { createPresaleTermsReader, parsePresaleTerms, presaleSplitIsFinal, PRESALE_TERMS_BEFORE_START_CACHE_MS } from "./index.ts";

const ID = `0x${"5a1e".padStart(64, "0")}`;
const ADDRESS = `0x${"7ea".padStart(64, "0")}`;
const BODY = {
  presale_id: ID,
  raise: { target: "250000000000", pool_share: "187500000000", recipients: [{ address: ADDRESS, bps: "2300", amount: "57500000000" }], protocol: { bps: "200", amount: "5000000000" } },
  supply: {
    total: "1000000000000000000", burnable: true,
    participants: { bps: "4500", amount: "450000000000000000" }, liquidity: { bps: "3000", amount: "300000000000000000" },
    recipients: [{ address: ADDRESS, bps: "2500", amount: "250000000000000000" }], protocol: { bps: "0", amount: "0" },
  },
  eligibility: { kind: "open", wallet_cap: "25000000000", min_commitment: "10000000", max_participants: "0" },
  // A sale whose window started before the projection's applied checkpoint: its split is final.
  windows: { start_ms: 1_790_200_000_000, end_ms: 1_790_286_400_000, liquidity_deadline_ms: 1_790_890_000_000, uncapped_from_ms: null, hard_cap_from_ms: null },
  freshness: { checkpoint: 326_274_009, timestamp_ms: 1_790_235_061_218, cursor: "326274009:3:1:0" },
};

test("UI-10: the projection's terms are kept with their shares as numbers and amounts as atoms", () => {
  const terms = parsePresaleTerms(ID, BODY);
  assert.equal(terms.raiseTarget, "250000000000");
  assert.deepEqual(terms.supply.participants, { bps: 4500, amount: "450000000000000000" });
  assert.deepEqual(terms.raise.recipients, [{ address: ADDRESS, bps: 2300, amount: "57500000000" }]);
  assert.deepEqual(terms.eligibility, { kind: "open" });
  assert.deepEqual(parsePresaleTerms(ID, { ...BODY, eligibility: { kind: "allowlisted", root: "a".repeat(64), leaf_count: "1200" } }).eligibility, { kind: "allowlisted", wallets: 1200 });
  for (const broken of [
    { ...BODY, presale_id: `0x${"1".repeat(64)}` },
    { ...BODY, raise: { ...BODY.raise, target: "-1" } },
    { ...BODY, raise: { ...BODY.raise, target: "18446744073709551616" } },
    { ...BODY, supply: { ...BODY.supply, participants: { bps: "10001", amount: "1" } } },
    { ...BODY, supply: { ...BODY.supply, protocol: { bps: "9007199254740993", amount: "1" } } },
    { ...BODY, eligibility: { kind: "allowlisted", leaf_count: "65537" } },
    { ...BODY, eligibility: { kind: "allowlisted", leaf_count: "9007199254740993" } },
    { ...BODY, supply: { ...BODY.supply, recipients: [{ address: "0xNOPE", bps: "1", amount: "1" }] } },
    { ...BODY, eligibility: { kind: "secret" } },
    null,
  ]) assert.throws(() => parsePresaleTerms(ID, broken));
  assert.equal(parsePresaleTerms(ID, { ...BODY, raise: { ...BODY.raise, target: "18446744073709551615" } }).raiseTarget, "18446744073709551615");
  assert.equal(parsePresaleTerms(ID, { ...BODY, supply: { ...BODY.supply, participants: { bps: "10000", amount: "1" } } }).supply.participants.bps, 10000);
  assert.deepEqual(parsePresaleTerms(ID, { ...BODY, eligibility: { kind: "allowlisted", leaf_count: "65536" } }).eligibility, { kind: "allowlisted", wallets: 65536 });
});

test("R3-90-AC-2: the terms carry the coin's `burnable` and the sale-level hard cap (ADR 0110), and null when the body does not say", () => {
  // BODY says the coin is burnable and leaves `hard_cap` out: the hard cap is unknown, never "none".
  const terms = parsePresaleTerms(ID, BODY);
  assert.equal(terms.burnable, true);
  assert.equal(terms.hardCap, null);
  assert.equal(parsePresaleTerms(ID, { ...BODY, supply: { ...BODY.supply, burnable: false } }).burnable, false);
  const unsaid: Record<string, unknown> = { ...BODY.supply };
  delete unsaid.burnable;
  assert.equal(parsePresaleTerms(ID, { ...BODY, supply: unsaid }).burnable, null);
  assert.equal(parsePresaleTerms(ID, { ...BODY, supply: { ...BODY.supply, burnable: "true" } }).burnable, null, "off the contract: unknown");
  // No hard cap: nothing stops the sale at its target (oversubscription is refunded pro rata).
  assert.equal(parsePresaleTerms(ID, { ...BODY, hard_cap: null }).hardCap, false);
  for (const closesWhenFilled of [true, false]) {
    assert.equal(parsePresaleTerms(ID, { ...BODY, hard_cap: { starts_after_ms: 72_000_000, closes_when_filled: closesWhenFilled } }).hardCap, true);
  }
  // Generation 1's flag on the uncapped phase is no longer read, and a hard cap off the contract is unknown.
  assert.equal(parsePresaleTerms(ID, { ...BODY, uncapped: { starts_after_ms: 72_000_000, access: "eligible", hard_cap: true } }).hardCap, null);
  assert.equal(parsePresaleTerms(ID, { ...BODY, hard_cap: true }).hardCap, null);
  assert.equal(parsePresaleTerms(ID, { ...BODY, hard_cap: { starts_after_ms: 1 } }).hardCap, null);
});

test("parity: the trading fee is the reserved CLMM pool fee tier in millionths, null for Aftermath or one off the contract", () => {
  const cetus = { venue: `${ADDRESS}::cetus::Venue`, tick_spacing: "60", fee_rate: "2500", pool_creation_cap_id: null };
  assert.equal(parsePresaleTerms(ID, { ...BODY, pool_tier: cetus }).poolFeePpm, 2500);
  assert.equal(parsePresaleTerms(ID, { ...BODY, pool_tier: { ...cetus, venue: `${ADDRESS}::bluefin::Venue`, fee_rate: "10000" } }).poolFeePpm, 10000);
  assert.equal(parsePresaleTerms(ID, { ...BODY, pool_tier: { ...cetus, fee_rate: "1000000" } }).poolFeePpm, 1000000);
  // A tier not indexed yet, an Aftermath venue (no tier), no venue at all: unknown.
  assert.equal(parsePresaleTerms(ID, { ...BODY, pool_tier: { ...cetus, fee_rate: null } }).poolFeePpm, null);
  assert.equal(parsePresaleTerms(ID, { ...BODY, venue: { kind: "aftermath", vendor_package_id: ADDRESS, pool_id: null } }).poolFeePpm, null);
  assert.equal(parsePresaleTerms(ID, BODY).poolFeePpm, null);
  // Off the contract: the fee is unknown, the rest of the terms still reads.
  for (const pool_tier of [{ ...cetus, fee_rate: "1000001" }, { ...cetus, fee_rate: 2500 }, { ...cetus, fee_rate: "-1" }, "cetus"]) {
    const terms = parsePresaleTerms(ID, { ...BODY, pool_tier });
    assert.deepEqual([terms.poolFeePpm, terms.raiseTarget], [null, "250000000000"], JSON.stringify(pool_tier));
  }
});

test("UI-10: the reader keeps an answer (or an unknown sale) for its cache time and never keeps a failure", async () => {
  let now = 1_000;
  const calls: string[] = [];
  let answer: () => Response = () => Response.json(BODY);
  const reader = createPresaleTermsReader({
    origin: () => "https://infra.example",
    fetch: (async (input: URL) => { calls.push(String(input)); return answer(); }) as typeof fetch,
    timeoutMs: 1_000,
    cacheMs: 60_000,
    now: () => now,
  });
  assert.equal((await reader(ID))?.raiseTarget, "250000000000");
  await reader(ID);
  assert.deepEqual(calls, [`https://infra.example/v1/presales/${ID}`]);
  now += 60_001;
  answer = () => Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
  assert.equal(await reader(ID), null);
  assert.equal(await reader(ID), null);
  assert.equal(calls.length, 2);
  now += 60_001;
  answer = () => Response.json({ error: { code: "not_ready", message: "x" } }, { status: 503 });
  await assert.rejects(reader(ID));
  await assert.rejects(reader(ID));
  assert.equal(calls.length, 4);
});

test("a split that can still change is kept only as long as the route's own cache; once the sale starts, for the cache time", async () => {
  const START = 1_790_200_000_000;
  let now = 1_000;
  let applied = START - 60_000;
  let blastBps = 0;
  const calls: number[] = [];
  // Before the window starts the AdminCap may change Blast's rates: its tokens come out of the participants'.
  const body = () => ({
    ...BODY,
    supply: {
      ...BODY.supply,
      participants: { bps: String(4_500 - blastBps), amount: String((4_500n - BigInt(blastBps)) * 10n ** 14n) },
      protocol: { bps: String(blastBps), amount: String(BigInt(blastBps) * 10n ** 14n) },
    },
    windows: { ...BODY.windows, start_ms: START },
    freshness: { ...BODY.freshness, timestamp_ms: applied },
  });
  const reader = createPresaleTermsReader({
    origin: () => "https://infra.example",
    fetch: (async () => { calls.push(now); return Response.json(body()); }) as unknown as typeof fetch,
    timeoutMs: 1_000,
    cacheMs: 300_000,
    now: () => now,
  });
  assert.equal(PRESALE_TERMS_BEFORE_START_CACHE_MS, 10_000, "the public routes' s-maxage");
  assert.deepEqual((await reader(ID))?.supply.participants, { bps: 4_500, amount: "450000000000000000" });
  now += 9_999;
  await reader(ID);
  assert.equal(calls.length, 1, "kept within the route's shared-cache life");
  // ProtocolFeesChanged lands before the start: Blast takes 3% out of the participants' share.
  blastBps = 300;
  now += 2;
  assert.deepEqual((await reader(ID))?.supply.participants, { bps: 4_200, amount: "420000000000000000" }, "never 5 minutes of the old split");
  assert.deepEqual((await reader(ID))?.supply.protocol, { bps: 300, amount: "30000000000000000" });
  assert.equal(calls.length, 2);

  // The projection has applied the chain past the start: no rate change can follow, so the answer is kept.
  applied = START;
  now += 10_001;
  await reader(ID);
  assert.equal(calls.length, 3);
  blastBps = 0;
  now += 299_999;
  assert.equal((await reader(ID))?.supply.participants.bps, 4_200, "a final split is kept for the cache time");
  assert.equal(calls.length, 3);
  now += 2;
  await reader(ID);
  assert.equal(calls.length, 4, "and read again after it");
});

test("a sale not yet opened, or a body without its window or freshness, is never treated as final; 0 keeps nothing", async () => {
  const opened = { windows: { start_ms: 100 }, freshness: { timestamp_ms: 100 } };
  assert.equal(presaleSplitIsFinal(opened), true);
  assert.equal(presaleSplitIsFinal({ windows: { start_ms: 101 }, freshness: { timestamp_ms: 100 } }), false, "the projection is behind the start");
  assert.equal(presaleSplitIsFinal({ windows: { start_ms: 0 }, freshness: { timestamp_ms: 100 } }), false, "windows are zero until PresaleOpened");
  for (const broken of [
    { freshness: { timestamp_ms: 100 } }, { windows: { start_ms: 100 } },
    { windows: { start_ms: "100" }, freshness: { timestamp_ms: 100 } },
    { windows: { start_ms: 100 }, freshness: { timestamp_ms: Infinity } },
    { windows: { start_ms: 0.5 }, freshness: { timestamp_ms: 100 } },
    { windows: { start_ms: 100 }, freshness: { timestamp_ms: Number.MAX_SAFE_INTEGER + 1 } },
    null, [],
  ]) {
    assert.equal(presaleSplitIsFinal(broken), false, JSON.stringify(broken));
  }

  let now = 0;
  let calls = 0;
  const answer = { ...BODY, windows: { ...BODY.windows, start_ms: 0 } };
  const reader = (beforeStartCacheMs?: number) => createPresaleTermsReader({
    origin: () => "https://infra.example",
    fetch: (async () => { calls += 1; return Response.json(answer); }) as unknown as typeof fetch,
    timeoutMs: 1_000,
    cacheMs: 300_000,
    beforeStartCacheMs,
    now: () => now,
  });
  const unopened = reader();
  await unopened(ID);
  now += 10_000;
  await unopened(ID);
  assert.equal(calls, 2, "an unopened sale's split is kept 10 s at most");
  calls = 0;
  const uncached = reader(0);
  await uncached(ID);
  await uncached(ID);
  assert.equal(calls, 2, "0 keeps nothing");
  calls = 0;
  const capped = reader(600_000);
  await capped(ID);
  now += 300_000;
  await capped(ID);
  assert.equal(calls, 2, "never longer than a final answer");
});


test("buyer vesting is read before any buyer claims and invalid terms fail closed", () => {
  assert.deepEqual(parsePresaleTerms(ID, { ...BODY, participant_vesting: { cliff_delay_ms: "60000", period_duration_ms: "60000", periods: "5" } }).participantVesting, { cliffMs: "60000", durationMs: "300000" });
  assert.equal(parsePresaleTerms(ID, { ...BODY, participant_vesting: null }).participantVesting, null);
  assert.equal(parsePresaleTerms(ID, BODY).participantVesting, undefined);
  for (const value of [{ cliff_delay_ms: "1", period_duration_ms: "0", periods: "5" }, { cliff_delay_ms: "6", period_duration_ms: "1", periods: "5" }, { cliff_delay_ms: "0", period_duration_ms: "18446744073709551615", periods: "2" }]) assert.throws(() => parsePresaleTerms(ID, { ...BODY, participant_vesting: value }));
});

test("only anyone access publishes a public commitment window", () => {
  const windows = { ...BODY.windows, uncapped_from_ms: BODY.windows.start_ms + 100, hard_cap_from_ms: BODY.windows.start_ms };
  const uncapped = { access: { anyone: { min_commitment: "1083560581" } } };
  assert.deepEqual(parsePresaleTerms(ID, { ...BODY, windows, uncapped }).publicBuy,
    { from_ms: windows.uncapped_from_ms, min_atoms: "1083560581", hard_cap_from_ms: windows.hard_cap_from_ms });
  const eligible = parsePresaleTerms(ID, { ...BODY, windows, uncapped: { access: "eligible" } });
  assert.equal(eligible.publicBuy, undefined);
  assert.equal(eligible.eligibleUncappedFromMs, windows.uncapped_from_ms);
});
