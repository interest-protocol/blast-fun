import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  coinWithBalance,
  Transaction,
  type TransactionObjectArgument,
} from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";

import {
  recordedAftermathRouter,
  YUM,
  YUM_BINDING,
  YUM_WRAPPER,
} from "../../../test/fixtures/modules/social/trades/aftermath-fixtures.ts";
import { swapKind } from "@blast/server/modules/social/trades/chain.ts";
import type { BlastTradeFee } from "@blast/core/lib/blast-trade-fee.ts";
import {
  balanceKey,
  offlineTradeChain,
  replayRouter,
  SALE_B,
  SUI,
  TEST_BLAST_FEE,
  TEST_FEE_RECEIVER,
  USDC,
} from "../../../test/fixtures/modules/social/trades/fixtures.ts";
import {
  fixtureChainNode,
  SUI_MAINNET_CHAIN_IDENTIFIER,
} from "../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import {
  executeHarness,
  executeRequest,
  NET_GAS_USED,
  reservedRow,
} from "../../../test/fixtures/modules/sponsor/execute-fixtures.ts";
import {
  kindOf,
  PRESALE_ID,
  PRESALE_PACKAGE,
  sdkCommit,
} from "../../../../core/test/fixtures/modules/sponsor/fixtures.ts";
import { AFTERMATH_DAO } from "@blast/core/modules/sponsor/aftermath-dao.ts";
import {
  evaluateTradePolicy,
  parseSwapTargets,
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
import {
  createSponsorService,
  type SponsorConfig,
} from "./service.ts";

/**
 * Social feed R3-31: the sponsor's `trade` intent. The social swap path builds
 * a Cetus aggregator swap from the route it pinned and sponsors it in-process;
 * the HTTP route never takes the intent. Server-built trades accept any
 * contract and never spend the presale's daily budget. The derived-call
 * policy is tested independently for callers that still need it.
 * The swaps here are built by the swap path's own builder over the
 * aggregator's recorded mainnet routes.
 */

/** The mainnet aggregator and adapter modules the recorded routes call. */
const MAINNET_SWAP_TARGETS = parseSwapTargets(
  [
    "0xffd4058af7d6f6d66c335930cced8c91e38ec943e2392232aee27e8127e684e9::router",
    "0x87b17d7f0b448b83ab934a13eb64b05b60e17d0a371e2a721c241bcf3f5ec9e7::cetus",
    "0x4e7c4ba436f8fd5b3c6bb514880ccd11c5109c83c45b5e037394b94204dbbb80::bluefin",
  ].join(","),
);

const wallet = Ed25519Keypair.generate();
const SENDER = wallet.toSuiAddress();

/** The swap path's kind for a recorded route, from the sender's own coins (never the gas coin). */
async function tradeKind(
  from: string,
  target: string,
  amount: bigint,
  options: { sender?: string; fee?: BlastTradeFee } = {},
): Promise<Uint8Array> {
  const { router } = replayRouter(undefined, options.fee ?? null);
  const answer = await router.findRoute({
    from,
    target,
    amount,
    byAmountIn: true,
  });
  assert.equal(answer.status, "route");
  if (answer.status !== "route") throw new Error("no route");
  const sender = options.sender ?? SENDER;
  const chain = offlineTradeChain({
    balances: { [balanceKey(sender, from)]: amount * 10n },
  });
  return swapKind(
    {
      router,
      route: answer.route,
      sender,
      inCoin: from,
      slippageBps: 50,
      useGasCoin: false,
    },
    chain.client,
  );
}

const parse = (bytes: Uint8Array): SponsorTransactionKind =>
  bcs.TransactionKind.parse(bytes);

test("the policy admits the swap path's swaps: one Cetus hop, and three legs across Bluefin and Cetus", async () => {
  for (const [from, amount] of [
    [SUI, 100_000_000n],
    [USDC, 1_000_000n],
  ] as const) {
    assert.deepEqual(
      evaluateTradePolicy({
        kind: parse(await tradeKind(from, SALE_B, amount)),
        sender: SENDER,
        swapTargets: MAINNET_SWAP_TARGETS,
        fee: null,
      }),
      { allowed: true },
      from,
    );
  }
});

test("the policy refuses anything a trade is not: no swap target, a presale call, another recipient, the gas coin, no swap", async () => {
  const kind = parse(await tradeKind(SUI, SALE_B, 100_000_000n));
  const refusal = (decision: ReturnType<typeof evaluateTradePolicy>) =>
    decision.allowed ? "allowed" : decision.reason;

  assert.match(
    refusal(
      evaluateTradePolicy({ kind, sender: SENDER, swapTargets: [], fee: null }),
    ),
    /router::new_swap_context_v3 is not allowed for intent trade/,
  );
  // Another sender: the output would go to an address that is not the transaction's sender.
  assert.match(
    refusal(
      evaluateTradePolicy({
        kind,
        sender: normalizeSuiAddress("0x5e12"),
        swapTargets: MAINNET_SWAP_TARGETS,
        fee: null,
      }),
    ),
    /not the sender/,
  );

  const commit = await kindOf(sdkCommit("open", { recipient: SENDER }), {
    sender: SENDER,
  });
  assert.match(
    refusal(
      evaluateTradePolicy({
        kind: commit,
        sender: SENDER,
        swapTargets: MAINNET_SWAP_TARGETS,
        fee: null,
      }),
    ),
    new RegExp(
      `${PRESALE_PACKAGE}::blast_presale::commit_open is not allowed for intent trade`,
    ),
  );

  // A plain transfer of the sender's own coin to itself: no swap at all.
  const transfer = new Transaction();
  transfer.setSender(SENDER);
  transfer.transferObjects(
    [
      transfer.add(
        coinWithBalance({ type: USDC, balance: 5n, useGasCoin: false }),
      ),
    ],
    SENDER,
  );
  const plain = parse(
    await transfer.build({
      client: offlineTradeChain({
        balances: { [balanceKey(SENDER, USDC)]: 50n },
      }).client,
      onlyTransactionKind: true,
    }),
  );
  assert.match(
    refusal(
      evaluateTradePolicy({
        kind: plain,
        sender: SENDER,
        swapTargets: MAINNET_SWAP_TARGETS,
        fee: null,
      }),
    ),
    /calls router::confirm_swap_v3 or swap::swap_exact_in at least once/,
  );

  // The same swap funded from the gas coin, which the sponsor owns.
  const { router } = replayRouter();
  const answer = await router.findRoute({
    from: SUI,
    target: SALE_B,
    amount: 100_000_000n,
    byAmountIn: true,
  });
  if (answer.status !== "route") throw new Error("no route");
  const fromGas = parse(
    await swapKind(
      {
        router,
        route: answer.route,
        sender: SENDER,
        inCoin: SUI,
        slippageBps: 50,
        useGasCoin: true,
      },
      offlineTradeChain().client,
    ),
  );
  assert.match(
    refusal(
      evaluateTradePolicy({
        kind: fromGas,
        sender: SENDER,
        swapTargets: MAINNET_SWAP_TARGETS,
        fee: null,
      }),
    ),
    /uses the gas coin/,
  );
});

test("owner 2026-10-08: with Blast's fee configured, the policy admits the fee'd swap — that rate, that receiver — and nothing looser", async () => {
  const refusal = (decision: ReturnType<typeof evaluateTradePolicy>) =>
    decision.allowed ? "allowed" : decision.reason;
  for (const [from, amount] of [
    [SUI, 100_000_000n],
    [USDC, 1_000_000n],
  ] as const) {
    const kind = parse(
      await tradeKind(from, SALE_B, amount, { fee: TEST_BLAST_FEE }),
    );
    assert.deepEqual(
      evaluateTradePolicy({
        kind,
        sender: SENDER,
        swapTargets: MAINNET_SWAP_TARGETS,
        fee: TEST_BLAST_FEE,
      }),
      { allowed: true },
      from,
    );
    // The same swap is refused by a sponsor that charges no fee, or another rate, or pays another receiver.
    assert.match(
      refusal(
        evaluateTradePolicy({
          kind,
          sender: SENDER,
          swapTargets: MAINNET_SWAP_TARGETS,
          fee: null,
        }),
      ),
      /argument 7 is not the derived address 0x0{64}/,
    );
    assert.match(
      refusal(
        evaluateTradePolicy({
          kind,
          sender: SENDER,
          swapTargets: MAINNET_SWAP_TARGETS,
          fee: { ...TEST_BLAST_FEE, bps: 60, ppm: 6_000 },
        }),
      ),
      /fee rate 5000 ppm is not Blast's 6000 ppm/,
    );
    const elsewhere = normalizeSuiAddress("0xbad");
    assert.match(
      refusal(
        evaluateTradePolicy({
          kind,
          sender: SENDER,
          swapTargets: MAINNET_SWAP_TARGETS,
          fee: { ...TEST_BLAST_FEE, receiver: elsewhere },
        }),
      ),
      new RegExp(`argument 7 is not the derived address ${elsewhere}`),
    );
  }
  // A configured fee never lets a swap skip it: the zero-fee swap is refused.
  const unpaid = parse(await tradeKind(SUI, SALE_B, 100_000_000n));
  assert.match(
    refusal(
      evaluateTradePolicy({
        kind: unpaid,
        sender: SENDER,
        swapTargets: MAINNET_SWAP_TARGETS,
        fee: TEST_BLAST_FEE,
      }),
    ),
    new RegExp(`argument 7 is not the derived address ${TEST_FEE_RECEIVER}`),
  );
  // The receiver is admitted at the fee recipient's position only: as a transfer's recipient it is still not the sender.
  const transfer = new Transaction();
  transfer.setSender(SENDER);
  transfer.transferObjects(
    [
      transfer.add(
        coinWithBalance({ type: USDC, balance: 5n, useGasCoin: false }),
      ),
    ],
    TEST_FEE_RECEIVER,
  );
  const paid = parse(
    await transfer.build({
      client: offlineTradeChain({
        balances: { [balanceKey(SENDER, USDC)]: 50n },
      }).client,
      onlyTransactionKind: true,
    }),
  );
  assert.match(
    refusal(
      evaluateTradePolicy({
        kind: paid,
        sender: SENDER,
        swapTargets: MAINNET_SWAP_TARGETS,
        fee: TEST_BLAST_FEE,
      }),
    ),
    /TransferObjects to an address that is not the sender/,
  );
});

/** The swap path's kind for an Aftermath DAO-fee route over the recorded pool (a Cetus leg for USDC). */
async function aftermathKind(
  from: string,
  target: string,
  amount: bigint,
  fee: BlastTradeFee | null = TEST_BLAST_FEE,
): Promise<SponsorTransactionKind> {
  const router = recordedAftermathRouter(fee);
  const answer = await router.findRoute({
    from,
    target,
    amount,
    byAmountIn: true,
    aftermath: YUM_BINDING,
  });
  if (answer.status !== "route") throw new Error("no route");
  const chain = offlineTradeChain({
    balances: { [balanceKey(SENDER, from)]: amount * 10n },
  });
  return parse(
    await swapKind(
      {
        router,
        route: answer.route,
        sender: SENDER,
        inCoin: from,
        slippageBps: 50,
        useGasCoin: false,
      },
      chain.client,
    ),
  );
}

/** A hand-built kind around the pinned DAO-fee swap of the sender's SUI, for what the swap path never builds. */
async function handDaoKind(
  build: (
    tx: Transaction,
    coin: TransactionObjectArgument,
    swap: (coin: TransactionObjectArgument) => TransactionObjectArgument,
  ) => void,
): Promise<SponsorTransactionKind> {
  const tx = new Transaction();
  tx.setSender(SENDER);
  const coin: TransactionObjectArgument = tx.add(
    coinWithBalance({ type: SUI, balance: 1_000n, useGasCoin: false }),
  );
  const swap = (input: TransactionObjectArgument): TransactionObjectArgument =>
    tx.moveCall({
      target: `${AFTERMATH_DAO.package}::swap::swap_exact_in`,
      typeArguments: ["0x1::lp::LP", SUI, YUM],
      arguments: [
        tx.object(YUM_WRAPPER),
        tx.object(AFTERMATH_DAO.version),
        tx.object(AFTERMATH_DAO.registry),
        tx.object(AFTERMATH_DAO.vault),
        tx.object(AFTERMATH_DAO.treasury),
        tx.object(AFTERMATH_DAO.insuranceFund),
        tx.object(AFTERMATH_DAO.referralVault),
        input,
        tx.pure.u64(1n),
        tx.pure.u64(0n),
      ],
    });
  build(tx, coin, swap);
  return parse(
    await tx.build({
      client: offlineTradeChain({
        balances: { [balanceKey(SENDER, SUI)]: 10_000n },
      }).client,
      onlyTransactionKind: true,
    }),
  );
}

test("Aftermath: the policy admits the swap path's DAO-fee trades, buy and sell, direct and through a fee-less Cetus leg, with or without Blast's fee", async () => {
  for (const [from, target, amount] of [
    [SUI, YUM, 1_000_000_000n],
    [YUM, SUI, 2_000_000_000_000n],
    [USDC, YUM, 3_000_000n],
    [YUM, USDC, 2_000_000_000_000n],
  ] as const) {
    for (const fee of [TEST_BLAST_FEE, null]) {
      const kind = await aftermathKind(from, target, amount, fee);
      assert.deepEqual(
        evaluateTradePolicy({
          kind,
          sender: SENDER,
          swapTargets: MAINNET_SWAP_TARGETS,
          fee,
        }),
        { allowed: true },
        `${from} → ${target}, fee ${fee?.bps ?? 0}`,
      );
    }
  }
  // The DAO-fee swap needs no configured target: it is pinned, not configured.
  assert.deepEqual(
    evaluateTradePolicy({
      kind: await aftermathKind(SUI, YUM, 1_000_000_000n),
      sender: SENDER,
      swapTargets: [],
      fee: TEST_BLAST_FEE,
    }),
    { allowed: true },
  );
});

test("Aftermath: Blast's fee goes only to its receiver, once, split from a swap's output, and only beside a DAO-fee swap", async () => {
  const refusal = (decision: ReturnType<typeof evaluateTradePolicy>) =>
    decision.allowed ? "allowed" : decision.reason;
  const evaluate = (
    kind: SponsorTransactionKind,
    fee: BlastTradeFee | null = TEST_BLAST_FEE,
  ) =>
    refusal(
      evaluateTradePolicy({
        kind,
        sender: SENDER,
        swapTargets: MAINNET_SWAP_TARGETS,
        fee,
      }),
    );
  const kind = await aftermathKind(SUI, YUM, 1_000_000_000n);
  // A sponsor configured for no fee, or for another receiver, refuses the transfer.
  assert.match(
    evaluate(kind, null),
    /TransferObjects to an address that is not the sender/,
  );
  assert.match(
    evaluate(kind, {
      ...TEST_BLAST_FEE,
      receiver: normalizeSuiAddress("0xbad"),
    }),
    /TransferObjects to an address that is not the sender/,
  );
  // Split from the sender's input, not the swap's output.
  assert.match(
    evaluate(
      await handDaoKind((tx, coin, swap) => {
        const [cut] = tx.splitCoins(coin, [5n]);
        tx.transferObjects([cut!], TEST_FEE_RECEIVER);
        tx.transferObjects([swap(coin)], SENDER);
      }),
    ),
    /Blast's fee is not a coin split from a swap's output/,
  );
  // The whole output to the receiver.
  assert.match(
    evaluate(
      await handDaoKind((tx, coin, swap) =>
        tx.transferObjects([swap(coin)], TEST_FEE_RECEIVER),
      ),
    ),
    /Blast's fee is not a coin split from a swap's output/,
  );
  // Twice.
  assert.match(
    evaluate(
      await handDaoKind((tx, coin, swap) => {
        const out = swap(coin);
        const [a, b] = tx.splitCoins(out, [1n, 1n]);
        tx.transferObjects([a!], TEST_FEE_RECEIVER);
        tx.transferObjects([b!], TEST_FEE_RECEIVER);
        tx.transferObjects([out], SENDER);
      }),
    ),
    /a second TransferObjects to Blast's fee receiver/,
  );
  // One split transfer of the output is exactly what the swap path builds.
  assert.equal(
    evaluate(
      await handDaoKind((tx, coin, swap) => {
        const out = swap(coin);
        const [cut] = tx.splitCoins(out, [1n]);
        tx.transferObjects([cut!], TEST_FEE_RECEIVER);
        tx.transferObjects([out], SENDER);
      }),
    ),
    "allowed",
  );
});

test("Aftermath: a DAO-fee kind's Cetus leg charges no fee of its own, so Blast's is never taken twice", async () => {
  const refusal = (decision: ReturnType<typeof evaluateTradePolicy>) =>
    decision.allowed ? "allowed" : decision.reason;
  const kind = await aftermathKind(USDC, YUM, 3_000_000n);
  const commands = kind.ProgrammableTransaction!.commands;
  const context = commands.find(
    (command) => command.MoveCall?.function === "new_swap_context_v3",
  )!.MoveCall!;
  const inputs = kind.ProgrammableTransaction!.inputs;
  const at = (position: number) =>
    (context.arguments[position] as { Input: number }).Input;
  // Blast's rate to Blast's receiver in the context, as a Cetus-only trade carries it.
  inputs[at(6)] = {
    $kind: "Pure",
    Pure: {
      bytes: Buffer.from(
        bcs.u32().serialize(TEST_BLAST_FEE.ppm).toBytes(),
      ).toString("base64"),
    },
  } as never;
  inputs[at(7)] = {
    $kind: "Pure",
    Pure: {
      bytes: Buffer.from(
        bcs.Address.serialize(TEST_FEE_RECEIVER).toBytes(),
      ).toString("base64"),
    },
  } as never;
  assert.match(
    refusal(
      evaluateTradePolicy({
        kind,
        sender: SENDER,
        swapTargets: MAINNET_SWAP_TARGETS,
        fee: TEST_BLAST_FEE,
      }),
    ),
    /argument 7 is not the derived address 0x0{64}/,
  );
});

test("Aftermath: the DAO-fee swap is refused off its pins: another package, another version object, the coin as an owned input, another arity", async () => {
  const refusal = (decision: ReturnType<typeof evaluateTradePolicy>) =>
    decision.allowed ? "allowed" : decision.reason;
  const evaluate = (kind: SponsorTransactionKind) =>
    refusal(
      evaluateTradePolicy({
        kind,
        sender: SENDER,
        swapTargets: MAINNET_SWAP_TARGETS,
        fee: TEST_BLAST_FEE,
      }),
    );
  const base = async () => aftermathKind(SUI, YUM, 1_000_000_000n);
  const daoCall = (kind: SponsorTransactionKind) =>
    kind.ProgrammableTransaction!.commands.find(
      (command) => command.MoveCall?.function === "swap_exact_in",
    )!.MoveCall!;

  const otherPackage = await base();
  daoCall(otherPackage).package = normalizeSuiAddress("0x99");
  assert.match(
    evaluate(otherPackage),
    /0x0{62}99::swap::swap_exact_in is not allowed for intent trade/,
  );

  const otherVersion = await base();
  const version = (daoCall(otherVersion).arguments[1] as { Input: number })
    .Input;
  otherVersion.ProgrammableTransaction!.inputs[
    version
  ]!.Object!.SharedObject!.objectId = normalizeSuiAddress("0x77");
  assert.match(
    evaluate(otherVersion),
    new RegExp(`argument 1 is not the derived object ${AFTERMATH_DAO.version}`),
  );

  const ownedCoin = await base();
  const inputs = ownedCoin.ProgrammableTransaction!.inputs;
  inputs.push({
    $kind: "Object",
    Object: {
      $kind: "ImmOrOwnedObject",
      ImmOrOwnedObject: {
        objectId: normalizeSuiAddress("0xc0"),
        version: "1",
        digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      },
    },
  } as never);
  daoCall(ownedCoin).arguments[7] = {
    $kind: "Input",
    Input: inputs.length - 1,
  } as never;
  assert.match(
    evaluate(ownedCoin),
    /argument 7 is an owned object, not result/,
  );

  const shorter = await base();
  daoCall(shorter).arguments.pop();
  assert.match(evaluate(shorter), /takes 9 arguments, not the derived 10/);
});

function service(
  overrides: {
    today?: () => Promise<{ allowed: boolean }>;
    tradeFee?: () => BlastTradeFee | null;
    swapTargets?: SponsorConfig["swapTargets"];
  } = {},
) {
  const limits = new MemoryLimiter();
  const chain = fixtureChain();
  const reservations = memoryReservations();
  const todayCalls: string[] = [];
  const config: SponsorConfig = {
    sponsorAddress: SPONSOR,
    maxGasMist: CAP,
    swapTargets: overrides.swapTargets ?? MAINNET_SWAP_TARGETS,
    tradeFee: overrides.tradeFee ?? (() => null),
  };
  const sponsor = createSponsorService({
    deployment: createPresaleDeploymentGate({
      environment: identity(),
      node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER),
    }),
    wallets: {
      async require(did) {
        if (did !== DID) throw new PresaleRouteError("not_embedded_wallet");
        return SENDER;
      },
    },
    chain: chain.chain,
    reservations: reservations.store,
    executions: {
      async today(did) {
        todayCalls.push(did);
        return overrides.today ? overrides.today() : { allowed: true };
      },
    },
    config: () => config,
    clock: () => new Date(CLOCK),
    limits,
  });
  return { sponsor, chain, reservations, todayCalls, limits };
}

test("server-built trades need no contract allowlist, including a new router module", async () => {
  for (const newRouter of [false, true]) {
    const s = service({
      swapTargets: [],
      today: async () => ({ allowed: false }),
    });
    const kind = parse(await tradeKind(USDC, SALE_B, 1_000_000n));
    if (newRouter) {
      for (const command of kind.ProgrammableTransaction!.commands) {
        if (!command.MoveCall) continue;
        command.MoveCall.package = normalizeSuiAddress("0xabcd");
        command.MoveCall.module = "new_router";
        command.MoveCall.function = "swap_v99";
      }
    }
    const kindBytes = bcs.TransactionKind.serialize(kind).toBytes();
    const answer = await s.sponsor.sponsor({
      caller: { kind: "privy" as const, did: DID },
      presaleId: null,
      intent: "trade",
      sender: SENDER,
      kindBytes,
      ip: "203.0.113.7",
    });
    const data = bcs.TransactionData.parse(
      fromBase64(answer.transaction_bytes),
    ).V1!;
    assert.deepEqual(
      bcs.TransactionKind.serialize(data.kind).toBytes(),
      kindBytes,
    );
    assert.equal(normalizeSuiAddress(data.gasData.owner!), SPONSOR);
    assert.equal(s.reservations.reserved()[0]?.intent, "trade");
    assert.deepEqual(s.todayCalls, []);
    assert.deepEqual(s.limits.calls, [
      "presale_sponsor_ip",
      "presale_sponsor_account_daily",
      "presale_sponsor_global",
    ]);
  }
});

test("server-built trades still require the caller's wallet, simulation and shared budgets", async () => {
  const request = {
    caller: { kind: "privy" as const, did: DID },
    presaleId: null,
    intent: "trade" as const,
    sender: SENDER,
    kindBytes: await tradeKind(USDC, SALE_B, 1_000_000n),
    ip: "203.0.113.7",
  };
  const otherWallet = service({ swapTargets: [] });
  await assert.rejects(
    otherWallet.sponsor.sponsor({
      ...request,
      sender: normalizeSuiAddress("0x123"),
    }),
    { code: "not_embedded_wallet" },
  );
  assert.equal(otherWallet.chain.state.simulated.length, 0);

  const limited = service({ swapTargets: [] });
  limited.limits.refuse.add("presale_sponsor_global");
  await assert.rejects(limited.sponsor.sponsor(request), {
    code: "rate_limited",
  });
  assert.equal(limited.reservations.rows.length, 0);

  const failed = service({ swapTargets: [] });
  failed.chain.state.simulation = {
    status: "failure",
    failure: { kind: "move_abort", packageId: null, module: null, code: null },
    gasUsed: { computationCost: 0n, storageCost: 0n },
  };
  await assert.rejects(failed.sponsor.sponsor(request), {
    code: "dry_run_failed",
  });
  assert.equal(failed.reservations.rows.length, 0);
});

test("a trade is sponsored in-process: its kind unchanged, the sponsor's gas, no presale, and never the presale's daily budget", async () => {
  const s = service({ today: async () => ({ allowed: false }) });
  const kind = await tradeKind(SUI, SALE_B, 100_000_000n);
  const answer = await s.sponsor.sponsor({
    caller: { kind: "privy" as const, did: DID },
    presaleId: null,
    sender: SENDER,
    kindBytes: kind,
    intent: "trade",
    ip: "203.0.113.7",
  });
  const data = bcs.TransactionData.parse(
    fromBase64(answer.transaction_bytes),
  ).V1!;
  assert.deepEqual(
    bcs.TransactionKind.serialize(data.kind).toBytes(),
    kind,
    "the kind the swap path built, unchanged",
  );
  assert.equal(normalizeSuiAddress(data.gasData.owner!), SPONSOR);
  assert.deepEqual(
    s.todayCalls,
    [],
    "a trade never reads the presale's daily budget, even when it is spent",
  );
  const [row] = s.reservations.reserved();
  assert.deepEqual(
    [row?.intent, row?.presaleId, row?.sender],
    ["trade", null, SENDER],
  );
  // Review M1: an in-process caller pays the sponsor's per-IP, per-account daily and platform budgets too.
  assert.deepEqual(s.limits.calls, [
    "presale_sponsor_ip",
    "presale_sponsor_account_daily",
    "presale_sponsor_global",
  ]);
  assert.deepEqual(s.limits.subjects, [
    { ip: "203.0.113.7" },
    { accountId: DID },
    {},
  ]);
});

test("review M1: a full sponsor budget refuses an in-process trade as rate_limited before any slot or pool coin", async () => {
  for (const bucket of [
    "presale_sponsor_ip",
    "presale_sponsor_account_daily",
    "presale_sponsor_global",
  ] as const) {
    const s = service();
    s.limits.refuse.add(bucket);
    await assert.rejects(
      s.sponsor.sponsor({
        caller: { kind: "privy" as const, did: DID },
        presaleId: null,
        sender: SENDER,
        kindBytes: await tradeKind(SUI, SALE_B, 100_000_000n),
        intent: "trade",
        ip: "203.0.113.7",
      }),
      (error: unknown) =>
        error instanceof PresaleRouteError &&
        error.code === "rate_limited" &&
        error.retryAfterSeconds === 42,
      bucket,
    );
    assert.equal(
      s.limits.calls.at(-1),
      bucket,
      "the first full budget stops the count",
    );
    assert.equal(s.reservations.reserved().length, 0, bucket);
    assert.equal(s.reservations.rows.length, 0, bucket);
  }
});

test("server-built trades keep the fee encoded by the router without a second contract policy", async () => {
  const s = service({
    swapTargets: [],
    tradeFee: () => {
      throw new Error("the server router owns trade fee validation");
    },
  });
  const kind = await tradeKind(SUI, SALE_B, 100_000_000n, {
    fee: TEST_BLAST_FEE,
  });
  const answer = await s.sponsor.sponsor({
    caller: { kind: "privy" as const, did: DID },
    presaleId: null,
    sender: SENDER,
    kindBytes: kind,
    intent: "trade",
    ip: "203.0.113.7",
  });
  assert.deepEqual(
    bcs.TransactionKind.serialize(
      bcs.TransactionData.parse(fromBase64(answer.transaction_bytes)).V1!.kind,
    ).toBytes(),
    kind,
  );
});

test("a server-built swap-and-commit is sponsored past the swap allowlist; the same kind through the public path is refused", async () => {
  // The aggregator picks its own legs (Bluefin, Cetus, …), so no fixed list of swap packages admits every route.
  const kindBytes = await tradeKind(USDC, SALE_B, 1_000_000n);
  const request = {
    caller: { kind: "privy" as const, did: DID },
    presaleId: PRESALE_ID,
    intent: "commit" as const,
    sender: SENDER,
    kindBytes,
    ip: "203.0.113.7",
  };
  const publicPath = service({ swapTargets: [] });
  await assert.rejects(publicPath.sponsor.sponsor(request), { code: "target_not_allowed" });
  assert.equal(publicPath.reservations.rows.length, 0);

  const s = service({ swapTargets: [] });
  const answer = await s.sponsor.sponsorServerCommit(request);
  const data = bcs.TransactionData.parse(fromBase64(answer.transaction_bytes)).V1!;
  assert.deepEqual(bcs.TransactionKind.serialize(data.kind).toBytes(), kindBytes);
  assert.equal(normalizeSuiAddress(data.gasData.owner!), SPONSOR);
  assert.equal(s.reservations.reserved()[0]?.intent, "commit");
  // Still the commit's budgets: the account's daily allowance, and the sender must be the caller's Blast wallet.
  assert.deepEqual(s.todayCalls, [DID]);
  assert.deepEqual(s.limits.calls, ["presale_sponsor_ip", "presale_sponsor_account_daily", "presale_sponsor_global"]);
  const other = service({ swapTargets: [] });
  await assert.rejects(other.sponsor.sponsorServerCommit({ ...request, sender: normalizeSuiAddress("0x123") }), { code: "not_embedded_wallet" });
  const spent = service({ swapTargets: [], today: async () => ({ allowed: false }) });
  await assert.rejects(spent.sponsor.sponsorServerCommit(request), { code: "budget_exceeded" });
  assert.equal(spent.reservations.rows.length, 0);

  // A wallet session (owner ruling 2026-11-20) is sponsored for its own address only, on its own budget key.
  const session = service({ swapTargets: [] });
  const walletRequest = { ...request, caller: { kind: "wallet" as const, address: SENDER } };
  await session.sponsor.sponsorServerCommit(walletRequest);
  assert.deepEqual(session.todayCalls, [`sui:${SENDER}`]);
  const foreign = service({ swapTargets: [] });
  await assert.rejects(foreign.sponsor.sponsorServerCommit({ ...walletRequest, caller: { kind: "wallet", address: normalizeSuiAddress("0x123") } }), { code: "not_embedded_wallet" });
  assert.equal(foreign.reservations.rows.length, 0);
});

test("the sponsor's HTTP route takes no trade: only the swap path may ask, in-process", async () => {
  const h = harness();
  const body = await sponsorBody({ intent: "trade", presale_id: PRESALE_ID });
  await assertError(await h.route(post(body), testClient()), "invalid_request");
  await assertError(
    await h.route(post({ ...body, serverBuilt: true }), testClient()),
    "invalid_request",
  );
  await assertError(
    await h.route(post({ ...body, intent: "commit", serverBuilt: true }), testClient()),
    "invalid_request",
  );
  assert.equal(h.reservations.reserved().length, 0);
});

test("executing a sponsored trade settles it without counting the presale's daily budget", async () => {
  const h = executeHarness();
  const txBytes = bcs.TransactionData.serialize({
    V1: {
      kind: parse(await tradeKind(SUI, SALE_B, 100_000_000n)),
      sender: SENDER,
      gasData: {
        payment: [
          {
            objectId: `0x${"c7".repeat(32)}`,
            version: "41",
            digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
          },
        ],
        owner: SPONSOR,
        price: 750n,
        budget: 3_600_000n,
      },
      expiration: { None: true },
    },
  }).toBytes();
  const reservation = reservedRow({
    privyDid: DID,
    sender: SENDER,
    txBytes,
    intent: "trade",
    presaleId: null,
  });
  h.executions.rows.push(reservation);
  const signature = (await wallet.signTransaction(txBytes)).signature;
  const response = await h.route(
    executeRequest(reservation.id, { user_signature: signature }), testClient()
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    digest: reservation.digest,
    effects: { status: "success", gas_used: NET_GAS_USED },
  });
  assert.equal(h.executions.rows[0]?.state, "executed");
  assert.equal(
    h.consumed(),
    0,
    "the social cap counts trades, not presale_sponsor_exec",
  );
  assert.deepEqual(h.recorded, [], "a trade is no presale commit");
});
