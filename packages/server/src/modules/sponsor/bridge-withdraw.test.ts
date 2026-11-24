import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Inputs, Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import {
  addSuiBurn,
  forwardHookData,
  SUI_CCTP_V2_MAINNET,
  suiBurnTransaction,
  type SuiBurnParams,
} from "@blast/core/modules/presale/bridge/sui-burn.ts";
import {
  cctpWithout,
  SUI_CCTP_V2_IDENTITY,
} from "../../../../core/test/fixtures/modules/presale/bridge/withdraw-fixtures.ts";
import {
  fixtureChainNode,
  SUI_MAINNET_CHAIN_IDENTIFIER,
} from "../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import {
  COIN_SOURCES,
  kindOf,
  OTHER_WALLET,
  SENDER,
} from "../../../../core/test/fixtures/modules/sponsor/fixtures.ts";
import {
  evaluateBridgeWithdrawPolicy,
  evaluateWithdrawPolicy,
  type SponsorTransactionKind,
} from "@blast/core/modules/sponsor/policy.ts";
import {
  assertError,
  CAP,
  CLOCK,
  DID,
  fixtureChain,
  harness,
  identity,
  MemoryLimiter,
  memoryReservations,
  post,
  SPONSOR,
  sponsorBody,
} from "../../../test/fixtures/modules/sponsor/route-fixtures.ts";
import { createSponsorService } from "./service.ts";
import { expireUnsubmittedBridgeWithdrawal, KeyedSponsorRefusal, type SponsorReservationState } from "./reservations.ts";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";

/**
 * Withdraw to another chain: the sponsor's in-process `bridge_withdraw`
 * intent. The social withdrawal route builds Circle's CCTP V2 burn of the
 * sender's own USDC (`suiBurnTransaction`) and sponsors it here; the policy
 * admits exactly that burn — the coin plumbing, then the three calls with the
 * identity's shared objects, a Forwarding hook, no destination caller,
 * Standard finality — and nothing else. The HTTP route never takes the intent,
 * and a sponsored withdrawal counts toward the presale's daily budget.
 */

const IDS = SUI_CCTP_V2_MAINNET;
const EVM = `0x${"1e".repeat(20)}`;
const SOLANA_OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function params(
  destination: SuiBurnParams["destination"],
  amount = 5_000_000n,
): SuiBurnParams {
  return {
    destination,
    amount,
    mintRecipient:
      destination === "solana"
        ? `0x${"5a".repeat(32)}`
        : `0x${EVM.slice(2).padStart(64, "0")}`,
    maxFee: 60_000n,
    hookData: forwardHookData(
      destination,
      destination === "solana" ? SOLANA_OWNER : EVM,
    ),
  };
}

const allow = (kind: SponsorTransactionKind, sender = SENDER) =>
  evaluateBridgeWithdrawPolicy({ kind, sender, ids: IDS });

function assertRefused(
  kind: SponsorTransactionKind,
  pattern: RegExp,
  label = "",
): void {
  const decision = allow(kind);
  assert.equal(decision.allowed, false, `${label} was allowed`);
  assert.ok(!decision.allowed && decision.code === "target_not_allowed");
  assert.match(!decision.allowed ? decision.reason : "", pattern, label);
}

/** The burn kind for `destination` from the sender's coins as `source` holds them. */
const burnKind = (
  destination: SuiBurnParams["destination"],
  source: (typeof COIN_SOURCES)[number] = "owned coins",
) =>
  kindOf(suiBurnTransaction(IDS, SENDER, params(destination)), {
    source,
    amount: 5_000_000n,
  });

type PureInput = { Pure: { bytes: string } };
/** The kind with the deposit call's `position`-th argument's pure bytes replaced. */
function withDepositPure(
  kind: SponsorTransactionKind,
  position: number,
  bytes: Uint8Array,
): SponsorTransactionKind {
  const copy = structuredClone(kind);
  const { inputs, commands } = copy.ProgrammableTransaction!;
  const deposit = commands.at(-3)!.MoveCall!;
  const argument = deposit.arguments[position] as { Input: number };
  (inputs[argument.Input] as unknown as PureInput).Pure.bytes = toBase64(bytes);
  return copy;
}

test("the policy admits the withdrawal route's burns to every destination, from owned coins, exact coins or the address balance", async () => {
  for (const destination of [
    "base",
    "arbitrum",
    "ethereum",
    "solana",
  ] as const) {
    for (const source of COIN_SOURCES) {
      assert.deepEqual(
        allow(await burnKind(destination, source)),
        { allowed: true },
        `${destination} from ${source}`,
      );
    }
  }
});

test("a burn is never a plain withdraw: the withdraw policy refuses it", async () => {
  const decision = evaluateWithdrawPolicy({
    kind: await burnKind("base"),
    sender: SENDER,
  });
  assert.equal(decision.allowed, false);
});

test("the burn's arguments are pinned: Forwarding hook for the destination, no destination caller, Standard finality, a known domain, a nonzero recipient", async () => {
  const kind = await burnKind("base");
  assertRefused(
    withDepositPure(kind, 1, bcs.u32().serialize(26).toBytes()),
    /destination is not Ethereum, Arbitrum, Solana or Base/,
    "Arc",
  );
  assertRefused(
    withDepositPure(kind, 2, new Uint8Array(32)),
    /mint recipient is not a nonzero address/,
  );
  assertRefused(
    withDepositPure(kind, 3, bcs.Address.serialize(OTHER_WALLET).toBytes()),
    /names a destination caller/,
  );
  assertRefused(
    withDepositPure(kind, 4, new Uint8Array(8)),
    /max fee is not a pure u256/,
  );
  assertRefused(
    withDepositPure(kind, 5, bcs.u32().serialize(1000).toBytes()),
    /finality is not Standard/,
  );
  assertRefused(
    withDepositPure(kind, 6, bcs.vector(bcs.u8()).serialize([]).toBytes()),
    /hook/,
    "no hook (a plain burn Circle never forwards)",
  );
  const notForward = forwardHookData("base", EVM);
  notForward[0] = 0x64;
  assertRefused(
    withDepositPure(
      kind,
      6,
      bcs.vector(bcs.u8()).serialize(Array.from(notForward)).toBytes(),
    ),
    /hook is not the Forwarding Service's/,
  );
  const solanaHook = bcs
    .vector(bcs.u8())
    .serialize(Array.from(forwardHookData("solana", SOLANA_OWNER)))
    .toBytes();
  assertRefused(
    withDepositPure(kind, 6, solanaHook),
    /hook does not fit its destination/,
    "Solana's hook to Base",
  );
  const solana = await burnKind("solana");
  assertRefused(
    withDepositPure(
      solana,
      6,
      bcs
        .vector(bcs.u8())
        .serialize(Array.from(forwardHookData("base", EVM)))
        .toBytes(),
    ),
    /hook does not fit its destination/,
    "an EVM hook to Solana",
  );
});

test("each shared object must be the identity's, at its initial shared version, with the signature's mutability", async () => {
  const kind = await burnKind("arbitrum");
  const sharedInputs = kind.ProgrammableTransaction!.inputs.flatMap(
    (input, index) => (input.Object?.SharedObject ? [index] : []),
  );
  assert.equal(
    sharedInputs.length,
    5,
    "TMM state, handler state, deny list, treasury, MT state",
  );
  for (const index of sharedInputs) {
    for (const change of ["version", "mutable", "id"] as const) {
      const copy = structuredClone(kind);
      const shared =
        copy.ProgrammableTransaction!.inputs[index]!.Object!.SharedObject!;
      if (change === "version")
        shared.initialSharedVersion = String(
          BigInt(shared.initialSharedVersion) + 1n,
        );
      else if (change === "mutable") shared.mutable = !shared.mutable;
      else shared.objectId = normalizeSuiAddress(`0x${"77".repeat(32)}`);
      assertRefused(
        copy,
        /is not the identity's object/,
        `${shared.objectId} ${change}`,
      );
    }
  }
});

test("anything else in the transaction is refused: a transfer, another call, the gas coin, a vector, the wrong packages or types, a burn not last", async () => {
  const transfer = suiBurnTransaction(IDS, SENDER, params("base"));
  const [extra] = transfer.splitCoins(
    transfer.object(
      Inputs.ObjectRef({
        objectId: `0x${"d9".repeat(32)}`,
        version: "3",
        digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      }),
    ),
    [1n],
  );
  transfer.transferObjects([extra!], OTHER_WALLET);
  assertRefused(
    await kindOf(transfer, { amount: 5_000_000n }),
    /TransferObjects|is not/,
  );

  const before = new Transaction();
  before.moveCall({ target: `${IDS.tokenMessengerMinter}::anything::at_all` });
  const coin = before.splitCoins(
    before.object(
      Inputs.ObjectRef({
        objectId: `0x${"d8".repeat(32)}`,
        version: "3",
        digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      }),
    ),
    [5_000_000n],
  )[0]!;
  addSuiBurn(before, IDS, coin, params("base"));
  assertRefused(
    await kindOf(before),
    /anything::at_all is not allowed for intent bridge_withdraw/,
  );

  const gas = new Transaction();
  const [fromGas] = gas.splitCoins(gas.gas, [5_000_000n]);
  addSuiBurn(gas, IDS, fromGas!, params("base"));
  assertRefused(await kindOf(gas), /gas coin/);

  const vector = new Transaction();
  vector.makeMoveVec({ type: "u64", elements: [vector.pure.u64(1n)] });
  const owned = vector.splitCoins(
    vector.object(
      Inputs.ObjectRef({
        objectId: `0x${"d7".repeat(32)}`,
        version: "3",
        digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      }),
    ),
    [5_000_000n],
  )[0]!;
  addSuiBurn(vector, IDS, owned, params("base"));
  assertRefused(await kindOf(vector), /MakeMoveVec is not allowed/);

  // The burn calls of another TokenMessengerMinter or handler, or another coin type.
  for (const [label, ids, pattern] of [
    [
      "another TMM",
      { ...IDS, tokenMessengerMinter: `0x${"e7".repeat(32)}` },
      /is not 0x/,
    ],
    [
      "another handler",
      { ...IDS, stablecoinHandler: `0x${"e8".repeat(32)}` },
      /is not 0x/,
    ],
    [
      "another coin",
      { ...IDS, usdcType: `0x${"e9".repeat(32)}::usdc::USDC` },
      /type is not/,
    ],
  ] as const) {
    assertRefused(
      await kindOf(suiBurnTransaction(ids, SENDER, params("base")), {
        amount: 5_000_000n,
      }),
      pattern,
      label,
    );
  }

  // Nothing but the burn (no coin first), or the burn's calls out of order.
  const bare = new Transaction();
  addSuiBurn(
    bare,
    IDS,
    bare.object(
      Inputs.ObjectRef({
        objectId: `0x${"d6".repeat(32)}`,
        version: "3",
        digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      }),
    ),
    params("base"),
  );
  assertRefused(await kindOf(bare), /the coin, then the three burn calls/);
  const reordered = structuredClone(await burnKind("base"));
  const commands = reordered.ProgrammableTransaction!.commands;
  [commands[commands.length - 1], commands[commands.length - 2]] = [
    commands[commands.length - 2]!,
    commands[commands.length - 1]!,
  ];
  assertRefused(reordered, /is not 0x/);
});

test("funds drawn from anyone but the sender are refused", async () => {
  const kind = await burnKind("base", "address balance");
  const index = kind.ProgrammableTransaction!.inputs.findIndex(
    (input) => input.$kind === "FundsWithdrawal",
  );
  assert.ok(index >= 0);
  const fromSponsor = structuredClone(kind);
  fromSponsor.ProgrammableTransaction!.inputs[
    index
  ]!.FundsWithdrawal!.withdrawFrom = { $kind: "Sponsor", Sponsor: true };
  assertRefused(fromSponsor, /withdraws from Sponsor/);
});

// ---------- the sponsor service ----------

const wallet = Ed25519Keypair.generate();
const EMBEDDED = wallet.toSuiAddress();

function service(env: Record<string, string>) {
  const limits = new MemoryLimiter();
  const chain = fixtureChain();
  const reservations = memoryReservations();
  const todayCalls: string[] = [];
  const sponsor = createSponsorService({
    deployment: createPresaleDeploymentGate({
      environment: env,
      node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER),
    }),
    wallets: {
      async require(did) {
        if (did !== DID) throw new PresaleRouteError("not_embedded_wallet");
        return EMBEDDED;
      },
    },
    chain: chain.chain,
    reservations: reservations.store,
    executions: {
      async today(did) {
        todayCalls.push(did);
        return { allowed: true };
      },
    },
    config: () => ({
      sponsorAddress: SPONSOR,
      maxGasMist: CAP,
      swapTargets: [],
      tradeFee: () => null,
    }),
    clock: () => new Date(CLOCK),
    limits,
  });
  return { sponsor, reservations, todayCalls, limits };
}

const embeddedBurn = async (
  destination: SuiBurnParams["destination"] = "base",
) =>
  bcs.TransactionKind.serialize(
    await kindOf(suiBurnTransaction(IDS, EMBEDDED, params(destination)), {
      sender: EMBEDDED,
      amount: 5_000_000n,
    }),
  ).toBytes();

test("a burn is sponsored in-process under an identity with the V2 handler: its kind unchanged, the sponsor's gas, no presale, counted toward the daily budget", async () => {
  const s = service(identity({ cctp: SUI_CCTP_V2_IDENTITY }));
  const kind = await embeddedBurn("solana");
  const answer = await s.sponsor.sponsor({
    caller: { kind: "privy" as const, did: DID },
    presaleId: null,
    sender: EMBEDDED,
    kindBytes: kind,
    intent: "bridge_withdraw",
    ip: "198.51.100.4",
  });
  const data = bcs.TransactionData.parse(
    fromBase64(answer.transaction_bytes),
  ).V1!;
  assert.deepEqual(bcs.TransactionKind.serialize(data.kind).toBytes(), kind);
  assert.equal(normalizeSuiAddress(data.gasData.owner!), SPONSOR);
  assert.deepEqual(
    s.todayCalls,
    [DID],
    "a sponsored withdrawal spends the member's daily sponsorship",
  );
  const [row] = s.reservations.reserved();
  assert.deepEqual(
    [row?.intent, row?.presaleId, row?.sender],
    ["bridge_withdraw", null, EMBEDDED],
  );
  // Review M1: the withdrawal path pays the sponsor's per-IP, per-account daily and platform budgets.
  assert.deepEqual(s.limits.calls, [
    "presale_sponsor_ip",
    "presale_sponsor_account_daily",
    "presale_sponsor_global",
  ]);
  assert.deepEqual(s.limits.subjects, [
    { ip: "198.51.100.4" },
    { accountId: DID },
    {},
  ]);
});

test("without the V2 handler in the identity, or for a kind that is not the burn, nothing is sponsored", async () => {
  const noHandler = service(
    identity({ cctp: cctpWithout("stablecoinHandler", "handlerState") }),
  );
  await assert.rejects(
    noHandler.sponsor.sponsor({
      caller: { kind: "privy" as const, did: DID },
      presaleId: null,
      sender: EMBEDDED,
      kindBytes: await embeddedBurn(),
      intent: "bridge_withdraw",
      ip: "198.51.100.4",
    }),
    (error: unknown) =>
      error instanceof PresaleRouteError && error.code === "target_not_allowed",
  );
  assert.equal(noHandler.reservations.reserved().length, 0);

  const s = service(identity({ cctp: SUI_CCTP_V2_IDENTITY }));
  const send = new Transaction();
  const [coin] = send.splitCoins(
    send.object(
      Inputs.ObjectRef({
        objectId: `0x${"d5".repeat(32)}`,
        version: "3",
        digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      }),
    ),
    [1n],
  );
  send.transferObjects([coin!], OTHER_WALLET);
  const transfer = bcs.TransactionKind.serialize(
    await kindOf(send, { sender: EMBEDDED }),
  ).toBytes();
  await assert.rejects(
    s.sponsor.sponsor({
      caller: { kind: "privy" as const, did: DID },
      presaleId: null,
      sender: EMBEDDED,
      kindBytes: transfer,
      intent: "bridge_withdraw",
      ip: "198.51.100.4",
    }),
    (error: unknown) =>
      error instanceof PresaleRouteError && error.code === "target_not_allowed",
  );
  assert.equal(s.reservations.reserved().length, 0);
});

test("the sponsor's HTTP route takes no bridge_withdraw: only the withdrawal route may ask, in-process", async () => {
  const h = harness();
  await assertError(
    await h.route(
      post(await sponsorBody({ intent: "bridge_withdraw", presale_id: null })), testClient()
    ),
    "invalid_request",
  );
  assert.equal(h.reservations.reserved().length, 0);
});

test("a durable withdrawal identity atomically retains bytes and replays without another reservation or budget count", async (t) => {
  const s = service(identity({ cctp: SUI_CCTP_V2_IDENTITY }));
  const request = {
    caller: { kind: "privy" as const, did: DID }, presaleId: null, sender: EMBEDDED, kindBytes: await embeddedBurn(),
    intent: "bridge_withdraw" as const, ip: "198.51.100.4", reservationId: "11111111-1111-4111-8111-111111111111",
  };
  // No separate completion write exists for this keyed workflow: a process
  // dying immediately after claim can recover the whole first reservation.
  t.mock.method(s.reservations.store, "complete", async () => { throw new Error("must be atomic"); });
  const first = await s.sponsor.sponsor(request);
  const replay = await s.sponsor.sponsor(request);
  assert.deepEqual(replay, first);
  assert.equal(first.reservation_id, request.reservationId);
  assert.deepEqual(await s.sponsor.recoverBridgeWithdrawal({ reservationId: request.reservationId, accountKey: DID, sender: EMBEDDED }), first);
  await assert.rejects(s.sponsor.recoverBridgeWithdrawal({ reservationId: request.reservationId, accountKey: DID, sender: OTHER_WALLET }),
    (error: unknown) => error instanceof PresaleRouteError && error.code === "target_not_allowed");
  assert.equal(s.reservations.rows.length, 1);
  assert.equal(s.reservations.rows[0]!.state, "reserved");
  assert.deepEqual(s.limits.calls, ["presale_sponsor_ip", "presale_sponsor_account_daily", "presale_sponsor_global"]);
  assert.deepEqual(s.todayCalls, [DID]);
});

test("a crash after shared budgets but before reservation insert never recounts that withdrawal", async (t) => {
  const s = service(identity({ cctp: SUI_CCTP_V2_IDENTITY }));
  const request = {
    caller: { kind: "privy" as const, did: DID }, presaleId: null, sender: EMBEDDED, kindBytes: await embeddedBurn(),
    intent: "bridge_withdraw" as const, ip: "198.51.100.4", reservationId: "22222222-2222-4222-8222-222222222222",
  };
  const original = s.reservations.store.claim;
  const crash = t.mock.method(s.reservations.store, "claim", async () => { throw new Error("crash before insert"); });
  await assert.rejects(s.sponsor.sponsor(request), /crash before insert/);
  crash.mock.restore();
  assert.equal(s.reservations.store.claim, original);
  await assert.rejects(s.sponsor.sponsor(request), (error: unknown) => error instanceof PresaleRouteError && error.code === "service_unavailable");
  assert.equal(s.reservations.rows.length, 0);
  assert.deepEqual(s.limits.calls, ["presale_sponsor_ip", "presale_sponsor_account_daily", "presale_sponsor_global"]);
});

test("overlapping owners cannot both consume a keyed withdrawal's shared budgets", async (t) => {
  const s = service(identity({ cctp: SUI_CCTP_V2_IDENTITY }));
  const request = {
    caller: { kind: "privy" as const, did: DID }, presaleId: null, sender: EMBEDDED, kindBytes: await embeddedBurn(),
    intent: "bridge_withdraw" as const, ip: "198.51.100.4", reservationId: "33333333-3333-4333-8333-333333333333",
  };
  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const original = s.reservations.store.claim;
  t.mock.method(s.reservations.store, "claim", async (...args: Parameters<typeof original>) => { reached(); await held; return original(...args); });
  const first = s.sponsor.sponsor(request);
  await entered;
  try {
    await assert.rejects(s.sponsor.sponsor(request), (error: unknown) => error instanceof PresaleRouteError && error.code === "service_unavailable");
  } finally {
    release();
  }
  const reserved = await first;
  assert.deepEqual(await s.sponsor.sponsor(request), reserved);
  assert.equal(s.reservations.rows.length, 1);
  assert.deepEqual(s.limits.calls, ["presale_sponsor_ip", "presale_sponsor_account_daily", "presale_sponsor_global"]);
});

test("definite keyed budget and slot refusals replay before rebuilding and never recount", async (t) => {
  for (const reason of ["presale_sponsor_ip", "presale_sponsor_account_daily", "presale_sponsor_global", "open_reservations", "claim_busy"] as const) {
    const s = service(identity({ cctp: SUI_CCTP_V2_IDENTITY }));
    const request = { caller: { kind: "privy" as const, did: DID }, presaleId: null, sender: EMBEDDED, kindBytes: await embeddedBurn(), intent: "bridge_withdraw" as const, ip: "198.51.100.4", reservationId: "44444444-4444-4444-8444-444444444444" };
    if (reason === "open_reservations" || reason === "claim_busy") {
      t.mock.method(s.reservations.store, "claim", async () => reason === "open_reservations" ? { status: "full" as const, nextExpiry: null } : { status: "busy" as const });
    } else s.limits.refuse.add(reason);
    const refused = (error: unknown) => error instanceof KeyedSponsorRefusal && error.reason === reason;
    await assert.rejects(s.sponsor.sponsor(request), refused);
    assert.deepEqual(await s.reservations.store.budgetAttempt!(request.reservationId), { state: "refused", refusalReason: reason });
    const counts = [...s.limits.calls];
    t.mock.method(s.reservations.store, "open", async () => { assert.fail("Retained refusal must precede expensive rebuilding"); });
    await assert.rejects(s.sponsor.sponsor(request), refused);
    await assert.rejects(s.sponsor.recoverBridgeWithdrawal({ reservationId: request.reservationId, accountKey: DID, sender: EMBEDDED }), refused);
    assert.deepEqual(s.limits.calls, counts);
    assert.equal(s.reservations.rows.length, 0);
  }
});

test("a thrown shared limiter error remains ambiguous and is never counted again", async (t) => {
  const s = service(identity({ cctp: SUI_CCTP_V2_IDENTITY }));
  const request = { caller: { kind: "privy" as const, did: DID }, presaleId: null, sender: EMBEDDED, kindBytes: await embeddedBurn(), intent: "bridge_withdraw" as const, ip: "198.51.100.4", reservationId: "55555555-5555-4555-8555-555555555555" };
  let consumes = 0;
  t.mock.method(s.limits, "consume", async () => { consumes++; throw new Error("uncertain limiter outcome"); });
  await assert.rejects(s.sponsor.sponsor(request), /uncertain limiter outcome/);
  assert.deepEqual(await s.reservations.store.budgetAttempt!(request.reservationId), { state: "started", refusalReason: null });
  t.mock.method(s.reservations.store, "open", async () => { assert.fail("Parked attempt must precede rebuild"); });
  await assert.rejects(s.sponsor.sponsor(request), (error: unknown) => error instanceof PresaleRouteError && error.code === "service_unavailable");
  assert.equal(consumes, 1);
});

test("never-published recovery expires only atomically locked reserved bytes, retaining submitted and settled states", async () => {
  const at = new Date(CLOCK.getTime() + 200_000);
  for (const state of ["reserved", "expired", "submitted", "executed", "unconfirmed", "failed_execution", "reserving", "reservation_failed"] as SponsorReservationState[]) {
    for (const fresh of [false, true]) {
      let writes = 0;
      const sponsor = {
        moduleName: "presale-sponsor",
        async read(sql: string) {
          assert.match(sql, /FOR UPDATE/);
          assert.match(sql, /privy_did = \$2 AND sender = \$3/);
          return { rows: [{ state, submitted_at: ["submitted", "executed", "unconfirmed", "failed_execution"].includes(state) ? new Date(CLOCK) : null, expires_at: new Date(at.getTime() + (fresh ? 1 : -1)) }] };
        },
        async write(table: string, sql: string) {
          assert.equal(table, "presale_sponsor_reservations");
          assert.match(sql, /state = 'reserved' AND submitted_at IS NULL AND expires_at <= \$2/);
          writes++;
          return { rowCount: 1 };
        },
      } as unknown as ModuleTransaction<"presale-sponsor">;
      const expired = await expireUnsubmittedBridgeWithdrawal(sponsor, { reservationId: "11111111-1111-4111-8111-111111111111", privyDid: DID, sender: EMBEDDED }, at);
      assert.equal(expired, !fresh && ["reserved", "expired"].includes(state), `${state} fresh=${fresh}`);
      assert.equal(writes, !fresh && state === "reserved" ? 1 : 0);
    }
  }
});
