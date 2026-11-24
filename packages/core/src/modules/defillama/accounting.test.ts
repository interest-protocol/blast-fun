import assert from "node:assert/strict";
import test from "node:test";
import { DefillamaAccounting } from "./accounting.ts";
import {
  creation,
  day,
  end,
  launchEvent,
  feePayment,
  feeSplitApplied,
  vaultEvent,
  meme,
  objectId,
  profile,
  quote,
  start,
} from "./fixtures.test.ts";
import { dayInterval, parseProfile } from "./contracts.ts";

test("native BCS fees, exact quote volume and opening settlement are counted once", () => {
  const account = new DefillamaAccounting(profile, start, end);
  const huge = 9_007_199_254_740_993n;
  for (const event of [
    ...creation(),
    launchEvent("Bought", {
      quote_in: huge,
      quote_refund: 999n,
      protocol_quote_fee: 7n,
      creator_quote_fee: 3n,
      protocol_meme_fee: 5n,
      creator_meme_fee: 2n,
    }),
    launchEvent("OpeningRoundSettled", { bids: huge, meme_amount: 100n }),
    launchEvent("OpeningRoundDelivered", { bid: huge, meme_amount: 100n }),
    launchEvent("Sold", { quote_out_gross: 100n, protocol_quote_fee: 3n, creator_quote_fee: 2n }),
    feePayment("launch", { quote_amount: 10n, sui_amount: 100n }),
    launchEvent("ProtocolFeesAccrued", { quote_amount: 99n, meme_amount: 1000n }),
  ]) {
    account.apply(event);
  }
  const result = account.result();
  const swap = result.items.find(
    (item) => item.component === "curve_swaps" && item.coin_type === quote,
  )!;
  assert.equal(swap.metrics.volume, String(huge + 100n));
  assert.equal(swap.metrics.fees, "15");
  assert.equal(swap.metrics.supply_side_revenue, "5");
  assert.equal(swap.metrics.revenue, "10");
  assert.equal(
    result.items.find((item) => item.component === "curve_swaps" && item.coin_type === meme)
      ?.metrics.fees,
    "7",
  );
  assert.equal(result.items.find((item) => item.component === "creation")?.metrics.fees, "100");
  assert.equal(result.items.find((item) => item.component === "migration")?.metrics.fees, "99");
  assert.equal(result.items.find((item) => item.component === "migration")?.metrics.volume, "0");
  assert.equal(
    result.items.find((item) => item.component === "migration_minted_allocations")?.evidence
      .allocated,
    "1000",
  );
  for (const item of result.items.filter((i) => !i.included_in_totals)) {
    assert.ok(Object.values(item.metrics).every((a) => a === null));
  }
  assert.equal(result.coverage.fees.status, "complete");
  assert.equal(result.coverage.holders_revenue.status, "not_applicable");
  assert.equal(result.contracts[0]?.tvl, "read_user_quote_custody");
});

test("mutable partner allocation blocks net metrics even when a later claim pays a known share", () => {
  const account = new DefillamaAccounting(profile, start, end);
  for (const event of [
    ...creation(true),
    launchEvent("Bought", { quote_in: 1000n, protocol_quote_fee: 80n, creator_quote_fee: 20n }),
    feePayment("launch", { quote_amount: 60n, partner_quote_amount: 20n }),
  ]) {
    account.apply(event);
  }
  const result = account.result();
  assert.equal(result.coverage.volume.status, "complete");
  assert.equal(result.coverage.fees.status, "complete");
  assert.equal(result.coverage.revenue.status, "unavailable");
  const swap = result.items.find((i) => i.component === "curve_swaps")!;
  assert.equal(swap.metrics.fees, "100");
  assert.equal(swap.metrics.revenue, null);
  assert.equal(swap.metrics.supply_side_revenue, null);
  assert.equal(
    result.items.find((i) => i.component === "curve_settlements")?.evidence.partner_paid,
    "20",
  );
});

test("presale payments report net treasury and partner shares, with minted coins as evidence", () => {
  const account = new DefillamaAccounting(profile, start, end);
  account.apply(feePayment("presale", {
    origin: objectId("7"), quote_amount: 80n, partner_quote_amount: 20n, meme_amount: 2000n,
  }));
  const result = account.result();
  const fee = result.items.find((i) => i.component === "presale_raise")!;
  assert.equal(fee.metrics.fees, "100");
  assert.equal(fee.metrics.revenue, "80");
  assert.equal(fee.metrics.supply_side_revenue, "20");
  assert.equal(
    result.items.find((i) => i.component === "presale_minted_allocations")?.evidence.allocated,
    "2000",
  );
});

test("vault collections follow the applied split and preserve owner withdrawals as evidence", () => {
  const account = new DefillamaAccounting(profile, start, end);
  for (const event of [
    vaultEvent("VaultCreated", { residual_meme_amount: 123n, residual_quote_amount: 456n }),
    vaultEvent("FeesCollected", {
      gross_meme_amount: 20n, gross_quote_amount: 200n,
      protocol_meme_amount: 2n, protocol_quote_amount: 20n,
      route_meme_amounts: [18n], route_quote_amounts: [180n],
    }),
    feeSplitApplied({ routes: [
      { destination: { kind: "AutoLp" }, bps: 2000n },
      { destination: { kind: "HolderRewards" }, bps: 3000n },
      { destination: { kind: "Burn" }, bps: 1000n },
      { destination: { kind: "Address", address: objectId("8") }, bps: 4000n },
    ] }),
    vaultEvent("FeesCollected", {
      gross_meme_amount: 100n, gross_quote_amount: 1000n,
      protocol_meme_amount: 10n, protocol_quote_amount: 100n,
      route_meme_amounts: [18n, 27n, 9n, 36n],
      route_quote_amounts: [180n, 270n, 90n, 360n],
    }),
    vaultEvent("AutoLiquidityAdded", { meme_amount: 18n, quote_amount: 180n }),
    vaultEvent("BuybackBurned", { quote_spent: 90n, meme_burned: 9n }),
    vaultEvent("OwnerBalancesClaimed", { meme_amount: 141n, quote_amount: 636n }),
    feePayment("vault", { origin: objectId("9"), quote_amount: 120n, meme_amount: 12n }),
  ]) account.apply(event);
  const result = account.result();
  const get = (component: string, coin = quote) =>
    result.items.find((i) => i.component === component && i.coin_type === coin)!;
  const fee = get("vault_collections");
  assert.equal(fee.metrics.fees, "1200");
  assert.equal(fee.metrics.revenue, "120");
  assert.equal(fee.metrics.supply_side_revenue, "1080");
  assert.equal(fee.metrics.volume, "0");
  assert.equal(fee.underlying_venue_overlap, true);
  assert.equal(fee.evidence.owner_accrued, "180");
  assert.equal(fee.evidence.auto_lp_allocated, "180");
  assert.equal(fee.evidence.launched_coin_holder_allocation, "270");
  assert.equal(get("vault_collections", meme).evidence.launched_coin_holder_allocation, "27");
  assert.equal(fee.evidence.burn_allocated, "90");
  assert.equal(fee.evidence.recipients_paid, "360");
  assert.equal(get("migration_residuals").evidence.principal_received, "456");
  assert.equal(get("vault_owner_withdrawals").evidence.owner_withdrawn, "636");
  assert.equal(get("vault_settlements").evidence.treasury_paid, "120");
  assert.ok(result.items.filter((i) => !i.included_in_totals).every(
    (i) => Object.values(i.metrics).every((v) => v === null),
  ));
  assert.equal(result.contracts[0]?.kind, "vault");
});

test("vault collections use the split applied before the reporting day", () => {
  const account = new DefillamaAccounting(profile, start, end);
  const priorDay = String(start - 1);
  account.apply({ ...vaultEvent("VaultCreated"), timestamp_ms: priorDay });
  account.apply({
    ...feeSplitApplied({ routes: [
      { destination: { kind: "AutoLp" }, bps: 5000n },
      { destination: { kind: "HolderRewards" }, bps: 5000n },
    ] }),
    timestamp_ms: priorDay,
  });
  account.apply(vaultEvent("FeesCollected", {
    gross_quote_amount: 100n,
    protocol_quote_amount: 10n,
    route_meme_amounts: [0n, 0n],
    route_quote_amounts: [45n, 45n],
  }));

  const fee = account.result().items.find((item) => item.component === "vault_collections")!;
  assert.equal(fee.metrics.fees, "100");
  assert.equal(fee.metrics.revenue, "10");
  assert.equal(fee.evidence.auto_lp_allocated, "45");
  assert.equal(fee.evidence.launched_coin_holder_allocation, "45");
});

test("partnered migration and vault income preserve gross fees without fabricating net allocation", () => {
  const account = new DefillamaAccounting(profile, start, end);
  for (const event of [
    ...creation(true).map((e) => ({ ...e, timestamp_ms: String(start - 100) })),
    launchEvent("ProtocolFeesAccrued", { quote_amount: 9_007_199_254_740_993n, meme_amount: 999n }),
    vaultEvent("VaultCreated", { terms: {
      origin: objectId("4"), packageWitness: `${profile.launchpad_original_package}::blast_fun::PackageWitness`,
      feeSplit: { routes: [{ destination: { kind: "Owner" }, bps: 10_000n }] },
      protocolMemeBps: 1000n, protocolQuoteBps: 1000n, partnerId: objectId("7"), residuals: "Owner",
    } }),
    vaultEvent("FeesCollected", { gross_quote_amount: 10n, protocol_quote_amount: 4n, route_quote_amounts: [6n] }),
    feePayment("vault", { origin: objectId("9"), quote_amount: 3n, partner_quote_amount: 1n }),
  ]) account.apply(event);
  const result = account.result();
  assert.equal(result.items.find((i) => i.component === "migration")?.metrics.fees, "9007199254740993");
  assert.equal(result.items.find((i) => i.component === "migration")?.metrics.revenue, null);
  const vault = result.items.find((i) => i.component === "vault_collections")!;
  assert.equal(vault.metrics.fees, "10");
  assert.equal(vault.metrics.revenue, null);
  assert.equal(vault.evidence.protocol_held_for_partner_settlement, "4");
  assert.equal(result.coverage.revenue.status, "unavailable");
  assert.equal(result.coverage.fees.status, "complete");
});

test("incomplete identities, malformed BCS and unreconciled vault receipts fail publication", () => {
  const account = new DefillamaAccounting(profile, start, end);
  assert.throws(() => account.apply(launchEvent("Bought", { quote_in: 1n })), /history is incomplete/);
  assert.throws(() => account.apply({ ...launchEvent("LaunchCreated"), bcs: new Uint8Array([0]) }));
  assert.throws(() => account.apply({ ...launchEvent("LaunchCreated"), bcs: null }), /size limit/);
  assert.throws(() => account.apply(vaultEvent("FeesCollected")), /history is incomplete/);
  account.apply(vaultEvent("VaultCreated"));
  assert.throws(() => account.apply(vaultEvent("FeesCollected", { gross_quote_amount: 1n })), /reconcile/);
  assert.throws(() => account.apply(vaultEvent("FeesCollected", { route_quote_amounts: [] })), /reconcile/);
});

test("UTC boundaries, excluded packages and empty verified days preserve zero versus unavailable", () => {
  assert.deepEqual(dayInterval(day, end), { start, end });
  for (const bad of ["2026-02-30", "2026-2-01", "2026-10-20Z", "bogus"]) {
    assert.throws(() => dayInterval(bad, end));
  }
  assert.throws(() => dayInterval(day, end - 1), /day_not_complete/);
  for (const vault of [undefined, profile.launchpad_original_package, "0x1"]) {
    assert.throws(() => parseProfile({ ...profile, vault_original_package: vault }));
  }
  const excluded = parseProfile({ ...profile, excluded_meme_packages: [objectId("3")] });
  const account = new DefillamaAccounting(excluded, start, end);
  for (const event of [
    ...creation(),
    launchEvent("Bought", { quote_in: 100n }),
    launchEvent("ProtocolFeesAccrued", { quote_amount: 10n }),
    vaultEvent("VaultCreated"),
    vaultEvent("FeesCollected", { gross_quote_amount: 10n, protocol_quote_amount: 10n }),
  ]) account.apply(event);
  assert.deepEqual(account.result().items, []);
  assert.deepEqual(account.result().contracts, []);
  assert.equal(account.result().coverage.volume.status, "complete");
  const boundary = new DefillamaAccounting(profile, start, end);
  for (const event of [...creation(), launchEvent("Bought", { quote_in: 100n }, end)]) {
    boundary.apply(event);
  }
  assert.ok(boundary.result().items.every((item) => item.component !== "curve_swaps"));
});
