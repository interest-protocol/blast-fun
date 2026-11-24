import type { MigratorVenue } from "@blast/core/modules/launchpad-contract/venues.ts";
// The buyback job against a real database (migration 0139) as `blast_watcher`,
// with blast-infra and the chain replaced by scripted reads, and every
// submitted transaction built for real and passed through the buyback key's
// guard. The schedule's randomness is an injected source.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import { defineBlastDeployment, type BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import type { SuiClientTypes } from "@mysten/sui/client";

import { NON_PRODUCTION_MANIFEST } from "../../../test/fixtures/final-stack/non-production-deployment.ts";
import { adminPool, freshDatabase, watcherPool, workerEnvironment } from "../../../test/fixtures/modules/coin-registration/testing.ts";
import { workerConfigFromEnvironment } from "#workers/modules/worker-runtime/config.ts";
import { payFromAddressBalance } from "#workers/modules/worker-runtime/address-balance.ts";
import { leases } from "#workers/modules/worker-runtime/lease.ts";
import type { AttemptResult } from "#workers/modules/worker-runtime/attempt.ts";
import type { Submission } from "#workers/modules/worker-runtime/runtime.ts";
import type { BuybackMarket, DigestOutcome } from "./chain.ts";
import { buybackJob, type BuybackReads } from "./job.ts";
import { scaledPrice, type BuybackFacts } from "./pricing.ts";
import { readReleaseGate, recordReleaseCheck, releaseGateDigest, type ReleaseGateIdentity } from "#workers/modules/worker-runtime/release-gate.ts";
import { DAY_MS, type RandomSource } from "./schedule.ts";
import { buybackSettingsFromEnvironment } from "./settings.ts";
import { loadBuybackSigner, parseBuybackIntent, type BuybackIntent } from "./signer.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";

const id = (byte: string) => normalizeSuiAddress(`0x${byte.repeat(32)}`);
const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const KEY = Ed25519Keypair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, index) => index + 91));
const CAP = id("ca");
const NOON = Date.UTC(2026, 9, 27, 12);
const QUOTE = `${normalizeSuiAddress("0x2")}::sui::SUI`;

const base = defineBlastDeployment(NON_PRODUCTION_MANIFEST);
const deployment = {
  ...base,
  packages: { ...base.packages, cetusClmm: { packageId: id("c0"), originalPackageId: id("c0") }, cetusLpBurn: { packageId: id("c2"), originalPackageId: id("c2") }, bluefinSpot: { packageId: id("b0"), originalPackageId: id("b0") } },
  sharedObjects: {
    ...base.sharedObjects,
    cetus: { config: { objectId: id("c1"), initialSharedVersion: "7" }, pools: { objectId: id("c3"), initialSharedVersion: "7" }, burnManager: { objectId: id("c4"), initialSharedVersion: "7" } },
    bluefin: { config: { objectId: id("b1"), initialSharedVersion: "8" } },
  },
} as unknown as BlastDeployment;
const protocol = { signing: "enabled", deployment, paused:{vault:0,launchpad:0,presale:0}, venues: { cetus: { available: true, reasons: [] }, bluefin: { available: true, reasons: [] } } };

type Launch = { launchId: string; vaultId: string; poolId: string; venue: MigratorVenue; memeType: string };
const LAUNCHES: readonly Launch[] = [
  { launchId: id("11"), vaultId: id("a1"), poolId: id("d1"), venue: "cetus", memeType: `${id("e1")}::one::ONE` },
  { launchId: id("12"), vaultId: id("a2"), poolId: id("d2"), venue: "bluefin", memeType: `${id("e2")}::two::TWO` },
];

/** One vault's scripted market: 20 SUI waiting ($70), a 10,000 SUI pool, spot at the reference. */
type Market = { held: bigint; poolQuote: bigint; spot: { numerator: bigint; denominator: bigint }; reference: BuybackFacts["reference"] };
const REFERENCE = scaledPrice("0.0025");
const healthy = (): Market => ({ held: 20_000_000_000n, poolQuote: 10_000_000_000_000n, spot: { numerator: 25n, denominator: 10_000n }, reference: { status: "fresh", price: REFERENCE } });

/** A source that always answers `value` (clamped into range): deterministic schedules. */
const constant = (value: number): RandomSource => (max) => Math.min(value, max - 1);

type Attempt = "executed" | "min-out-sim" | "min-out-chain";

function minOutAbort(): SuiClientTypes.ExecutionError {
  return {
    $kind: "MoveAbort",
    message: "abort",
    MoveAbort: { abortCode: "13906834", location: { package: deployment.packages.vault.packageId, module: "vault", functionName: "burn_buyback" }, cleverError: { constantName: "EBuybackBelowMinimum" } },
  } as SuiClientTypes.ExecutionError;
}

async function setup(t: TestContext, options: { random?: RandomSource; markets?: Map<string, Market>; attempts?: Attempt[] } = {}) {
  const database = await freshDatabase();
  const { url } = database;
  const admin = adminPool(url);
  const pool = watcherPool(url);
  t.after(async () => {
    await Promise.all([admin.end(), pool.end()]);
    await database.drop();
  });
  const environment = workerEnvironment(url, "/nonexistent.json", { BLAST_WORKER_SIGNER_KEY: undefined });
  const config = workerConfigFromEnvironment(environment);
  const settings = buybackSettingsFromEnvironment({ BLAST_BUYBACK_ADMIN_CAP_ID: CAP });
  const signer = loadBuybackSigner({ BLAST_BUYBACK_SIGNER_KEY: KEY.getSecretKey() }, { gasBudgetMist: config.gasBudgetMist, adminCapId: CAP });
  const markets = options.markets ?? new Map(LAUNCHES.map((launch) => [launch.vaultId, healthy()]));
  const attempts = [...(options.attempts ?? [])];
  const alerts: { raised: string[]; cleared: string[] } = { raised: [], cleared: [] };
  const logs: Array<[string, Record<string, unknown>]> = [];
  const intents: BuybackIntent[] = [];
  let now = NOON;
  const outcomes = new Map<string, DigestOutcome>();

  const reads: BuybackReads = {
    discoverVaults: async () => ({
      complete: true,
      vaults: LAUNCHES.map((launch) => ({
        vaultId: launch.vaultId,
        originId: launch.launchId,
        packageWitness: `${deployment.packages[launch.venue === "cetus" ? "launchpad" : "presale"].originalPackageId}::${launch.venue === "cetus" ? "blast_fun" : "blast_presale_package"}::PackageWitness`,
        memeType: launch.memeType,
        quoteType: QUOTE,
        venueType: `${deployment.packages.migrators!.originalPackageId}::${launch.venue}::Venue`,
        poolTickSpacing: 60,
        poolFeeRate: 2_500n,
        venue: launch.venue,
        poolId: launch.poolId,
      })),
    }),
    readReference: async (_venue, poolId) => markets.get(LAUNCHES.find((launch) => launch.poolId === poolId)!.vaultId)!.reference,
    readQuoteUsd: async () => ({ price: 350_000_000n, expo: -8, decimals: 9 }),
    readMarket: async (_client, _deployment, row): Promise<BuybackMarket> => {
      const market = markets.get(row.vaultId)!;
      return {
        vault: { objectId: row.vaultId, initialSharedVersion: "9", mutable: true, burnQuote: market.held, memeType: row.memeType, quoteType: row.quoteType, poolId: row.poolId } as never,
        pool: { objectId: row.poolId, initialSharedVersion: "10", mutable: true },
        poolQuote: market.poolQuote,
        spot: market.spot,
      };
    },
    readRegistryCurrency: async (_client, memeType) => ({ objectId: (await import("#workers/modules/blast-keeper/chain.ts")).sharedCurrencyId(memeType), initialSharedVersion: "4" }),
    adminCapReference: async () => ({ objectId: CAP, version: "12", digest: DIGEST }),
    digestOutcome: async (_client, digest) => outcomes.get(digest) ?? { kind: "missing" },
  };

  const job = buybackJob({ settings, market: {} as never, alerts: { raise: async (key) => void alerts.raised.push(key), clear: async (key) => void alerts.cleared.push(key) }, random: options.random ?? constant(0), now: () => now, reads });

  async function submit<Reconciled>(submission: Submission<Reconciled>): Promise<AttemptResult<Reconciled>> {
    const intent = parseBuybackIntent(submission.intent);
    intents.push(intent);
    const transaction = submission.transaction;
    // Exactly what the runtime does: the key's address balance pays gas, valid during the current epoch.
    payFromAddressBalance(transaction, { sender: signer.address, gasBudgetMist: config.gasBudgetMist, referenceGasPrice: 1_000n, epoch: "1", chain: base.chainIdentifier });
    // Then the job's guarded signature over the built bytes.
    const signed = await job.sign(signer, await transaction.build(), submission.intent, deployment);
    const attempt = attempts.shift() ?? "executed";
    if (attempt === "min-out-sim") return { outcome: "simulation-failed", digest: null, reconciled: null, simulationError: minOutAbort() };
    assert.equal(await submission.beforeSubmit(signed.digest, signed, new Uint8Array()), true);
    const market = markets.get(intent.vaultId)!;
    if (attempt === "executed") {
      // The chain spends exactly the piece; the rest stays in the vault.
      market.held -= BigInt(intent.quoteIn);
      outcomes.set(signed.digest, { kind: "executed", quoteSpent: BigInt(intent.quoteIn), memeBurned: BigInt(intent.minMemeOut) + 1n, quotePending: market.held });
    } else {
      outcomes.set(signed.digest, { kind: "failed", error: minOutAbort() });
    }
    return { outcome: attempt === "executed" ? "executed" : "failed", digest: signed.digest, reconciled: null };
  }

  const context = {
    deployment,
    fingerprint: "f".repeat(64),
    protocol,
    pool,
    client: {} as never,
    config,
    signer,
    leases: leases(pool, randomUUID(), config.timings.leaseTtlMs),
    log: (name: string, fields: Record<string, unknown> = {}) => void logs.push([name, fields]),
    provider: <Result>(call: (signal: AbortSignal) => Promise<Result>) => call(new AbortController().signal),
    gasAvailable: async () => true,
    canSign: () => true,
    backoffMs: () => 1,
    submit,
  } as never;

  return {
    url,
    admin,
    pool,
    alerts,
    logs,
    intents,
    markets,
    attempts,
    run: () => job.run(context),
    at(ms: number) {
      now = ms;
    },
    async rows(): Promise<Map<string, Record<string, unknown>>> {
      const { rows } = await admin.query(
        "SELECT vault_id, venue, state, outcome, run_at, next_eligible_at, min_out_aborts, pieces_today, quote_spent_total::text, meme_burned_total::text, attempts FROM mission_control_vault_buybacks ORDER BY vault_id",
      );
      return new Map(rows.map((row) => [row.vault_id as string, row]));
    },
  };
}

/** $50 of SUI at $3.50: the smallest piece. */
const MIN_PIECE = 14_285_714_286n;
const GAP = 15 * 60_000;

test("both venues: discovered, planned at a drawn time, a random piece bought back and burned under the guard", { skip }, async (t) => {
  // Every draw answers 3,600,000 (clamped to its range): run times one hour into what is left of the day.
  const harness = await setup(t, { random: constant(3_600_000) });
  await harness.run();
  let rows = await harness.rows();
  for (const launch of LAUNCHES) {
    const row = rows.get(launch.vaultId)!;
    assert.equal(row.state, "waiting", launch.venue);
    assert.equal((row.run_at as Date).getTime(), NOON + 3_600_000, "the drawn time is stored, not recomputed");
  }
  assert.equal(harness.intents.length, 0, "nothing runs before its drawn time");

  harness.at(NOON + 3_600_000);
  await harness.run();
  rows = await harness.rows();
  assert.deepEqual(harness.intents.map((intent) => intent.venue).sort(), ["bluefin", "cetus"]);
  const piece = MIN_PIECE + 3_600_000n;
  for (const intent of harness.intents) {
    // The piece is drawn above the $50 minimum and within the 20 SUI waiting; its floor is 0.0025 less 10%.
    assert.deepEqual([intent.quoteIn, intent.heldQuote, intent.minMemeOut], [String(piece), "20000000000", String(piece * 360n)]);
    const row = rows.get(intent.vaultId)!;
    assert.deepEqual([row.outcome, row.pieces_today, row.quote_spent_total], ["executed", 1, String(piece)]);
    // Quote is left: the next piece waits for a random time at least the gap later.
    assert.equal(row.state, "waiting");
    assert.equal((row.run_at as Date).getTime(), NOON + 3_600_000 + GAP + 3_600_000);
  }
  assert.equal(harness.logs.filter(([name]) => name === "buyback.burned").length, 2);

  // The rest is under $50: done for today, and the next day draws again.
  harness.at(NOON + 2 * 3_600_000 + GAP);
  await harness.run();
  rows = await harness.rows();
  for (const launch of LAUNCHES) assert.deepEqual([rows.get(launch.vaultId)!.state, rows.get(launch.vaultId)!.outcome], ["done", "below-minimum"]);
  assert.equal(harness.intents.length, 2);
  harness.at(NOON + DAY_MS);
  await harness.run();
  rows = await harness.rows();
  for (const launch of LAUNCHES) assert.deepEqual([rows.get(launch.vaultId)!.state, rows.get(launch.vaultId)!.pieces_today], ["waiting", 0]);
});

test("a balance above the cap is spread over random pieces at random times, never stuck", { skip }, async (t) => {
  const [cetus, bluefin] = LAUNCHES;
  // 100 SUI waiting in a 3,000 SUI pool: one piece spends at most 30 SUI.
  const markets = new Map<string, Market>([
    [cetus!.vaultId, { ...healthy(), held: 100_000_000_000n, poolQuote: 3_000_000_000_000n }],
    [bluefin!.vaultId, { ...healthy(), held: 0n }],
  ]);
  // The lowest answer everywhere: each piece is the $50 minimum, each next piece exactly the gap later.
  const harness = await setup(t, { markets });
  const times: number[] = [];
  for (let pass = 0; pass < 12; pass += 1) {
    const before = harness.intents.length;
    harness.at(NOON + pass * GAP);
    await harness.run();
    if (harness.intents.length > before) times.push(NOON + pass * GAP);
  }
  const pieces = harness.intents.filter((intent) => intent.vaultId === cetus!.vaultId);
  assert.equal(pieces.length, 6, "100 SUI in $50 pieces: six, then under $50 is left");
  assert.ok(pieces.every((intent) => BigInt(intent.quoteIn) <= 30_000_000_000n && BigInt(intent.quoteIn) <= BigInt(intent.heldQuote)));
  assert.ok(times.slice(1).every((time, index) => time - times[index]! >= GAP), "pieces are at least the gap apart");
  const row = (await harness.rows()).get(cetus!.vaultId)!;
  assert.deepEqual([row.state, row.outcome, row.pieces_today], ["done", "below-minimum", 6]);
  assert.equal(markets.get(cetus!.vaultId)!.held, 100_000_000_000n - 6n * MIN_PIECE);
});

test("the cap bounds a piece; what is left when the day ends waits for the next day's draw", { skip }, async (t) => {
  const [cetus, bluefin] = LAUNCHES;
  const markets = new Map<string, Market>([
    [cetus!.vaultId, { ...healthy(), held: 100_000_000_000n, poolQuote: 3_000_000_000_000n }],
    [bluefin!.vaultId, { ...healthy(), held: 0n }],
  ]);
  // The highest answer everywhere: the last millisecond of the day, the largest piece.
  const harness = await setup(t, { markets, random: constant(2 ** 47) });
  const lastMs = NOON + DAY_MS / 2 - 1;
  await harness.run();
  assert.equal(((await harness.rows()).get(cetus!.vaultId)!.run_at as Date).getTime(), lastMs);
  harness.at(lastMs);
  await harness.run();
  assert.deepEqual(harness.intents.map((intent) => intent.quoteIn), ["30000000000"], "the cap, 1% of the pool");
  let row = (await harness.rows()).get(cetus!.vaultId)!;
  assert.deepEqual([row.state, row.outcome], ["done", "executed"], "no time left today");
  harness.at(lastMs + DAY_MS);
  await harness.run();
  await harness.run();
  row = (await harness.rows()).get(cetus!.vaultId)!;
  assert.deepEqual([harness.intents.length, row.quote_spent_total], [2, "60000000000"]);
});

test("a stale reference or a deviating spot waits and retries; a thin pool and the minimum end the day", { skip }, async (t) => {
  const [cetus, bluefin] = LAUNCHES;
  const markets = new Map<string, Market>([
    [cetus!.vaultId, { ...healthy(), reference: { status: "stale" } }],
    // Spot exactly 10% above the reference.
    [bluefin!.vaultId, { ...healthy(), spot: { numerator: 275n, denominator: 100_000n } }],
  ]);
  const harness = await setup(t, { markets });
  await harness.run();
  let rows = await harness.rows();
  assert.deepEqual([rows.get(cetus!.vaultId)!.state, rows.get(cetus!.vaultId)!.outcome], ["waiting", "reference-stale"]);
  assert.deepEqual([rows.get(bluefin!.vaultId)!.state, rows.get(bluefin!.vaultId)!.outcome], ["waiting", "price-deviation"]);
  assert.ok(rows.get(cetus!.vaultId)!.next_eligible_at, "a retry waits");
  assert.equal(harness.intents.length, 0, "neither signed");

  // 1% of a 1,000 SUI pool is under a $50 piece; under $50 waiting. Both done for today.
  markets.set(cetus!.vaultId, { ...healthy(), poolQuote: 1_000_000_000_000n });
  markets.set(bluefin!.vaultId, { ...healthy(), held: 1_000_000_000n });
  harness.at(NOON + 60_000);
  await harness.run();
  rows = await harness.rows();
  assert.deepEqual([rows.get(cetus!.vaultId)!.state, rows.get(cetus!.vaultId)!.outcome], ["done", "pool-too-thin"]);
  assert.deepEqual([rows.get(bluefin!.vaultId)!.state, rows.get(bluefin!.vaultId)!.outcome], ["done", "below-minimum"]);
  assert.deepEqual(harness.alerts.raised, []);
  assert.equal(harness.intents.length, 0);
});

test("repeated min_meme_out aborts, simulated or on chain, raise the alert; a buyback clears it", { skip }, async (t) => {
  const [cetus] = LAUNCHES;
  const markets = new Map<string, Market>([[cetus!.vaultId, healthy()], [LAUNCHES[1]!.vaultId, { ...healthy(), held: 0n }]]);
  const harness = await setup(t, { markets, attempts: ["min-out-sim", "min-out-chain", "executed"] });
  const key = `buyback_min_out:${cetus!.vaultId}`;
  await harness.run();
  let row = (await harness.rows()).get(cetus!.vaultId)!;
  assert.deepEqual([row.outcome, row.min_out_aborts], ["min-out-abort", 1]);
  assert.deepEqual(harness.alerts.raised, [], "one abort is not yet an alert");

  harness.at(NOON + 60_000);
  await harness.run();
  row = (await harness.rows()).get(cetus!.vaultId)!;
  assert.deepEqual([row.outcome, row.min_out_aborts, row.attempts], ["min-out-abort", 2, 1]);
  assert.deepEqual(harness.alerts.raised, [key]);

  harness.at(NOON + 120_000);
  await harness.run();
  row = (await harness.rows()).get(cetus!.vaultId)!;
  assert.deepEqual([row.state, row.outcome, row.min_out_aborts, row.pieces_today], ["waiting", "executed", 0, 1], "Quote is left: the next piece is planned");
  assert.ok(harness.alerts.cleared.includes(key));
  // The other vault holds nothing: done without a read of prices or a signature.
  assert.equal((await harness.rows()).get(LAUNCHES[1]!.vaultId)!.outcome, "nothing-held");
});

test("the release gate opens per identity and is append-only", { skip }, async (t) => {
  const harness = await setup(t);
  const identity: ReleaseGateIdentity = { role: "vault-buyback", network: "mainnet", fingerprint: "f".repeat(64), signerAddress: KEY.toSuiAddress(), adminCapId: CAP };
  assert.deepEqual(await readReleaseGate(harness.pool, identity), ["buyback-key", "buyback-admin-grant", "buyback-alerts"]);
  for (const check of ["buyback-key", "buyback-admin-grant", "buyback-alerts"]) {
    await recordReleaseCheck(harness.admin, identity, check, true, `${check} ${DIGEST} BLAST_BUYBACK_SIGNER_KEY=suiprivkey1secret`);
  }
  assert.deepEqual(await readReleaseGate(harness.pool, identity), []);
  const { rows } = await harness.admin.query<{ evidence: string }>("SELECT evidence FROM blast_worker_release_gate_checks");
  assert.ok(rows.every((row) => !row.evidence.includes("suiprivkey1secret")), "evidence is redacted");
  // Another cap (a rotation) starts closed; revoking a check pauses the key.
  assert.equal((await readReleaseGate(harness.pool, { ...identity, adminCapId: id("cb") })).length, 3);
  await recordReleaseCheck(harness.admin, identity, "buyback-key", false, "paused for review");
  assert.deepEqual(await readReleaseGate(harness.pool, identity), ["buyback-key"]);
  await assert.rejects(
    harness.admin.query("UPDATE blast_worker_release_gate_checks SET passed = TRUE WHERE identity_digest = $1", [releaseGateDigest(identity)]),
    { code: "23514" },
  );
  await assert.rejects(harness.pool.query("INSERT INTO blast_worker_release_gate_checks (network, identity_digest, check_name, passed, evidence) VALUES ('mainnet', $1, 'buyback-key', true, 'x')", [releaseGateDigest(identity)]), { code: "42501" });
});

test("each pass checks the release gate, the cap's owner and that the ACL grants it BuybackAdmin alone", { skip }, async (t) => {
  const { aclBcs, aclAdminFieldName } = await import("@interest-protocol/blast-admin-sdk");
  const { bcs } = await import("@mysten/sui/bcs");
  const { buybackAccessCheck } = await import("./access.ts");
  const harness = await setup(t);
  const address = KEY.toSuiAddress();
  const acl = deployment.sharedObjects.admin.acl;
  const buyback = `${deployment.packages.core.originalPackageId}::blast_domain::BuybackAdmin`;
  let roles = [buyback];
  let owner = address;
  const client = {
    core: {
      getDynamicField: async () => ({ dynamicField: {
        name: aclAdminFieldName(CAP),
        value: { type: "0x2::vec_set::VecSet<0x1::type_name::TypeName>", bcs: bcs.vector(bcs.string()).serialize(roles.map((role) => normalizeStructTag(role).slice(2))).toBytes() },
      } }),
      getObjects: async ({ objectIds }: { objectIds: string[] }) => ({
        objects: objectIds.map((objectId) =>
          normalizeSuiAddress(objectId) === CAP
            ? { objectId: CAP, version: "12", digest: DIGEST, owner: { $kind: "AddressOwner", AddressOwner: owner }, type: "cap" }
            : {
                objectId: acl.objectId,
                version: "20",
                digest: DIGEST,
                owner: { $kind: "Shared", Shared: { initialSharedVersion: acl.initialSharedVersion } },
                type: `${deployment.packages.admin.originalPackageId}::blast_acl::ACL`,
                content: aclBcs
                  .serialize({
                    id: { id: { bytes: acl.objectId } },
                    super_admin_cap_id: id("5a"),
                    admins: { id: { id: { bytes: id("7a") } }, size: 1n },
                    super_admin_transfer: { parent: acl.objectId, key: null, delay_ms: 0n, pending: null },
                  } as never)
                  .toBytes(),
              },
        ),
      }),
    },
  } as never;
  const enabled = { status: "enabled", deployment, fingerprint: "f".repeat(64), protocol } as const;
  const config = workerConfigFromEnvironment(workerEnvironment(harness.url, "/nonexistent.json", { BLAST_WORKER_SIGNER_KEY: undefined }));
  const check = buybackAccessCheck({ config, client, pool: harness.pool, log: () => {}, signerAddress: address, adminCapId: CAP, stack: async () => enabled as never });
  const reasons = async () => {
    const verdict = await check();
    return verdict.status === "blocked" ? verdict.reasons : [];
  };
  assert.deepEqual(await reasons(), ["release-gate-open"]);
  const identity: ReleaseGateIdentity = { role: "vault-buyback", network: "mainnet", fingerprint: "f".repeat(64), signerAddress: address, adminCapId: CAP };
  for (const name of ["buyback-key", "buyback-admin-grant", "buyback-alerts"]) {
    await recordReleaseCheck(harness.admin, identity, name, true, "ok");
  }
  assert.deepEqual(await reasons(), []);
  protocol.paused.vault = 1;
  assert.deepEqual(await reasons(), ["vault-admin-paused"]);
  protocol.paused.vault = 0;
  roles = [buyback, `${deployment.packages.core.originalPackageId}::blast_domain::TreasuryAdmin`];
  assert.deepEqual(await reasons(), ["admin-cap-roles"], "a cap with any other role never signs");
  roles = [];
  assert.deepEqual(await reasons(), ["admin-cap-roles"], "a revoked role blocks");
  roles = [buyback];
  owner = id("0e");
  assert.deepEqual(await reasons(), ["admin-cap-not-owned"]);
});
