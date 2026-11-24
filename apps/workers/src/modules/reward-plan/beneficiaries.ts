import { setTimeout as sleep } from "node:timers/promises";
import type { Pool } from "pg";
import { z } from "zod";
import { ObjectError, type ClientWithCoreApi } from "@mysten/sui/client";
import type { SuiGraphQLClient } from "@mysten/sui/graphql";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import type { Provider } from "#workers/modules/worker-runtime/provider.ts";
import { manifestReader } from "./manifest-store.ts";
import { PAGE_SIZE } from "./plan.ts";

/** What Sui proves about one address: an object (forever), or no object up to `provenThrough`. */
export type AddressIdentity = Readonly<{ address: string; kind: "object" | "account"; provenThrough: bigint }>;

/** Answers every address for a round whose cut is `cut`, or throws: doubt is never an account. */
export type CheckIdentities = (addresses: readonly string[], cut: bigint) => Promise<AddressIdentity[]>;


/** Mainnet's genesis checkpoint digest, as GraphQL `chainIdentifier` reports it. */
export const MAINNET_CHAIN_IDENTIFIER = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";

/**
 * The public GraphQL service answers at most 21 lookups per request (25 return errors plus partial
 * data). Each address takes two: its object versions and the transactions that touched it as an object.
 */
const GRAPHQL_BATCH = 10;
/** The gRPC node answers at most 50 objects per batch. */
const GRPC_BATCH = 50;

const versionsSchema = z.object({ nodes: z.array(z.object({ version: z.union([z.number(), z.string()]) })).max(1) });
const touchesSchema = z.object({ nodes: z.array(z.object({ digest: z.string() })).max(1) });
const sequenceSchema = z.object({ sequenceNumber: z.union([z.number().int().nonnegative(), z.string().regex(/^[0-9]+$/)]) });
const headSchema = z.object({
  chainIdentifier: z.string(),
  checkpoint: sequenceSchema,
  serviceConfig: z.object({
    objects: z.object({ first: sequenceSchema.nullable() }),
    transactions: z.object({ first: sequenceSchema.nullable() }),
  }),
});

function identityQuery(count: number): string {
  const aliases = Array.from({ length: count }, (_, index) => `a${index}`);
  return `query addressIdentities(${aliases.map((alias) => `$${alias}: SuiAddress!`).join(", ")}) {
  chainIdentifier
  checkpoint { sequenceNumber }
  serviceConfig {
    objects: availableRange(type: "Query", field: "objectVersions") { first { sequenceNumber } }
    transactions: availableRange(type: "Query", field: "transactions", filters: ["affectedObject"]) { first { sequenceNumber } }
  }
  ${aliases.map((alias) => `${alias}: objectVersions(address: $${alias}, first: 1) { nodes { version } }
  t${alias}: transactions(first: 1, filter: { affectedObject: $${alias} }) { nodes { digest } }`).join("\n  ")}
}`;
}

/** GraphQL answered at a checkpoint below the cut. It trails the fullnode by a few checkpoints, so this is worth asking again. */
class BelowCut extends Error {}

/** How long to keep asking while GraphQL is below the cut: about 10 s by default, a few dozen checkpoints. */
export type Patience = Readonly<{ attempts: number; waitMs: number }>;
const PATIENCE: Patience = { attempts: 10, waitMs: 1000 };

/** The checkpoint a lookup answered at, or throws unless it is mainnet, at or above the cut, with both histories from genesis. */
function provenCheckpoint(data: unknown, cut: bigint): bigint {
  const head = headSchema.parse(data);
  if (head.chainIdentifier !== MAINNET_CHAIN_IDENTIFIER) throw new Error(`Identity lookup reached chain ${head.chainIdentifier}, not mainnet.`);
  for (const history of [head.serviceConfig.objects.first, head.serviceConfig.transactions.first]) {
    if (!history || BigInt(history.sequenceNumber) !== 0n) throw new Error("Identity lookup has no object history from genesis; an empty answer proves nothing.");
  }
  const checkpoint = BigInt(head.checkpoint.sequenceNumber);
  if (checkpoint < cut) throw new BelowCut(`Identity lookup is at checkpoint ${checkpoint}, below the round cut ${cut}.`);
  return checkpoint;
}

function batches<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

export class ObjectBeneficiary extends Error {
  override readonly name = "ObjectBeneficiary";
  readonly addresses: readonly string[];

  constructor(addresses: readonly string[]) {
    super(`Reward leaf beneficiary is an object, not an account: ${addresses.join(",")}.`);
    this.addresses = addresses;
  }
}

/**
 * A holder-reward claim pays its leaf by coin transfer, so a coin sent to an object's address (a
 * pool, a vesting schedule, a vault) is stranded and the claimed leaf never returns to the vault
 * (contracts `holder_rewards`). Objects and accounts share one address space, and an account
 * address never names an object.
 *
 * GraphQL keeps every object version since genesis, so any version means the address was an object
 * (live, deleted or wrapped): an object forever. An object that was never top-level (created inside
 * another, or unwrapped only to be deleted) has no version, but a transaction touched it as an
 * object, so any such transaction means an object too. Neither means no object had this ID up to the
 * checkpoint GraphQL answered at, read in the same request. That holds only while the service keeps
 * both histories from genesis, so each request also reads where they start and throws unless both
 * start at checkpoint 0. gRPC alone cannot tell a wallet from a deleted or wrapped object; it stays
 * as a cross-check that a live object is never called empty. Any error, null field or other chain
 * throws. GraphQL trails the fullnode by a few checkpoints, so an answer below the cut is asked again
 * for a few seconds (`patience`) before it throws.
 */
export function chainIdentityChecker(graphql: SuiGraphQLClient, grpc: ClientWithCoreApi, provider: Provider, patience: Patience = PATIENCE): CheckIdentities {
  /** One batch's data and the checkpoint it is proven at, asking again while GraphQL trails the cut. */
  const lookup = async (batch: readonly string[], cut: bigint) => {
    const variables = Object.fromEntries(batch.map((address, index) => [`a${index}`, address]));
    for (let attempt = 1; ; attempt++) {
      const { data, errors } = await provider((signal) => graphql.query({ query: identityQuery(batch.length), variables, signal }));
      if (errors?.length) throw new AggregateError(errors.map((error) => new Error(error.message)), "Identity lookup returned GraphQL errors; holder identities are unknown.");
      try {
        return { data: data as Record<string, unknown>, checkpoint: provenCheckpoint(data, cut) };
      } catch (error) {
        if (!(error instanceof BelowCut) || attempt >= patience.attempts) throw error;
      }
      await sleep(patience.waitMs);
    }
  };
  return async (input, cut) => {
    const addresses = [...new Set(input)];
    for (const address of addresses) {
      if (!isValidSuiAddress(address) || normalizeSuiAddress(address) !== address) throw new Error(`Identity check needs a canonical address: ${address}.`);
    }
    const answers: AddressIdentity[] = [];

    for (const batch of batches(addresses, GRAPHQL_BATCH)) {
      const { data, checkpoint } = await lookup(batch, cut);
      batch.forEach((address, index) => {
        const versions = versionsSchema.parse(data[`a${index}`]);
        const touches = touchesSchema.parse(data[`ta${index}`]);
        answers.push({ address, kind: versions.nodes.length || touches.nodes.length ? "object" : "account", provenThrough: checkpoint });
      });
    }

    const accounts = answers.filter((answer) => answer.kind === "account").map((answer) => answer.address);
    for (const batch of batches(accounts, GRPC_BATCH)) {
      const { objects } = await provider((signal) => grpc.core.getObjects({ objectIds: batch, signal }));
      if (objects.length !== batch.length) throw new Error("Object lookup answered a different number of addresses.");
      objects.forEach((result, index) => {
        if (result instanceof ObjectError && result.reason === "notFound") return;
        if (result instanceof Error) throw new Error("Object lookup failed; holder identities are unknown.", { cause: result });
        throw new Error(`GraphQL found no versions for live object ${batch[index]}; holder identities are unknown.`);
      });
    }

    return answers;
  };
}

/** One answer for every distinct address, or throws: a missing answer is never an account. */
export async function answerEvery(check: CheckIdentities, addresses: readonly string[], cut: bigint): Promise<AddressIdentity[]> {
  const asked = new Set(addresses);
  if (!asked.size) return [];
  const answers = await check([...asked], cut);
  const answered = new Set(answers.map((answer) => answer.address));
  if (answers.length !== asked.size || answered.size !== asked.size || [...asked].some((address) => !answered.has(address))) {
    throw new Error("Identity check answered different addresses.");
  }
  return answers;
}

/** The addresses among `addresses` that are objects, checked for a round whose cut is `cut`. */
export async function objectAddresses(check: CheckIdentities, addresses: readonly string[], cut: bigint): Promise<Set<string>> {
  const answers = await answerEvery(check, addresses, cut);
  return new Set(answers.filter((answer) => answer.kind === "object").map((answer) => answer.address));
}

/**
 * The leaf checker: refuses a plan whose manifest pays any object, before its round is scheduled or
 * published on chain. Read-only: it saves no answer.
 */
export async function assertAccountLeaves(pool: Pool, planId: string, leafCount: number, cut: bigint, check: CheckIdentities): Promise<void> {
  const store = manifestReader(pool, planId);

  for (let offset = 0; offset < leafCount; offset += PAGE_SIZE) {
    const count = Math.min(PAGE_SIZE, leafCount - offset);
    const leaves = await store.readAllocations(offset, count);
    if (leaves.length !== count) {
      throw new Error("Reward allocation page is incomplete.");
    }

    const objects = await objectAddresses(check, leaves.map((leaf) => leaf.beneficiary), cut);
    if (objects.size) {
      throw new ObjectBeneficiary([...objects].sort());
    }
  }
}
