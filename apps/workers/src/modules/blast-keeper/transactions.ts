import { MIGRATOR_VENUES } from "@blast/core/modules/launchpad-contract/venues.ts";
import { isDeepStrictEqual } from "node:util";

import { launchpadDeployment, migratorsDeployment, presaleDeployment, vaultDeployment, type BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { LaunchpadCalls } from "@interest-protocol/blast-launchpad-sdk/transactions";
import { MigratorCalls } from "@interest-protocol/blast-migrators-sdk/transactions";
import { PresaleCalls, PresaleTransactions } from "@interest-protocol/blast-presale-sdk/transactions";
import { VaultCalls } from "@interest-protocol/blast-vault-sdk/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { z } from "zod";

import { canonicalCoinSchema, objectIdSchema } from "#workers/lib/validation.ts";
import { kares, karesMigration } from "./kares.ts";
import { permittedBluefinFee } from "./bluefin-fee.ts";
import { assertAddressBalanceEnvelope, SignerRefusal } from "../worker-runtime/signer.ts";

const shared = z.object({ objectId: objectIdSchema, initialSharedVersion: z.string().regex(/^[1-9][0-9]*$/) }).strict();
const pair = { memeType: canonicalCoinSchema, quoteType: canonicalCoinSchema };
const sale = { ...pair, object: shared };
const migrate = {
  ...sale,
  venue: z.enum(MIGRATOR_VENUES),
  currency: shared,
  quoteCurrency: shared.optional(),
  creationFeeMist: z.string().regex(/^(0|[1-9][0-9]*)$/).refine((value) => BigInt(value) <= 18446744073709551615n),
};
export const keeperActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("launch-migrate"), ...migrate }).strict(),
  z.object({ kind: z.literal("presale-settle"), ...sale }).strict(),
  z.object({ kind: z.literal("presale-cancel"), ...sale }).strict(),
  z.object({ kind: z.literal("presale-migrate"), ...migrate }).strict(),
  z.object({
    kind: z.literal("kares-migrate"),
    object: z.object({
      objectId: z.literal(kares.object.objectId),
      initialSharedVersion: z.literal(kares.object.initialSharedVersion),
    }).strict(),
    memeType: z.literal(kares.memeType),
    quoteType: z.literal(kares.quoteType),
    settle: z.boolean(),
  }).strict(),
  z.object({ kind: z.literal("presale-vendor-migrate"), ...sale, lpType: canonicalCoinSchema, poolCreation: shared }).strict(),
  z.object({ kind: z.literal("launch-fees"), ...sale, partner: shared.nullable() }).strict(),
  z.object({ kind: z.literal("presale-partner"), ...sale, partner: shared }).strict(),
  z.object({ kind: z.literal("vault-partner"), ...sale, partner: shared }).strict(),
  z.object({ kind: z.literal("vault-fees"), ...sale, currency: shared, pool: shared, venue: z.enum(MIGRATOR_VENUES), settleFeeSplit: z.boolean() }).strict(),
]);
export type KeeperActionIntent = z.infer<typeof keeperActionSchema>;

export function parseKeeperAction(value: unknown): KeeperActionIntent {
  const result = keeperActionSchema.safeParse(value);
  if (!result.success) throw new SignerRefusal("malformed keeper action");
  return result.data;
}

type MigrationIntent = Extract<KeeperActionIntent, { kind: "launch-migrate" | "presale-migrate" }>;
type VaultFeesIntent = Extract<KeeperActionIntent, { kind: "vault-fees" }>;

function addMigration(deployment: BlastDeployment, intent: MigrationIntent, tx: Transaction): void {
  const pair = { memeType: intent.memeType, quoteType: intent.quoteType };
  const migrator = new MigratorCalls(migratorsDeployment(deployment));
  const migration = intent.kind === "launch-migrate"
    ? tx.add(new LaunchpadCalls(launchpadDeployment(deployment)).migrate({ ...pair, launch: intent.object, currency: intent.currency }))
    : tx.add(new PresaleCalls(presaleDeployment(deployment)).migrate({ saleTokenType: intent.memeType, quoteType: intent.quoteType, presale: intent.object }));
  if (intent.venue === "cetus") {
    const cetus = deployment.sharedObjects.cetus;
    if (!cetus) throw new SignerRefusal("unrecorded Cetus venue");
    tx.add(migrator.migrateCetus({ ...pair, migration, cetus }));
    return;
  }
  const config = deployment.sharedObjects.bluefin?.config;
  if (!config || !intent.quoteCurrency) throw new SignerRefusal("unrecorded Bluefin inputs");
  const fee = BigInt(intent.creationFeeMist);
  const creationFee = fee === 0n
    ? tx.moveCall({ target: "0x2::coin::zero", typeArguments: ["0x2::sui::SUI"] })
    : tx.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: ["0x2::sui::SUI"], arguments: [tx.withdrawal({ amount: fee, type: "0x2::sui::SUI", from: "sender" })] });
  tx.add(migrator.migrateBluefin({ ...pair, migration, currency: intent.currency, quoteCurrency: intent.quoteCurrency, bluefinConfig: config, creationFee }));
}

function addVaultFees(deployment: BlastDeployment, intent: VaultFeesIntent, tx: Transaction): void {
  const migrator = new MigratorCalls(migratorsDeployment(deployment));
  const options = { memeType: intent.memeType, quoteType: intent.quoteType, vault: intent.object, currency: intent.currency, pool: intent.pool };
  if (intent.venue === "cetus") {
    const cetus = deployment.sharedObjects.cetus;
    if (!cetus) throw new SignerRefusal("unrecorded Cetus venue");
    tx.add(intent.settleFeeSplit
      ? migrator.settleAndApplyCetusFeeSplit({ ...options, cetus })
      : migrator.collectCetusFees({ ...options, cetus }));
    return;
  }
  const config = deployment.sharedObjects.bluefin?.config;
  if (!config) throw new SignerRefusal("unrecorded Bluefin venue");
  tx.add(intent.settleFeeSplit
    ? migrator.settleAndApplyBluefinFeeSplit({ ...options, bluefinConfig: config })
    : migrator.collectBluefinFees({ ...options, bluefinConfig: config }));
}

/** Only permissionless SDK calls; none can transfer an operator-owned asset or sign in. */
export function keeperTransaction(deployment: BlastDeployment, raw: KeeperActionIntent, tx = new Transaction()): Transaction {
  const intent = parseKeeperAction(raw);
  const pair = { memeType: intent.memeType, quoteType: intent.quoteType };
  const launch = new LaunchpadCalls(launchpadDeployment(deployment));
  const presale = new PresaleCalls(presaleDeployment(deployment));
  const sale = { saleTokenType: intent.memeType, quoteType: intent.quoteType, presale: intent.object };
  switch (intent.kind) {
    case "presale-settle": tx.add(presale.settle(sale)); break;
    case "presale-cancel": tx.add(presale.cancelUnlaunched(sale)); break;
    case "launch-fees":
      tx.add(intent.partner
        ? launch.claimProtocolFeesWithPartner({ ...pair, launch: intent.object, partner: intent.partner })
        : launch.claimProtocolFees({ ...pair, launch: intent.object }));
      break;
    case "presale-partner": tx.add(presale.payProtocolFeesWithPartner({ ...sale, partner: intent.partner })); break;
    case "vault-partner": tx.add(new VaultCalls(vaultDeployment(deployment)).payProtocolFeesWithPartner({ ...pair, vault: intent.object, partner: intent.partner })); break;
    case "vault-fees": addVaultFees(deployment, intent, tx); break;
    case "kares-migrate": return karesMigration(deployment, intent.settle);
    case "presale-vendor-migrate":
      return new PresaleTransactions(presaleDeployment(deployment)).migrate({
        ...sale, venue: "aftermathDao", lpType: intent.lpType, poolCreation: intent.poolCreation,
      });
    case "launch-migrate":
    case "presale-migrate": addMigration(deployment, intent, tx); break;
  }
  return tx;
}

function assertCreationFees(intents: readonly KeeperActionIntent[], creationFeeCapMist: bigint): void {
  const fees = intents.filter((intent): intent is MigrationIntent => intent.kind === "launch-migrate" || intent.kind === "presale-migrate");
  for (const intent of fees) {
    if (!permittedBluefinFee(BigInt(intent.creationFeeMist), creationFeeCapMist) || (intent.venue !== "bluefin" && intent.creationFeeMist !== "0")) throw new SignerRefusal("creation fee exceeds cap or wrong venue");
  }
  const paying = fees.filter((intent) => BigInt(intent.creationFeeMist) > 0n);
  if (paying.length > 0 && intents.length !== 1) throw new SignerRefusal("creation fee migration must run alone");
}

/** Rebuild the allowlisted SDK transaction instead of trusting target strings from durable JSON. */
export async function assertKeeperActionOnly(
  bytes: Uint8Array,
  address: string,
  intents: readonly KeeperActionIntent[],
  deployment: BlastDeployment,
  gasBudgetMist: bigint,
  creationFeeCapMist = 0n,
): Promise<void> {
  // The Bluefin creation fee is the one withdrawal: `assertCreationFees` bounds it and the rebuild binds its input.
  const actual = assertAddressBalanceEnvelope(bytes, { sender: address, gasBudgetMist, chainIdentifier: deployment.chainIdentifier, withdrawals: "allowed" });
  if (intents.length < 1 || intents.length > 32 || new Set(intents.map((intent) => `${intent.kind}:${intent.object.objectId}`)).size !== intents.length) throw new SignerRefusal("invalid keeper action batch");
  assertCreationFees(intents, creationFeeCapMist);
  let rebuilt = new Transaction();
  for (const intent of intents) {
    if ((intent.kind === "presale-vendor-migrate" || intent.kind === "kares-migrate") && intents.length !== 1) throw new SignerRefusal("vendor migration must run alone");
    rebuilt = keeperTransaction(deployment, intent, rebuilt);
  }
  const expectedBytes = await rebuilt.build({ onlyTransactionKind: true });
  const expected = Transaction.fromKind(expectedBytes).getData();
  if (!isDeepStrictEqual(actual.inputs, expected.inputs) || !isDeepStrictEqual(actual.commands, expected.commands)) throw new SignerRefusal("different keeper calls or inputs");
}
