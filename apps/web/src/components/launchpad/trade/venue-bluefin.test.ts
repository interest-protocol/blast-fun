import assert from "node:assert/strict";
import test from "node:test";

import { defineBlastDeployment, evaluateProtocolAccess, observeDeploymentRuntime } from "@interest-protocol/blast-sdk/deployments";
import { BluefinVenueError } from "@interest-protocol/blast-sdk/migrators";
import { SimulationError, type ClientWithCoreApi } from "@mysten/sui/client";
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";

import { fixtureWalletSigner } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import type { EnabledAccess } from "../transaction/preflight.ts";
import {
  BluefinQuoteRefused,
  BluefinQuoteUnavailable,
  buildBluefinTrade,
  quoteBluefinTrade,
  simulatedBluefinQuoteTransport,
  type BluefinRecord,
} from "./venue-bluefin.ts";
import { BLUEFIN_LAUNCH_ID, BLUEFIN_MIGRATION_DIGEST, BLUEFIN_POOL_ID, createVenueFixtureChain, VENUE_FIXTURE_MANIFEST, type VenueFixtureChain } from "../../../../test/fixtures/launchpad/trade/venue-fixtures.ts";
import { readVenueRoute } from "./venue-route.ts";

const deployment = defineBlastDeployment(VENUE_FIXTURE_MANIFEST);
const SENDER = fixtureWalletSigner().address;
const BALANCES = { quote: 100_000_000_000n, meme: 0n };
const NOW = 1_790_000_000_000;

async function setup(fixture: VenueFixtureChain = createVenueFixtureChain()) {
  const access = evaluateProtocolAccess({ manifest: deployment, mode: "non-production", runtime: await observeDeploymentRuntime(fixture.client, deployment) });
  assert.equal(access.signing, "enabled");
  const read = await readVenueRoute(fixture.client, deployment, { launchId: BLUEFIN_LAUNCH_ID, migrationDigest: BLUEFIN_MIGRATION_DIGEST, poolKey: null }, NOW);
  if (read.status !== "ok" || read.recorded.venue !== "bluefin") throw new Error("no Bluefin route");
  return { fixture, access: access as EnabledAccess, record: read.recorded.bluefin as BluefinRecord };
}

/** The `pool::swap` arguments of a transaction the node simulated. */
function swapArguments(bytes: Uint8Array) {
  const data = Transaction.from(bytes).getData();
  const call = data.commands.find((command) => command.MoveCall?.module === "pool" && command.MoveCall.function === "swap")!.MoveCall!;
  const pure = (index: number) => fromBase64(data.inputs[(call.arguments[index] as { Input: number }).Input]!.Pure!.bytes);
  return { target: `${normalizeSuiAddress(call.package)}::pool::swap`, amount: bcs.u64().parse(pure(7)), limit: bcs.u64().parse(pure(8)) };
}

test("the Bluefin quote transport asks Sui for the SDK-built exact-input swap and answers with the pool's own AssetSwap", async () => {
  const { fixture, access, record } = await setup();
  const transport = simulatedBluefinQuoteTransport({ client: fixture.client, access, pool: record.pool, sender: SENDER, balances: BALANCES, now: () => NOW });
  const quote = await transport({ route: record.route, a2b: false, byAmountIn: true, amount: 10_000_000_000n });
  assert.deepEqual(
    { ...quote, afterSqrtPrice: typeof quote.afterSqrtPrice },
    {
      poolId: BLUEFIN_POOL_ID,
      a2b: false,
      byAmountIn: true,
      amountIn: 10_000_000_000n,
      amountOut: 181_108_577_044n,
      feeAmount: 30_000_000n,
      afterSqrtPrice: "bigint",
      isExceed: false,
      quotedAtMs: BigInt(NOW),
    },
  );
  // One simulation of the SDK's own Bluefin swap, asking for one atom at least.
  assert.equal(fixture.calls.simulate, 1);
  assert.deepEqual(swapArguments(fixture.simulated[0]!), {
    target: `${normalizeSuiAddress(VENUE_FIXTURE_MANIFEST.packages.bluefinSpot.packageId)}::pool::swap`,
    amount: "10000000000",
    limit: "1",
  });
  assert.equal(fixture.calls.execute, 0);
});

test("a pool that cannot fill the swap is a refusal and never retried; a node that cannot answer is retried once, then unavailable", async () => {
  const refused = await setup();
  // The pool leaves the node after the route was read, so Sui rejects the probe: the pool cannot fill this swap.
  refused.fixture.state.bluefinPoolObject = "absent";
  const buy = { side: "buy" as const, amountIn: 1_000_000_000n, slippageBps: 50n, sender: SENDER, balances: BALANCES };
  const transport = simulatedBluefinQuoteTransport({ client: refused.fixture.client, access: refused.access, pool: refused.record.pool, sender: SENDER, balances: BALANCES });
  await assert.rejects(quoteBluefinTrade({ ...buy, record: refused.record, transport }), (error: unknown) => {
    assert.ok(error instanceof BluefinQuoteRefused);
    assert.doesNotMatch((error as Error).message, /MoveAbort|abort code/);
    return true;
  });
  assert.equal(refused.fixture.calls.simulate, 1);

  const out = await setup(createVenueFixtureChain({ bluefinProvider: "unavailable" }));
  const down = simulatedBluefinQuoteTransport({ client: out.fixture.client, access: out.access, pool: out.record.pool, sender: SENDER, balances: BALANCES });
  await assert.rejects(quoteBluefinTrade({ ...buy, record: out.record, transport: down }), BluefinQuoteUnavailable);
  assert.equal(out.fixture.calls.simulate, 2);
});

test("the SDK's Bluefin builder refuses a quote once it has expired, so an expired quote can never be signed", async () => {
  const { fixture, access, record } = await setup();
  const transport = simulatedBluefinQuoteTransport({ client: fixture.client, access, pool: record.pool, sender: SENDER, balances: BALANCES, now: () => NOW });
  const quote = await quoteBluefinTrade({ record, side: "buy", amountIn: 1_000_000_000n, slippageBps: 100n, sender: SENDER, balances: BALANCES, transport });
  assert.equal(quote.expiresAtMs, BigInt(NOW) + 20_000n);
  assert.ok(buildBluefinTrade(access, quote, NOW + 19_999));
  assert.throws(() => buildBluefinTrade(access, quote, NOW + 20_000), (error: unknown) => error instanceof BluefinVenueError && error.code === "expired-quote");
});

test("on a node whose client estimates gas by simulating, a pool that cannot fill the probe is still a refusal, never retried", async () => {
  const refused = await setup(createVenueFixtureChain({ gasBudget: "estimated" }));
  refused.fixture.state.bluefinPoolObject = "absent";
  let calls = 0;
  const probe = simulatedBluefinQuoteTransport({ client: refused.fixture.client, access: refused.access, pool: refused.record.pool, sender: SENDER, balances: BALANCES });
  const counted: typeof probe = (request) => ((calls += 1), probe(request));
  await assert.rejects(
    quoteBluefinTrade({ side: "buy", amountIn: 1_000_000_000n, slippageBps: 50n, sender: SENDER, balances: BALANCES, record: refused.record, transport: counted }),
    (error: unknown) => {
      assert.ok(error instanceof BluefinQuoteRefused, String(error));
      assert.doesNotMatch((error as Error).message, /MoveAbort|abort code|resolution failed/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("a build that fails without an execution error is a transport failure: retried once, then the Bluefin quote provider is unavailable", async () => {
  const { fixture, access, record } = await setup();
  // The gRPC client wraps a dropped connection while building (gas estimation) as a SimulationError without an execution error.
  const dropped: ClientWithCoreApi = {
    core: {
      ...fixture.client.core,
      resolveTransactionPlugin: () => async () => {
        throw new SimulationError("14 UNAVAILABLE: Connection dropped", { cause: new Error("14 UNAVAILABLE") });
      },
    },
  } as unknown as ClientWithCoreApi;
  let calls = 0;
  const probe = simulatedBluefinQuoteTransport({ client: dropped, access, pool: record.pool, sender: SENDER, balances: BALANCES });
  const counted: typeof probe = (request) => ((calls += 1), probe(request));
  await assert.rejects(
    quoteBluefinTrade({ side: "buy", amountIn: 1_000_000_000n, slippageBps: 50n, sender: SENDER, balances: BALANCES, record, transport: counted }),
    (error: unknown) => {
      assert.ok(error instanceof BluefinQuoteUnavailable, String(error));
      assert.equal((error as Error).message, "The Bluefin quote provider did not answer: The external service could not complete this request. Retry shortly. Code: service_unavailable.");
      assert.doesNotMatch((error as Error).message, /Connection dropped|14 UNAVAILABLE/);
      return true;
    },
  );
  assert.equal(calls, 2);
  assert.equal(fixture.calls.simulate, 0);
});
