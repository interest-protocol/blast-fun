import { SUI_COIN_TYPE as quote } from "@blast/core/lib/sui/coin-types.ts";
import type { MigratorVenue } from "@blast/core/modules/launchpad-contract/venues.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { aclAdminFieldName, aclBcs } from "@interest-protocol/blast-admin-sdk";
import { BLAST_DEPLOYMENTS, deploymentFingerprint } from "@interest-protocol/blast-deployments-sdk";
import { bluefinPoolBcs } from "@interest-protocol/blast-deployments-sdk/bluefin-venue";
import {
  CETUS_MIN_SQRT_PRICE_X64,
  cetusPoolPrefixBcs,
} from "@interest-protocol/blast-deployments-sdk/cetus-venue";
import { vaultEventBcs } from "@interest-protocol/blast-vault-sdk/events";
import { vaultBcs } from "@interest-protocol/blast-vault-sdk/state";
import { bcs } from "@mysten/sui/bcs";
import { TransactionError, type ClientWithCoreApi } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress, toBase58 } from "@mysten/sui/utils";

import {
  executeAutoLp,
  prepareAutoLp,
  priceBand,
  reconcileAutoLp,
  requireFreshReference,
} from "./compound.ts";
import { readAutoLpAttempt, recordAutoLpAttempt } from "./journal.ts";

const deployment = BLAST_DEPLOYMENTS.mainnet;
assert.ok(deployment);
const fingerprint = deploymentFingerprint(deployment);
const access = {
  status: "enabled",
  deployment,
  fingerprint,
  protocol: {
    signing: "enabled",
    deployment,
    fingerprint,
    venues: {
      cetus: { available: true },
      bluefin: { available: true },
      aftermathDao: { available: true },
    },
    paused: { vault: 0, launchpad: 0, presale: 0, migrators: 0 },
  },
} as const satisfies Parameters<typeof prepareAutoLp>[0]["access"];

const id = normalizeSuiAddress;
const uid = (address: string) => ({ id: { bytes: address } });
const signer = Ed25519Keypair.generate();
const sender = signer.toSuiAddress();
const capId = id("0xca");
const vaultId = id("0x70");
const poolId = id("0x71");
const aclId = deployment.sharedObjects.admin.acl.objectId;
const adminsTableId = id("0x7a");
const digest = toBase58(new Uint8Array(32).fill(1));
const role = `${deployment.packages.core.originalPackageId}::blast_domain::AutoLpAdmin`;
const meme = normalizeStructTag("0x1::test::MEME");
const spot = 1n << 64n;
const eventType = normalizeStructTag(
  `${deployment.packages.vault.originalPackageId}::blast_vault_events::AutoLiquidityAdded<${meme},${quote}>`,
);
const addition = {
  vault_id: vaultId,
  meme_amount: 90n,
  quote_amount: 90n,
  auto_lp_meme_pending: 10n,
  auto_lp_quote_pending: 30n,
};
const receipt = {
  eventType,
  sender,
  bcs: vaultEventBcs.AutoLiquidityAdded.serialize(addition).toBytes(),
};
const provider = <Result>(call: (signal: AbortSignal) => Promise<Result>) =>
  call(new AbortController().signal);

const sharedOwner = { $kind: "Shared", Shared: { initialSharedVersion: "1" } };
const delay = (parent: string) => ({
  parent,
  key: null,
  delay_ms: 0n,
  pending: null,
});
const acl = {
  objectId: aclId,
  owner: sharedOwner,
  type: `${deployment.packages.admin.originalPackageId}::blast_acl::ACL`,
  content: aclBcs
    .serialize({
      id: uid(aclId),
      super_admin_cap_id: id("0x1"),
      admins: { id: uid(adminsTableId), size: 1n },
      super_admin_transfer: delay(aclId),
    })
    .toBytes(),
};
const table = { id: uid(id("0x72")), size: 0 };
const poolState = {
  id: uid(poolId),
  coin_a: { value: 1_000_000n },
  coin_b: { value: 1_000_000n },
  liquidity: 1000n,
  current_sqrt_price: spot,
};

function market(venue: MigratorVenue, pendingMeme: bigint, paused: boolean) {
  assert.ok(deployment);
  const poolPackage =
    venue === "cetus" ? deployment.packages.cetusClmm : deployment.packages.bluefinSpot;
  assert.ok(poolPackage);
  const witness = normalizeStructTag(
    `${deployment.packages.launchpad.originalPackageId}::blast_fun::PackageWitness`,
  );
  const origin = id("0x73");
  const feeSplit = {
    routes: [{ destination: { kind: "AutoLp" as const }, bps: 10_000n }],
  };
  const vault = {
    objectId: vaultId,
    owner: sharedOwner,
    type: `${deployment.packages.vault.originalPackageId}::vault::Vault<${meme},${quote}>`,
    content: vaultBcs
      .serialize({
        id: uid(vaultId),
        terms: {
          origin,
          packageWitness: witness,
          feeSplit,
          protocolMemeBps: 0n,
          protocolQuoteBps: 0n,
          partnerId: null,
          residuals: "Owner",
        },
        venue: `${deployment.packages.migrators.originalPackageId}::${venue}::Venue`,
        pool_id: poolId,
        fee_split: { ...delay(vaultId), value: feeSplit },
        protocol_bps: {
          ...delay(vaultId),
          value: { meme_bps: 0n, quote_bps: 0n },
        },
        protocol: {
          packageWitness: witness,
          origin: vaultId,
          partnerId: null,
          meme: 0n,
          quote: 0n,
          sui: 0n,
        },
        owner_meme: 0n,
        owner_quote: 0n,
        rewards_meme: 0n,
        rewards_quote: 0n,
        burn_quote: 0n,
        auto_lp_meme: pendingMeme,
        auto_lp_quote: 120n,
        next_round: 0n,
        last_checkpoint: null,
        round_publication: delay(vaultId),
      })
      .toBytes(),
  };
  const poolPair = venue === "cetus" ? [quote, meme] : [meme, quote];
  const pool = {
    objectId: poolId,
    owner: sharedOwner,
    type: `${poolPackage.originalPackageId}::pool::Pool<${poolPair.join(",")}>`,
    content:
      venue === "cetus"
        ? cetusPoolPrefixBcs.serialize({ ...poolState, tick_spacing: 200, fee_rate: 10_000 }).toBytes()
        : bluefinPoolBcs
            .serialize({
              ...poolState,
              name: "MEME-SUI",
              fee_rate: 100,
              protocol_fee_share: 0,
              fee_growth_global_coin_a: 0,
              fee_growth_global_coin_b: 0,
              protocol_fee_coin_a: 0,
              protocol_fee_coin_b: 0,
              ticks_manager: { tick_spacing: 2, ticks: table, bitmap: table },
              observations_manager: {
                observations: [],
                observation_index: 0,
                observation_cardinality: 0,
                observation_cardinality_next: 0,
              },
              current_tick_index: 0,
              reward_infos: [],
              is_paused: paused,
              icon_url: "",
              position_index: 0,
              sequence_number: 0,
            })
            .toBytes(),
  };
  return { vault, pool, poolPair };
}

function fixture(
  venue: MigratorVenue,
  {
    roles = [role] as readonly string[],
    owner = sender,
    pendingMeme = 100n,
    paused = false,
    events = [receipt] as readonly (typeof receipt)[],
    success = true,
  } = {},
) {
  const { vault, pool, poolPair } = market(venue, pendingMeme, paused);
  let simulationBytes: Uint8Array | undefined;
  const node = {
    getObjects: async ({ objectIds }: { objectIds: string[] }) => ({
      objects: objectIds.map((objectId) =>
        objectId === aclId
          ? acl
          : {
              objectId: capId,
              owner: { $kind: "AddressOwner", AddressOwner: owner },
              digest,
              version: "1",
            },
      ),
    }),
    getDynamicField: async () => ({
      dynamicField: {
        name: aclAdminFieldName(capId),
        value: {
          type: "0x2::vec_set::VecSet<0x1::type_name::TypeName>",
          bcs: bcs
            .vector(bcs.string())
            .serialize(roles.map((name) => name.slice(2)))
            .toBytes(),
        },
      },
    }),
    getObject: async ({ objectId }: { objectId: string }) => ({
      object: objectId === vaultId ? vault : pool,
    }),
    getCurrentSystemState: async () => ({
      systemState: { epoch: "123", referenceGasPrice: "1000" },
    }),
    getBalance: async () => ({ balance: { addressBalance: "1000000000" } }),
    getChainIdentifier: async () => ({
      chainIdentifier: deployment?.chainIdentifier,
    }),
    simulateTransaction: async (options: { transaction: Uint8Array; doGasSelection?: boolean }) => {
      assert.equal(options.doGasSelection, false);
      simulationBytes = options.transaction;
      return {
        $kind: "Transaction",
        gasPaymentMocked: false,
        Transaction: {
          effects: {
            status: { success },
            gasUsed: {
              computationCost: "100",
              storageCost: "20",
              storageRebate: "10",
            },
          },
          events,
        },
      };
    },
  };
  const request = {
    sender,
    capId,
    vaultId,
    poolId,
    referenceSqrtPrice: spot,
    referenceTimeMs: Date.now(),
    gasBudgetMist: 200_000_000n,
  };
  return { node, request, poolPair, simulated: () => simulationBytes };
}

function asClient(core: object) {
  return { core } as ClientWithCoreApi;
}

for (const venue of ["cetus", "bluefin"] as const) {
  test(`prepares and simulates one bounded ${venue} call using the released SDK`, async () => {
    const { node, request, poolPair, simulated } = fixture(venue);
    const prepared = await prepareAutoLp({
      client: asClient(node),
      access,
      request,
      provider,
    });
    assert.deepEqual(prepared.bytes, simulated());
    assert.equal(prepared.attempt.digest, TransactionDataBuilder.getDigestFromBytes(prepared.bytes));
    assert.deepEqual(prepared.preview.addition, addition);
    assert.equal(prepared.preview.gasCostMist, 110n);
    assert.deepEqual([prepared.preview.coinTypeA, prepared.preview.coinTypeB], poolPair);

    const tx = Transaction.from(prepared.bytes).getData();
    assert.equal(tx.commands.length, 1);
    const call = tx.commands[0]?.MoveCall;
    assert.ok(call);
    assert.equal(call.package, deployment?.packages.migrators.packageId);
    assert.equal(call.module, venue);
    assert.equal(call.function, "compound_auto_lp");
    assert.deepEqual(
      call.typeArguments.map(normalizeStructTag),
      venue === "cetus" ? [meme, quote, ...poolPair] : [meme, quote],
    );
    const input = (argument: number) => {
      const arg = call.arguments[argument];
      assert.ok(arg?.$kind === "Input");
      return tx.inputs[arg.Input];
    };
    assert.equal(input(4)?.Object?.ImmOrOwnedObject?.objectId, capId);
    assert.equal(input(6)?.Object?.SharedObject?.objectId, poolId);
    assert.equal(input(7)?.Pure?.bytes, bcs.u128().serialize(prepared.preview.minSqrtPrice).toBase64());
    assert.equal(input(8)?.Pure?.bytes, bcs.u128().serialize(prepared.preview.maxSqrtPrice).toBase64());
    assert.deepEqual(tx.gasData, {
      budget: "200000000",
      owner: sender,
      payment: [],
      price: "1000",
    });
    assert.equal(tx.expiration?.ValidDuring?.minEpoch, "123");
    assert.equal(tx.expiration?.ValidDuring?.maxEpoch, "123");
  });
}

test("price guards bound Q64.64 sqrt prices and reject future or stale references", () => {
  const { minSqrtPrice, maxSqrtPrice } = priceBand("cetus", spot, spot);
  assert.equal(minSqrtPrice, spot - spot / 200n);
  assert.equal(maxSqrtPrice, spot + spot / 200n);
  assert.equal(
    priceBand("cetus", CETUS_MIN_SQRT_PRICE_X64, CETUS_MIN_SQRT_PRICE_X64).minSqrtPrice,
    CETUS_MIN_SQRT_PRICE_X64,
  );
  assert.throws(() => priceBand("bluefin", spot, maxSqrtPrice + 1n), /outside the reviewed price band/);
  assert.throws(() => requireFreshReference(0, 300_001), /five minutes/);
  assert.throws(() => requireFreshReference(2, 1), /five minutes/);
});

test("authority, pool identity, liquidity inputs and simulation refuse before signing", async () => {
  for (const [options, message] of [
    [{ roles: [] }, /only AutoLpAdmin/],
    [{ roles: [role, `${role}Other`] }, /only AutoLpAdmin/],
    [{ owner: id("0x9") }, /only AutoLpAdmin/],
    [{ pendingMeme: 0n }, /Both pending/],
    [{ paused: true }, /Bluefin pool is paused/],
    [{ success: false }, /failed simulation/],
    [{ events: [] }, /did not add both assets/],
    [{ pendingMeme: 101n }, /pending balances changed/],
  ] as const) {
    const { node, request } = fixture("bluefin", options);
    await assert.rejects(prepareAutoLp({ client: asClient(node), access, request, provider }), message);
  }
  const { node, request } = fixture("cetus");
  await assert.rejects(
    prepareAutoLp({
      client: asClient(node),
      access,
      request: { ...request, poolId: id("0x99") },
      provider,
    }),
    /does not match the vault/,
  );
});

test("the exclusive journal fences concurrent submissions and reconciliation binds the digest and receipt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blast-auto-lp-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = join(dir, "attempt.json");
  const { node, request } = fixture("cetus");
  const prepared = await prepareAutoLp({
    client: asClient(node),
    access,
    request,
    provider,
  });
  const attempt = prepared.attempt;
  let sends = 0;
  let events = [receipt];
  let reportedDigest = attempt.digest;
  let settled = false;
  let success = true;
  const getTransaction = async () => {
    if (!settled) throw new TransactionError("notFound", attempt.digest);
    return {
      Transaction: {
        digest: reportedDigest,
        effects: { transactionDigest: attempt.digest, status: { success } },
        events,
      },
    };
  };
  const client = asClient({
    ...node,
    executeTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
      sends++;
      assert.deepEqual(transaction, prepared.bytes);
      assert.deepEqual(await readAutoLpAttempt(journal, sender), attempt);
      throw new Error("submission response lost");
    },
    waitForTransaction: getTransaction,
    getTransaction,
  });
  const options = {
    client,
    prepared,
    provider,
    bounds: { providerTimeoutMs: 1000, confirmTimeoutMs: 1000 },
    sign: (bytes: Uint8Array) => signer.signTransaction(bytes),
    record: (entry: typeof attempt) => recordAutoLpAttempt(journal, entry),
  };
  assert.deepEqual(await executeAutoLp(options), { outcome: "unknown" });
  await assert.rejects(executeAutoLp(options), /recorded exclusively/);
  assert.equal(sends, 1);

  settled = true;
  reportedDigest = digest;
  assert.deepEqual(await reconcileAutoLp(client, attempt, provider), {
    outcome: "unknown",
  });
  reportedDigest = attempt.digest;
  events = [{ ...receipt, sender: id("0x91") }];
  assert.deepEqual(await reconcileAutoLp(client, attempt, provider), {
    outcome: "unconfirmed-addition",
  });
  events = [receipt];
  assert.deepEqual(await reconcileAutoLp(client, attempt, provider), {
    outcome: "compounded",
    addition,
  });
  success = false;
  assert.deepEqual(await reconcileAutoLp(client, attempt, provider), {
    outcome: "failed",
  });

  await writeFile(journal, "{");
  await assert.rejects(readAutoLpAttempt(journal, sender), /journal is invalid/);
});
