import assert from "node:assert/strict";
import test from "node:test";
import { ObjectError, type ClientWithCoreApi } from "@mysten/sui/client";
import type { SuiGraphQLClient } from "@mysten/sui/graphql";
import { chainIdentityChecker, MAINNET_CHAIN_IDENTIFIER, objectAddresses } from "./beneficiaries.ts";
import { id } from "../../../test/fixtures/modules/vault-rewards/rewards.ts";

type Reply = { data?: Record<string, unknown>; errors?: { message: string }[] };

/**
 * GraphQL like the public service: at most 20 lookups per request, two per address. Alias `aN`
 * answers the object versions of the address in variable `aN`, alias `taN` the transactions that
 * touched it as an object (`touched`). Plus the chain, the checkpoint it read at and where object
 * (`history`) and transaction (`touchHistory`) history start.
 */
type Head = { chain?: string; checkpoint?: number; history?: number | null; touchHistory?: number | null; touched?: ReadonlySet<string> };
const first = (start: number | null | undefined) => start === null ? null : { sequenceNumber: start ?? 0 };

function graphql(objects: ReadonlySet<string>, head: Head = {}, edit: (reply: Reply) => Reply = (reply) => reply): SuiGraphQLClient {
  return {
    async query({ variables }: { variables: Record<string, string> }) {
      const aliases = Object.entries(variables);
      if (aliases.length * 2 > 20) throw new Error("request above the lookup limit");
      const data: Record<string, unknown> = {
        chainIdentifier: head.chain ?? MAINNET_CHAIN_IDENTIFIER,
        checkpoint: { sequenceNumber: head.checkpoint ?? 500 },
        serviceConfig: { objects: { first: first(head.history) }, transactions: { first: first(head.touchHistory) } },
      };
      for (const [alias, address] of aliases) {
        data[alias] = { nodes: objects.has(address) ? [{ version: 7 }] : [] };
        data[`t${alias}`] = { nodes: head.touched?.has(address) ? [{ digest: "D5RqYF5aup8zCH63yi8ekPFHJx29XQwCeC4jpt3ccq4B" }] : [] };
      }
      return edit({ data });
    },
  } as unknown as SuiGraphQLClient;
}

/** A gRPC node that knows the given live objects and answers notFound for everything else. */
function grpc(live: ReadonlySet<string> = new Set()): ClientWithCoreApi {
  const getObjects = async ({ objectIds }: { objectIds: string[] }) => ({
    objects: objectIds.map((objectId) => live.has(objectId) ? { objectId } : new ObjectError("notFound", "notFound", { reason: "notFound", objectId })),
  });
  return { core: { getObjects } } as unknown as ClientWithCoreApi;
}

const provider = <R>(call: (signal: AbortSignal) => Promise<R>) => call(new AbortController().signal);
const quick = { attempts: 3, waitMs: 0 };
const pool = id("0xb1"), deleted = id("0xb2"), wallet = id("0xa1");

test("any version makes an object forever, and no versions is an account proven through GraphQL's checkpoint", async () => {
  const wallets = Array.from({ length: 23 }, (_, index) => id(`0xa${index + 10}`));
  const check = chainIdentityChecker(graphql(new Set([pool, deleted])), grpc(new Set([pool])), provider);

  const answers = await check([pool, ...wallets, deleted, wallet, wallet], 400n);

  assert.equal(answers.length, 26, "every distinct address answered across three requests");
  assert.deepEqual(answers.find((answer) => answer.address === pool), { address: pool, kind: "object", provenThrough: 500n });
  assert.deepEqual(answers.find((answer) => answer.address === deleted), { address: deleted, kind: "object", provenThrough: 500n }, "a deleted object gRPC cannot see");
  assert.deepEqual(answers.find((answer) => answer.address === wallet), { address: wallet, kind: "account", provenThrough: 500n });
});

test("errors with partial data, a null lookup, another chain, a checkpoint below the cut, pruned history or a short answer give no answer", async () => {
  const check = (client: SuiGraphQLClient) => chainIdentityChecker(client, grpc(), provider, quick)([wallet, pool], 400n);

  await assert.rejects(check(graphql(new Set([pool]), {}, (reply) => ({ ...reply, errors: [{ message: "too many lookups" }] }))), /GraphQL errors/);
  await assert.rejects(check(graphql(new Set([pool]), {}, (reply) => ({ data: { ...reply.data, a0: null } }))));
  await assert.rejects(check(graphql(new Set([pool]), {}, (reply) => ({ data: { ...reply.data, ta0: null } }))));
  await assert.rejects(check(graphql(new Set([pool]), { chain: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6T" })), /not mainnet/);
  await assert.rejects(check(graphql(new Set([pool]), { checkpoint: 399 })), /below the round cut 400/);
  await assert.rejects(check(graphql(new Set([pool]), { history: 100 })), /no object history from genesis/);
  await assert.rejects(check(graphql(new Set([pool]), { history: null })), /no object history from genesis/);
  await assert.rejects(check(graphql(new Set([pool]), { touchHistory: 100 })), /no object history from genesis/);
  await assert.rejects(objectAddresses(async () => [], [wallet], 400n), /answered different addresses/);
});

test("GraphQL trailing the cut is asked again until it catches up", async () => {
  let reads = 0;
  const catching = graphql(new Set([pool]), {}, (reply) => ({ data: { ...reply.data, checkpoint: { sequenceNumber: 398 + reads++ } } }));
  const answers = await chainIdentityChecker(catching, grpc(), provider, quick)([wallet, pool], 400n);

  assert.equal(reads, 3);
  assert.deepEqual(answers.map((answer) => answer.provenThrough), [400n, 400n]);
});

test("an object that was never top-level has no version but a transaction, and is an object", async () => {
  const inner = id("0xb3");
  const answers = await chainIdentityChecker(graphql(new Set(), { touched: new Set([inner]) }), grpc(), provider)([inner, wallet], 400n);

  assert.deepEqual(answers.map((answer) => answer.kind), ["object", "account"]);
});

test("a live object GraphQL calls empty is never an account", async () => {
  const check = chainIdentityChecker(graphql(new Set()), grpc(new Set([pool])), provider);

  await assert.rejects(check([wallet, pool], 400n), /no versions for live object/);
});
