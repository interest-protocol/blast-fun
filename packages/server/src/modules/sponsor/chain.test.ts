import assert from "node:assert/strict";
import test from "node:test";

import { roundBcs, vaultBcs } from "@interest-protocol/blast-sdk/vault";
import type { VaultTerms } from "@interest-protocol/blast-core/migration";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";

import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import { createSponsorChain, simulationOutcome } from "./chain.ts";
import {
  OTHER_PRESALE_ID,
  PRESALE_ID,
  PRESALE_PACKAGE,
  QUOTE,
  ROUND_ID,
  SALE_TOKEN,
  VAULT_ID,
} from "../../../../core/test/fixtures/modules/sponsor/fixtures.ts";

/**
 * T-016: the sponsor route's chain reads over a Core API client: the sale's
 * types, each reward round's vault and presale, and the simulation verdict.
 */

const UPGRADED_PACKAGE = `0x${"57".repeat(32)}`;
const id = (byte: string) => `0x${byte.repeat(32)}`;
const VAULT_PACKAGE = id("5b");
const PAIR = `<${SALE_TOKEN}, ${QUOTE}>`;
const shared = {
  $kind: "Shared",
  Shared: { initialSharedVersion: "7" },
} as const;

type FixtureObject = {
  type: string;
  content?: Uint8Array;
  owner?: SuiClientTypes.ObjectOwner;
};

function roundContent(roundId: string, vaultId: string): Uint8Array {
  return roundBcs
    .serialize({
      id: { id: { bytes: roundId } },
      vault_id: vaultId,
      number: 1n,
      claim_deadline_at_ms: 1_800_000_000_000n,
      root: "ab".repeat(32),
      leaf_count: 3n,
      claimed_bitmap: [0n],
      meme: 700n,
      quote: 90n,
      treasury: id("5a"),
      gas_reserve: null,
    })
    .toBytes();
}

function vaultContent(vaultId: string, presaleId: string): Uint8Array {
  const terms: VaultTerms = {
    origin: presaleId,
    packageWitness: `${PRESALE_PACKAGE}::blast_presale_package::PackageWitness`,
    feeSplit: { routes: [{ destination: { kind: "HolderRewards" }, bps: 10000n }] },
    protocolMemeBps: 0n,
    protocolQuoteBps: 0n,
    partnerId: null,
    residuals: "Owner",
  };
  const delayed = { parent: vaultId, key: null, delay_ms: 0n, pending: null };
  return vaultBcs.serialize({
    id: { id: { bytes: vaultId } },
    terms,
    venue: `${id("5c")}::bluefin::Witness`,
    pool_id: id("59"),
    fee_split: { ...delayed, value: terms.feeSplit },
    protocol_bps: { ...delayed, value: { meme_bps: 0n, quote_bps: 0n } },
    protocol: { packageWitness: `${VAULT_PACKAGE}::blast_vault_package::PackageWitness`, origin: vaultId, partnerId: null, meme: 0n, quote: 0n, sui: 0n },
    owner_meme: 0n,
    owner_quote: 0n,
    auto_lp_meme: 0n,
    auto_lp_quote: 0n,
    rewards_meme: 0n,
    rewards_quote: 0n,
    burn_quote: 0n,
    next_round: 2n,
    last_checkpoint: null,
    round_publication: delayed,
  }).toBytes();
}

/** An in-memory Core API: objects by ID (missing ones are `ObjectError`s), a gas price, a scripted simulation. */
function fixtureClient(
  objects: Record<string, FixtureObject>,
  simulation?: SuiClientTypes.SimulateTransactionResult<{ effects: true }>,
) {
  const calls = { simulated: [] as Uint8Array[] };
  const core = {
    async getObjects({ objectIds }: { objectIds: string[] }) {
      return {
        objects: objectIds.map((objectId) => {
          const object = objects[objectId];
          if (!object)
            return new ObjectError(
              "notExists",
              `Object ${objectId} not found`,
              { reason: "notFound", objectId },
            );
          return {
            objectId,
            version: "9",
            digest: "x",
            owner: object.owner ?? shared,
            type: object.type,
            content: object.content ?? new Uint8Array(),
          };
        }),
      };
    },
    async getCurrentSystemState() {
      return { systemState: { referenceGasPrice: "750", epoch: "900" } };
    },
    async simulateTransaction({ transaction }: { transaction: Uint8Array }) {
      calls.simulated.push(transaction);
      if (!simulation) throw new Error("no simulation scripted");
      return simulation;
    },
  };
  return { calls, client: { core } as unknown as ClientWithCoreApi };
}

const identity = {
  presale: { packageId: UPGRADED_PACKAGE, originalPackageId: PRESALE_PACKAGE, vault: { originalPackageId: VAULT_PACKAGE } },
} as unknown as PresaleRuntimeIdentity;

test("presaleTypes reads the sale's SaleToken and Quote from a presale of the deployment's original package", async () => {
  const { client } = fixtureClient({
    [PRESALE_ID]: { type: `${PRESALE_PACKAGE}::blast_presale::Presale${PAIR}` },
    [id("60")]: { type: `${UPGRADED_PACKAGE}::blast_presale::Presale${PAIR}` },
    [id("61")]: { type: `${VAULT_PACKAGE}::vault::Vault${PAIR}` },
    [id("62")]: {
      type: `${PRESALE_PACKAGE}::blast_presale::Presale${PAIR}`,
      owner: { $kind: "AddressOwner", AddressOwner: id("a1") },
    },
  });
  const chain = createSponsorChain({ client, identity });
  assert.deepEqual(await chain.presaleTypes(PRESALE_ID), {
    saleToken: SALE_TOKEN,
    quote: QUOTE,
  });
  for (const other of [id("60"), id("61"), id("62"), OTHER_PRESALE_ID]) {
    assert.equal(await chain.presaleTypes(other), null, other);
  }
});

test("rewardRounds resolves each round's vault and that vault's presale, leaving out what is not of the deployment", async () => {
  const foreignRound = id("70");
  const missingVaultRound = id("71");
  const { client } = fixtureClient({
    [ROUND_ID]: {
      type: `${VAULT_PACKAGE}::holder_rewards::Round${PAIR}`,
      content: roundContent(ROUND_ID, VAULT_ID),
    },
    [VAULT_ID]: {
      type: `${VAULT_PACKAGE}::vault::Vault${PAIR}`,
      content: vaultContent(VAULT_ID, PRESALE_ID),
    },
    [foreignRound]: {
      type: `${id("99")}::holder_rewards::Round${PAIR}`,
      content: roundContent(foreignRound, VAULT_ID),
    },
    [missingVaultRound]: {
      type: `${VAULT_PACKAGE}::holder_rewards::Round${PAIR}`,
      content: roundContent(missingVaultRound, id("72")),
    },
  });
  const chain = createSponsorChain({ client, identity });
  assert.deepEqual(
    await chain.rewardRounds([
      ROUND_ID,
      foreignRound,
      missingVaultRound,
      id("73"),
    ]),
    [{ roundId: ROUND_ID, vaultId: VAULT_ID, vaultPresaleId: PRESALE_ID }],
  );
  assert.deepEqual(await chain.rewardRounds([]), []);
});

function effects(
  status: SuiClientTypes.ExecutionStatus,
): SuiClientTypes.SimulateTransactionResult<{ effects: true }> {
  const transaction = {
    effects: {
      status,
      gasUsed: {
        computationCost: "1000",
        storageCost: "2000",
        storageRebate: "500",
        nonRefundableStorageFee: "0",
      },
    },
  } as unknown as SuiClientTypes.Transaction<{ effects: true }>;
  return status.success
    ? {
        $kind: "Transaction",
        Transaction: transaction,
        commandResults: undefined,
        gasPaymentMocked: false,
      }
    : {
        $kind: "FailedTransaction",
        FailedTransaction: transaction,
        commandResults: undefined,
        gasPaymentMocked: false,
      };
}

test("simulationOutcome maps success, presale and plain aborts, insufficient gas and other failures", () => {
  const gasUsed = { computationCost: 1_000n, storageCost: 2_000n, storageRebate: 500n };
  assert.deepEqual(simulationOutcome(effects({ success: true, error: null })), {
    status: "success",
    gasUsed,
  });
  const abort = (MoveAbort: SuiClientTypes.MoveAbort) =>
    simulationOutcome(
      effects({
        success: false,
        error: {
          $kind: "MoveAbort",
          message: "aborted",
          MoveAbort,
        } as SuiClientTypes.ExecutionError,
      }),
    );
  assert.deepEqual(
    abort({
      abortCode: "9223372449171701785",
      location: { package: "0x50", module: "blast_presale" },
      cleverError: { errorCode: 25 },
    }),
    {
      status: "failure",
      gasUsed,
      failure: {
        kind: "move_abort",
        packageId: `0x${"0".repeat(62)}50`,
        module: "blast_presale",
        code: 25,
      },
    },
  );
  assert.deepEqual(
    abort({
      abortCode: "3",
      location: { package: PRESALE_PACKAGE, module: "bps" },
    }),
    {
      status: "failure",
      gasUsed,
      failure: {
        kind: "move_abort",
        packageId: PRESALE_PACKAGE,
        module: "bps",
        code: 3,
      },
    },
  );
  assert.deepEqual(abort({ abortCode: "18446744073709551615" }), {
    status: "failure",
    gasUsed,
    failure: { kind: "move_abort", packageId: null, module: null, code: null },
  });
  assert.deepEqual(
    simulationOutcome(
      effects({
        success: false,
        error: {
          $kind: "Unknown",
          message: "InsufficientGas",
          Unknown: null,
        } as SuiClientTypes.ExecutionError,
      }),
    ),
    { status: "failure", gasUsed, failure: { kind: "insufficient_gas" } },
  );
  assert.deepEqual(
    simulationOutcome(
      effects({
        success: false,
        error: {
          $kind: "CommandArgumentError",
          message: "bad argument",
          CommandArgumentError: { argument: 0, name: "TypeMismatch" },
        } as SuiClientTypes.ExecutionError,
      }),
    ),
    {
      status: "failure",
      gasUsed,
      failure: { kind: "other", label: "CommandArgumentError" },
    },
  );
});

test("the adapter simulates the bytes it is given and reads the reference gas price and epoch", async () => {
  const { client, calls } = fixtureClient(
    {},
    effects({ success: true, error: null }),
  );
  const chain = createSponsorChain({ client, identity });
  const bytes = Uint8Array.from([1, 2, 3]);
  assert.equal((await chain.simulate(bytes)).status, "success");
  assert.deepEqual(calls.simulated, [bytes]);
  assert.deepEqual(await chain.gasContext(), { price: 750n, epoch: 900n });
});
