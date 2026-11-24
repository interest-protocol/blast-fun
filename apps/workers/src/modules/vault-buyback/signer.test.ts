import type { MigratorVenue } from "@blast/core/modules/launchpad-contract/venues.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { adminDeployment, coreDeployment, defineBlastDeployment, migratorsDeployment, type BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { AdminCalls } from "@interest-protocol/blast-admin-sdk/transactions";
import { coreRoleType } from "@interest-protocol/blast-core/roles";
import { MigratorCalls } from "@interest-protocol/blast-migrators-sdk";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import { NON_PRODUCTION_MANIFEST } from "../../../test/fixtures/final-stack/non-production-deployment.ts";
import { sharedCurrencyId } from "#workers/modules/blast-keeper/chain.ts";
import { SignerRefusal } from "#workers/modules/worker-runtime/signer.ts";
import { assertBuybackOnly, loadBuybackSigner, parseBuybackIntent, type BuybackIntent } from "./signer.ts";
import { addressBalanceGas } from "../../../test/fixtures/modules/worker-runtime/address-balance-gas.ts";

/** A generated fixture key; it never holds real value. */
const KEY = Ed25519Keypair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, index) => index + 7));
const SENDER = KEY.toSuiAddress();
const id = (byte: string) => normalizeSuiAddress(`0x${byte.repeat(32)}`);
const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const GAS = { objectId: id("9a"), version: "3", digest: DIGEST };
const CAP = { objectId: id("ca"), version: "11", digest: DIGEST };
const CETUS_CONFIG = { objectId: id("c1"), initialSharedVersion: "7" };
const BLUEFIN_CONFIG = { objectId: id("b1"), initialSharedVersion: "8" };
const BUDGET = 50_000_000n;

const base = defineBlastDeployment(NON_PRODUCTION_MANIFEST);
/** The fixture manifest with both venues' configs recorded: all the guard reads of a deployment. */
const deployment = {
  ...base,
  sharedObjects: { ...base.sharedObjects, cetus: { config: CETUS_CONFIG, pools: CETUS_CONFIG, burnManager: CETUS_CONFIG }, bluefin: { config: BLUEFIN_CONFIG } },
} as unknown as BlastDeployment;
const binding = { deployment, adminCapId: CAP.objectId, gasBudgetMist: BUDGET };

const MEME = `${id("ab")}::meme::MEME`;
const QUOTE = `${normalizeSuiAddress("0x2")}::sui::SUI`;
const VAULT = { objectId: id("aa"), initialSharedVersion: "9", mutable: true as const };
const POOL = { objectId: id("bb"), initialSharedVersion: "10", mutable: true as const };

function intent(venue: MigratorVenue, overrides: Partial<BuybackIntent> = {}): BuybackIntent {
  return {
    venue,
    vaultId: VAULT.objectId,
    poolId: POOL.objectId,
    memeType: MEME,
    quoteType: QUOTE,
    quoteIn: "5000",
    heldQuote: "9000",
    minMemeOut: "12345",
    ...overrides,
  };
}

type Build = Readonly<{
  calls?: MigratorCalls;
  cap?: typeof CAP;
  role?: "BuybackAdmin" | "TreasuryAdmin";
  vault?: typeof VAULT;
  pool?: typeof POOL;
  config?: typeof CETUS_CONFIG;
  currency?: string;
  minMemeOut?: bigint;
  quoteIn?: bigint;
  extra?: (tx: Transaction) => void;
  sender?: string;
  budget?: bigint;
  /** Pays with a gas coin instead of the address balance, which the signer refuses. */
  gasCoin?: boolean;
  vaultVersion?: string;
}>;

async function bytesOf(venue: MigratorVenue, build: Build = {}): Promise<Uint8Array> {
  const migrators = migratorsDeployment(base);
  const calls = build.calls ?? new MigratorCalls(build.vaultVersion ? { ...migrators, vault: { ...migrators.vault, packageVersion: { ...migrators.vault.packageVersion, objectId: build.vaultVersion } } } : migrators);
  const tx = new Transaction();
  const adminWitness = tx.add(new AdminCalls(adminDeployment(base)).signIn({ adminCap: tx.objectRef(build.cap ?? CAP), role: coreRoleType(coreDeployment(base), build.role ?? "BuybackAdmin") }));
  const common = {
    memeType: MEME,
    quoteType: QUOTE,
    vault: build.vault ?? VAULT,
    adminWitness,
    currency: { objectId: build.currency ?? sharedCurrencyId(MEME), initialSharedVersion: "4", mutable: true as const },
    pool: build.pool ?? POOL,
    quoteIn: build.quoteIn ?? 5_000n,
    minMemeOut: build.minMemeOut ?? 12_345n,
  };
  if (venue === "cetus") {
    tx.add(calls.buybackAndBurnCetus({ ...common, cetus: { config: (build.config ?? CETUS_CONFIG) } }));
  } else {
    tx.add(calls.buybackAndBurnBluefin({ ...common, bluefinConfig: (build.config ?? BLUEFIN_CONFIG) }));
  }
  build.extra?.(tx);
  addressBalanceGas(tx, { sender: build.sender ?? SENDER, gasBudgetMist: build.budget ?? BUDGET, chainIdentifier: deployment.chainIdentifier });
  if (build.gasCoin) tx.setGasPayment([GAS]);
  return tx.build();
}

async function refused(
  bytes: Promise<Uint8Array>,
  claimed: BuybackIntent,
  bound: typeof binding,
  reason: RegExp,
  label: string,
): Promise<void> {
  const raw = await bytes;
  assert.throws(() => assertBuybackOnly(raw, SENDER, claimed, bound), (error: unknown) => error instanceof SignerRefusal && reason.test(error.reason), label);
}

test("the buyback key signs each venue's buyback_and_burn of the active migrators package, and nothing else", async () => {
  const signer = loadBuybackSigner({ BLAST_BUYBACK_SIGNER_KEY: KEY.getSecretKey() }, { gasBudgetMist: BUDGET, adminCapId: CAP.objectId });
  assert.equal(signer.address, SENDER);
  for (const venue of ["cetus", "bluefin"] as const) {
    const signed = await signer.signBuyback(await bytesOf(venue), intent(venue), deployment);
    assert.ok(signed.signature && signed.digest, venue);
  }
});

test("the guard refuses foreign targets, objects, roles, caps and amounts", async () => {
  for (const venue of ["cetus", "bluefin"] as const) {
    const good = intent(venue);
    const foreignPackage = new MigratorCalls({ ...migratorsDeployment(base), packageId: id("ee") });
    await refused(bytesOf(venue, { calls: foreignPackage }), good, binding, /another call/, "foreign migrators package");
    await refused(bytesOf(venue, { cap: { ...CAP, objectId: id("cb") } }), good, binding, /another AdminCap/, "another cap");
    await refused(bytesOf(venue, { role: "TreasuryAdmin" }), good, binding, /another admin role/, "another role");
    await refused(bytesOf(venue, { vault: { ...VAULT, objectId: id("a1") } }), good, binding, /another shared object/, "another vault");
    await refused(bytesOf(venue, { pool: { ...POOL, objectId: id("b2") } }), good, binding, /another shared object/, "another pool");
    await refused(bytesOf(venue, { config: { objectId: id("c9"), initialSharedVersion: "7" } }), good, binding, /another shared object/, "another venue config");
    await refused(bytesOf(venue, { vaultVersion: id("fe") }), good, binding, /another shared object/, "another vault package version");
    await refused(bytesOf(venue, { currency: id("cc") }), good, binding, /another shared object/, "another currency");
    await refused(bytesOf(venue, { minMemeOut: 1n }), good, binding, /another min_meme_out/, "another minimum");
    // The piece is exactly the intent's, and never more than the balance the job read.
    await refused(bytesOf(venue, { quoteIn: 5_001n }), good, binding, /another quote_in/, "a larger piece");
    await refused(bytesOf(venue, { quoteIn: 4_999n }), good, binding, /another quote_in/, "a smaller piece");
    await refused(bytesOf(venue, { quoteIn: 9_001n }), intent(venue, { quoteIn: "9001" }), binding, /another quote_in/, "a piece above the balance read");
    await refused(bytesOf(venue, { extra: (tx) => tx.transferObjects([tx.splitCoins(tx.gas, [1n])], SENDER) }), good, binding, /gas coin/, "a payment out of gas");
    await refused(bytesOf(venue, { extra: (tx) => tx.moveCall({ target: `${id("ee")}::evil::call` }) }), good, binding, /unexpected commands/, "an extra command");
    await refused(bytesOf(venue, { sender: id("51") }), good, binding, /another sender/, "another sender");
    await refused(bytesOf(venue, { gasCoin: true }), good, binding, /a gas coin payment/, "a gas coin payment");
    await refused(bytesOf(venue, { budget: BUDGET + 1n }), good, binding, /gas budget/, "an excess budget");
    // The intent names another vault than the bytes, or the other venue.
    await refused(bytesOf(venue), intent(venue, { vaultId: id("a1") }), binding, /another shared object/, "intent vault");
    await refused(bytesOf(venue), intent(venue === "cetus" ? "bluefin" : "cetus"), binding, /another call/, "other venue");
    // A deployment without the venue's config never signs that venue.
    const bare = { ...binding, deployment: base };
    await refused(bytesOf(venue), good, bare, /without this venue/, "unrecorded venue");
  }
});

test("a stored intent is parsed strictly before anything is checked", () => {
  for (const bad of [
    null,
    {},
    { ...intent("cetus"), minMemeOut: "0" },
    { ...intent("cetus"), quoteIn: "0" },
    { ...intent("cetus"), quoteIn: "9001" },
    { ...intent("cetus"), heldQuote: undefined }, { ...intent("cetus"), venue: "aftermath" }, { ...intent("cetus"), extra: 1 }, { ...intent("cetus"), vaultId: "0x1" }]) {
    assert.throws(() => parseBuybackIntent(bad), SignerRefusal);
  }
  assert.deepEqual(parseBuybackIntent(intent("bluefin")), intent("bluefin"));
});

test("the key loads only from its own variable, and errors never carry it", () => {
  assert.throws(() => loadBuybackSigner({}, { gasBudgetMist: BUDGET, adminCapId: CAP.objectId }), /BLAST_BUYBACK_SIGNER_KEY is required/);
  assert.throws(
    () => loadBuybackSigner({ BLAST_BUYBACK_SIGNER_KEY: "not-a-key" }, { gasBudgetMist: BUDGET, adminCapId: CAP.objectId }),
    (error: unknown) => error instanceof Error && !error.message.includes("not-a-key"),
  );
  assert.throws(
    () => loadBuybackSigner({ BLAST_WORKER_SIGNER_KEY: KEY.getSecretKey() }, { gasBudgetMist: BUDGET, adminCapId: CAP.objectId }),
    /BLAST_WORKER_SIGNER_KEY must not be set/,
  );
});

