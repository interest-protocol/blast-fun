import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import {
  fixtureChainNode,
  SUI_MAINNET_CHAIN_IDENTIFIER,
} from "../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { SENDER } from "../../../../core/test/fixtures/modules/sponsor/fixtures.ts";
import {
  CAP,
  CLOCK,
  DID,
  SPONSOR,
  assertError,
  fixtureChain,
  harness,
  identity,
  MemoryLimiter,
  memoryReservations,
  post,
  sponsorBody,
} from "../../../test/fixtures/modules/sponsor/route-fixtures.ts";
import { createSponsorService } from "./service.ts";

function fixture(allowed = true) {
  const chain = fixtureChain();
  const reservations = memoryReservations();
  const limits = new MemoryLimiter();
  const sponsor = createSponsorService({
    deployment: createPresaleDeploymentGate({
      environment: identity(),
      node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER),
    }),
    wallets: { require: async () => SENDER },
    chain: chain.chain,
    reservations: reservations.store,
    executions: { today: async () => ({ allowed }) },
    limits,
    config: () => ({
      sponsorAddress: SPONSOR,
      maxGasMist: CAP,
      swapTargets: [],
      tradeFee: () => null,
    }),
    clock: () => CLOCK,
  });
  return { sponsor, reservations, limits };
}

async function creation() {
  const tx = new Transaction();
  tx.setSender(SENDER);
  tx.publish({ modules: [], dependencies: [] });
  return {
    caller: { kind: "privy" as const, did: DID },
    sender: SENDER,
    kindBytes: await tx.build({ onlyTransactionKind: true }),
    ip: "203.0.113.7",
  };
}

const SERVER_BUILT = [
  "create",
  "vesting",
  "creator_caps",
  "launch_claim",
] as const;

test("each server-built intent keeps the wallet check, simulation and shared budgets, with no presale ID; the public route refuses it", async () => {
  for (const intent of SERVER_BUILT) {
    const f = fixture();
    const request = { ...(await creation()), intent, presaleId: null };
    const result = await f.sponsor.sponsor(request);
    const data = bcs.TransactionData.parse(
      fromBase64(result.transaction_bytes),
    ).V1!;
    assert.equal(data.sender, SENDER, intent);
    assert.equal(data.gasData.owner, SPONSOR, intent);
    assert.deepEqual(data.gasData.payment, [], intent);
    assert.deepEqual(
      bcs.TransactionKind.serialize(data.kind).toBytes(),
      request.kindBytes,
      intent,
    );
    assert.deepEqual(
      f.reservations.reserved().map((r) => [r.intent, r.presaleId]),
      [[intent, null]],
      intent,
    );
    assert.deepEqual(
      f.limits.calls,
      [
        "presale_sponsor_ip",
        "presale_sponsor_account_daily",
        "presale_sponsor_global",
      ],
      intent,
    );
    await assert.rejects(
      fixture(false).sponsor.sponsor(request),
      { code: "budget_exceeded" },
      intent,
    );
    await assert.rejects(
      fixture().sponsor.sponsor({ ...request, sender: `0x${"ba".repeat(32)}` }),
      { code: "not_embedded_wallet" },
      intent,
    );
    const h = harness();
    await assertError(
      await h.route(post(await sponsorBody({ intent })), testClient()),
      "invalid_request",
    );
    assert.equal(h.reservations.rows.length, 0, intent);
  }
});

test("a wallet session is sponsored for its own address only, budgeted under sui:<address>", async () => {
  const f = fixture();
  const caller = { kind: "wallet", address: SENDER } as const;
  const request = { ...(await creation()), caller, intent: "create" as const, presaleId: null };
  const result = await f.sponsor.sponsor(request);
  const data = bcs.TransactionData.parse(fromBase64(result.transaction_bytes)).V1!;
  assert.equal(data.sender, SENDER);
  assert.equal(data.gasData.owner, SPONSOR);
  assert.deepEqual(f.reservations.reserved().map((r) => r.privyDid), [`sui:${SENDER}`]);
  assert.ok(f.limits.subjects.some((subject) => subject.accountId === `sui:${SENDER}`));
  await assert.rejects(
    fixture().sponsor.sponsor({ ...request, caller: { kind: "wallet", address: `0x${"ba".repeat(32)}` } }),
    { code: "not_embedded_wallet" },
  );
});

test("public sponsor requests cannot authorize arbitrary creation kinds", async () => {
  const h = harness();
  await assertError(
    await h.route(post(await sponsorBody({ intent: "create" })), testClient()),
    "invalid_request",
  );
  await assertError(
    await h.route(
      post(
        await sponsorBody({
          transaction_kind_bytes: Buffer.from(
            (await creation()).kindBytes,
          ).toString("base64"),
        }),
      ), testClient()
    ),
    "target_not_allowed",
  );
  assert.equal(h.reservations.rows.length, 0);
});
