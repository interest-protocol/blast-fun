import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { routeSponsorCaller, sponsorAccountKey, type SponsorCaller } from "./caller.ts";
import { deploymentFingerprint } from "@interest-protocol/blast-sdk/deployments";
import { sponsorSubmissionSchema } from "@blast/core/modules/presale/contracts/sponsor-request.ts";
import { creatorSponsorTarget } from "@blast/server/modules/social/creator-earnings/sponsor.ts";

import { randomInt } from "node:crypto";

import { bcs } from "@mysten/sui/bcs";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import {
  isValidSuiAddress,
  normalizeSuiAddress,
  toBase64,
} from "@mysten/sui/utils";

import { suiBurnIds } from "@blast/core/modules/presale/bridge/sui-burn.ts";
import type { SponsorResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import type { PresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import type { PresaleEmbeddedWallets } from "@blast/server/modules/presale/embedded-wallets/service.ts";
import type { BlastTradeFee } from "@blast/core/lib/blast-trade-fee.ts";
import type {
  PresaleRateBucket,
  RateLimitPort,
  RateLimitSubject,
} from "@blast/core/lib/web-security/rate-limits.ts";
import { recordPresaleMetric } from "@blast/core/modules/presale/redaction/redaction.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import {
  readJsonBody,
  type PresaleRouteKit,
} from "@blast/core/modules/presale/route-kit/route.ts";
import { presaleAbortName } from "@interest-protocol/blast-sdk/presale";
import type {
  SponsorChain,
  SponsorSimulation,
  SponsorSimulationFailure,
} from "./chain.ts";
import {
  evaluateSponsorPolicy,
  evaluateBridgeWithdrawPolicy,
  evaluateWithdrawPolicy,
  parseSwapTargets,
  referencedRewardRounds,
  referencedVestingSchedules,
  SWAP_TARGETS_ENV,
  type SponsorSwapTarget,
  type SponsorTransactionKind,
} from "@blast/core/modules/sponsor/policy.ts";
import {
  capsNetStorage,
  hasDailySponsorshipLimit,
  namesPresale,
  recoversByKey,
  sponsorPolicyKind,
  type KeyedSponsorIntent,
  type PresaleSponsorIntent,
  type PublicSponsorIntent,
  type SponsorIntent,
} from "@blast/core/modules/sponsor/intents.ts";
import {
  MAX_OPEN_SPONSOR_RESERVATIONS,
  SPONSOR_RESERVATION_SECONDS,
  sponsorClaimWindow,
  KeyedSponsorRefusal,
  type SponsorBudgetRefusal,
  type SponsorClaimResult,
  type SponsorReservationStore,
} from "./reservations.ts";

/** Largest transaction kind accepted, after base64 decoding. */
export const SPONSOR_KIND_MAX_BYTES = 16 * 1_024;
/** The smallest gas budget the route reserves, in MIST. */
export const SPONSOR_MIN_GAS_BUDGET_MIST = 2_000_000n;
/** The default per-transaction cap, `PRESALE_SPONSOR_MAX_GAS_MIST`. */
export const SPONSOR_DEFAULT_MAX_GAS_MIST = 50_000_000n;
/**
 * The most storage a kind the policy checked may leave the sponsor paying for,
 * net of its rebate (about ten new objects); kinds the server built and trusts
 * skip it (`capsNetStorage`). The sponsor pre-pays every object a kind creates
 * and whoever later deletes it is refunded, so this bounds what one sponsored
 * transaction can move from the sponsor to its sender.
 */
export const SPONSOR_MAX_NET_STORAGE_MIST = 20_000_000n;
/** The response's `expires_at_ms` is this much before the reservation's own expiry. */
export const SPONSOR_EXPIRY_MARGIN_MS = 10_000;

/** Room for a 16 KiB kind in base64 plus the other fields. */
const BODY_LIMIT_BYTES = 32 * 1_024;

export type SponsorConfig = Readonly<{
  /** `PRESALE_SPONSOR_ADDRESS`: the sponsor whose address balance pays the gas (the gas owner). */
  sponsorAddress: string;
  /** `PRESALE_SPONSOR_MAX_GAS_MIST`: the per-transaction gas cap. */
  maxGasMist: bigint;
  /** `PRESALE_SPONSOR_SWAP_TARGETS`, parsed. */
  swapTargets: readonly SponsorSwapTarget[];
  /**
   * Blast's app fee on trades (`BLAST_TRADE_FEE_BPS`, `BLAST_TRADE_FEE_RECEIVER`,
   * parsed at boot), the one fee a sponsored trade or swap-and-commit may pay;
   * null for none.
   */
  tradeFee: () => BlastTradeFee | null;
}>;

/**
 * The sponsor settings, parsed once at boot: null while
 * `PRESALE_SPONSOR_ADDRESS` is unset (sponsoring answers `service_unavailable`);
 * otherwise that address, `PRESALE_SPONSOR_MAX_GAS_MIST` (default 50,000,000;
 * at least 2,000,000), `PRESALE_SPONSOR_SWAP_TARGETS`, and Blast's `tradeFee`.
 * An invalid value throws, naming the variable and never repeating its value.
 */
export function sponsorConfigFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  tradeFee: BlastTradeFee | null,
): SponsorConfig | null {
  const address = environment.PRESALE_SPONSOR_ADDRESS?.trim() ?? "";
  if (address === "") return null;
  if (!isValidSuiAddress(address)) throw new Error("PRESALE_SPONSOR_ADDRESS must be a Sui address.");
  const cap =
    environment.PRESALE_SPONSOR_MAX_GAS_MIST?.trim() ||
    SPONSOR_DEFAULT_MAX_GAS_MIST.toString();
  if (
    !/^[1-9][0-9]{0,15}$/.test(cap) ||
    BigInt(cap) < SPONSOR_MIN_GAS_BUDGET_MIST ||
    BigInt(cap) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error(`PRESALE_SPONSOR_MAX_GAS_MIST must be a whole number of MIST from ${SPONSOR_MIN_GAS_BUDGET_MIST} to ${Number.MAX_SAFE_INTEGER}.`);
  let swapTargets: SponsorSwapTarget[];
  try {
    swapTargets = parseSwapTargets(environment[SWAP_TARGETS_ENV]);
  } catch {
    throw new Error(`${SWAP_TARGETS_ENV} must list valid swap targets.`);
  }
  return {
    sponsorAddress: normalizeSuiAddress(address),
    maxGasMist: BigInt(cap),
    swapTargets,
    tradeFee: () => tradeFee,
  };
}

/** The sponsor settings a request needs: without them, `service_unavailable`. */
export function requireSponsorConfig(config: SponsorConfig | null): SponsorConfig {
  if (config === null) throw new PresaleRouteError("service_unavailable");
  return config;
}

export type PresaleSponsorDependencies = PresaleSponsorServiceDependencies &
  Readonly<{ kit: PresaleRouteKit }>;

/** What sponsoring a kind needs, with or without the HTTP route around it. */
export type PresaleSponsorServiceDependencies = Readonly<{
  /** Checked inside the handler, after the wallet check (step 4). */
  deployment: PresaleDeploymentGate;
  authorizeSigning?: (
    intent: SponsorIntent,
    signal?: AbortSignal,
  ) => ReturnType<PresaleDeploymentGate["authorize"]>;
  wallets: Pick<PresaleEmbeddedWallets, "require">;
  chain: SponsorChain;
  reservations: SponsorReservationStore;
  /** Whether the account (by `sponsorAccountKey`) may execute one more sponsored transaction today (`presale_sponsor_exec`, read without consuming). */
  executions: Readonly<{
    today(accountKey: string): Promise<Readonly<{ allowed: boolean }>>;
  }>;
  /**
   * The sponsor's shared budgets (`presale_sponsor_ip`,
   * `presale_sponsor_account_daily`, `presale_sponsor_global`), counted only
   * after the request passed the policy and the dry run (`countSponsorBudgets`).
   */
  limits: Pick<RateLimitPort, "consume">;
  /** Throws when the sponsor settings are missing or invalid (`service_unavailable`). */
  config: () => SponsorConfig;
  clock?: () => Date;
}>;

/** A public intent with its presale (no public intent is keyed, so none carries a `reservationId`). */
type SponsorRequestBody = Extract<SponsorTarget, { intent: PublicSponsorIntent }> &
  Readonly<{ sender: string; kindBytes: Uint8Array }>;

/**
 * Step 2: exact keys, canonical addresses, a known intent, and at most 16 KiB
 * of kind. A presale intent names its presale; `withdraw` names none.
 */
function parseSponsorRequest(value: unknown): SponsorRequestBody {
  const parsed = sponsorSubmissionSchema.safeParse(value);
  if (!parsed.success) throw new PresaleRouteError("invalid_request");
  const body = parsed.data;
  const kindBytes = Uint8Array.from(Buffer.from(body.transaction_kind_bytes, "base64"));
  if (kindBytes.length > SPONSOR_KIND_MAX_BYTES) throw new PresaleRouteError("body_too_large");
  const target =
    "presale_id" in body
      ? { intent: body.intent, presaleId: body.presale_id }
      : { intent: body.intent, presaleId: null };
  return { ...target, sender: body.sender, kindBytes };
}

/** Step 5's decode: a canonical BCS `TransactionKind`, which the built bytes then carry unchanged. */
function decodeKind(bytes: Uint8Array): SponsorTransactionKind {
  let kind: SponsorTransactionKind;
  try {
    kind = bcs.TransactionKind.parse(bytes);
  } catch {
    throw new PresaleRouteError("invalid_request");
  }
  const canonical = bcs.TransactionKind.serialize(kind).toBytes();
  if (!Buffer.from(canonical).equals(Buffer.from(bytes)))
    throw new PresaleRouteError("invalid_request");
  return kind;
}

/** The `ValidDuring` expiration an address-balance payment needs: this epoch or the next, on this chain, with a random nonce. */
type SponsorExpiration = Readonly<{
  epoch: bigint;
  chain: string;
  nonce: number;
}>;

/**
 * Full `TransactionData` V1 bytes: the caller's kind unchanged, with the
 * sponsor as gas owner and an empty payment, so the sponsor's address balance
 * pays (no gas coins, no pool). Replay protection is the `ValidDuring`
 * expiration, as Sui requires for address-balance gas.
 */
function transactionData(
  input: Readonly<{
    kind: SponsorTransactionKind;
    sender: string;
    owner: string;
    price: bigint;
    budget: bigint;
    expiration: SponsorExpiration;
  }>,
): Uint8Array {
  const { epoch, chain, nonce } = input.expiration;
  return bcs.TransactionData.serialize({
    V1: {
      kind: input.kind,
      sender: input.sender,
      gasData: {
        payment: [],
        owner: input.owner,
        price: input.price,
        budget: input.budget,
      },
      expiration: {
        ValidDuring: {
          minEpoch: epoch,
          maxEpoch: epoch + 1n,
          minTimestamp: null,
          maxTimestamp: null,
          chain,
          nonce,
        },
      },
    },
  }).toBytes();
}

/**
 * Steps 8 and 9: the simulation's verdict and the gas budget. An abort is
 * `dry_run_failed`, naming a presale-package abort through the SDK's one map
 * or `external_abort` (CL-19); a cost above the cap is `gas_cap_exceeded`.
 * Budget = ceil((computation + storage) × 1.2), within [2,000,000, cap].
 */
function refuseSimulation(
  failure: SponsorSimulationFailure,
  cost: bigint,
  presalePackages: ReadonlySet<string>,
  cap: bigint,
): never {
  if (failure.kind === "move_abort") {
    const presale =
      failure.packageId !== null && presalePackages.has(failure.packageId);
    const name =
      presale && failure.module !== null && failure.code !== null
        ? presaleAbortName(failure.code)
        : null;
    if (presale && name === null) {
      recordPresaleMetric("presale.sponsor", {
        outcome: "unmapped_presale_abort",
        module: failure.module ?? "unknown",
        code: failure.code ?? -1,
      });
    }
    // CL-19 and CL-24: only a mapped presale-package abort is named; any other abort is `external_abort`.
    throw new PresaleRouteError("dry_run_failed", {
      extra: name
        ? { move_abort: name }
        : { move_abort: null, reason: "external_abort" },
    });
  }
  if (failure.kind === "insufficient_gas" || cost >= cap) {
    throw new PresaleRouteError("dry_run_failed", {
      extra: { move_abort: null, reason: "gas_cap_exceeded" },
    });
  }
  // CL-24: `external_abort` covers every failed simulation that is neither a named presale abort
  // nor the gas cap, including failures that are not aborts (argument or object errors).
  recordPresaleMetric("presale.sponsor", {
    outcome: "dry_run_failed",
    failure: failure.label,
  });
  throw new PresaleRouteError("dry_run_failed", {
    extra: { move_abort: null, reason: "external_abort" },
  });
}

function gasBudget(
  simulation: SponsorSimulation,
  presalePackages: ReadonlySet<string>,
  cap: bigint,
  clientBuilt: boolean,
): bigint {
  const cost =
    simulation.gasUsed.computationCost + simulation.gasUsed.storageCost;
  if (simulation.status === "failure") {
    refuseSimulation(simulation.failure, cost, presalePackages, cap);
  }
  const netStorage = simulation.gasUsed.storageCost - (simulation.gasUsed.storageRebate ?? 0n);
  if (cost > cap || (clientBuilt && netStorage > SPONSOR_MAX_NET_STORAGE_MIST))
    throw new PresaleRouteError("dry_run_failed", {
      extra: { move_abort: null, reason: "gas_cap_exceeded" },
    });
  const padded = (cost * 6n + 4n) / 5n;
  return padded < SPONSOR_MIN_GAS_BUDGET_MIST
    ? SPONSOR_MIN_GAS_BUDGET_MIST
    : padded > cap
      ? cap
      : padded;
}

/**
 * The open-reservation cap's `budget_exceeded` (`reason: "open_reservations"`,
 * CL-25). `Retry-After` names when that budget frees up: the earliest open
 * reservation's expiry. The daily limit's (`daily_limit`) runs to the next UTC day.
 */
function openCapExceeded(
  nextExpiry: Date | null,
  now: Date,
): PresaleRouteError {
  const untilFirstExpiry = nextExpiry
    ? Math.ceil((nextExpiry.getTime() - now.getTime()) / 1_000)
    : 1;
  return new PresaleRouteError("budget_exceeded", {
    extra: { reason: "open_reservations" },
    retryAfterSeconds: Math.max(1, untilFirstExpiry),
  });
}

/** `Retry-After` when another request of the account holds the claim lock: claims take milliseconds. */
const CLAIM_BUSY_RETRY_AFTER_SECONDS = 1;

function openReservationsBusy(): PresaleRouteError {
  return new PresaleRouteError("budget_exceeded", {
    extra: { reason: "open_reservations" },
    retryAfterSeconds: CLAIM_BUSY_RETRY_AFTER_SECONDS,
  });
}

/** Per intent: `presaleId` names the presale exactly for presale intents, and only keyed intents carry a `reservationId`. */
type SponsorTarget = {
  [Intent in SponsorIntent]: Readonly<{
    intent: Intent;
    presaleId: Intent extends PresaleSponsorIntent ? string : null;
    /** Internal durable withdrawal identity; the public sponsor route never accepts this field. */
    reservationId?: Intent extends KeyedSponsorIntent ? string : never;
  }>;
}[SponsorIntent];

/** The caller's own signing wallet: the account's embedded wallet, or the session's address. */
async function callerWallet(
  wallets: Pick<PresaleEmbeddedWallets, "require">,
  caller: SponsorCaller,
): Promise<string> {
  return caller.kind === "privy" ? wallets.require(caller.did) : caller.address;
}

/**
 * One kind to sponsor: the caller, its own wallet as the sender (the Privy
 * account's embedded wallet, or the wallet session's address), the kind's
 * canonical BCS bytes, the intent with its presale, and the caller's client
 * IP (`clientIp`; `presale_sponsor_ip` counts it).
 */
export type SponsorKindRequest = SponsorTarget &
  Readonly<{
    caller: SponsorCaller;
    sender: string;
    kindBytes: Uint8Array;
    ip: string;
    signal?: AbortSignal;
  }>;

/** `accountKey` is `sponsorAccountKey(caller)`. */
export type RecoverBridgeWithdrawal = Readonly<{ reservationId: string; accountKey: string; sender: string }>;

/** Only authenticated server workflows supply this durable identity, never the public HTTP sponsor route. */
async function recoverBridgeWithdrawal(reservations: SponsorReservationStore, request: RecoverBridgeWithdrawal): Promise<SponsorResponse | null> {
  if (!reservations.completed) throw new PresaleRouteError("service_unavailable");
  const retained = await reservations.completed(request.reservationId);
  if (!retained) {
    if (!reservations.budgetAttempt) throw new PresaleRouteError("service_unavailable");
    const attempt = await reservations.budgetAttempt(request.reservationId);
    if (attempt?.state === "refused" && attempt.refusalReason) throw new KeyedSponsorRefusal(attempt.refusalReason);
    if (attempt) throw new PresaleRouteError("service_unavailable", { retryAfterSeconds: 60 });
    return null;
  }
  if (retained.privyDid !== request.accountKey || retained.sender !== request.sender || retained.presaleId !== null || retained.intent !== "bridge_withdraw")
    throw new PresaleRouteError("target_not_allowed");
  return { reservation_id: retained.id, transaction_bytes: toBase64(retained.txBytes), sponsor_signature: "", expires_at_ms: retained.expiresAt.getTime(), gas_budget: `${retained.gasBudget}` };
}

export type PresaleSponsorService = Readonly<{
  /** Recover first bytes before fresh balance, object, fee or deployment checks. Caller already proves the wallet. */
  recoverBridgeWithdrawal(request: RecoverBridgeWithdrawal): Promise<SponsorResponse | null>;
  /**
   * Steps 3 to 12 of the route below; throws its `PresaleRouteError`s. Every
   * caller uses the IP request rate and any daily limits for its intent
   * (step 9b), counted only once the kind passed the policy and the dry run.
   */
  sponsor(request: SponsorKindRequest): Promise<SponsorResponse>;
  /**
   * `sponsor` for a swap-and-commit the commit route built itself from an
   * account's sealed quote: every check but the presale target policy, which
   * admits only `PRESALE_SPONSOR_SWAP_TARGETS` and so refused the aggregator's
   * own route (its router and each DEX adapter it picks). Server-built kinds
   * trust the server across contracts, as trades do. Everything else stays the
   * commit's: its pause bit, daily limit, gross gas and net-storage caps (real
   * routes measured well inside them on mainnet, 2026-11-20). In-process only:
   * the public route has no way to ask for it.
   */
  sponsorServerCommit(request: Extract<SponsorKindRequest, { intent: "commit" }>): Promise<SponsorResponse>;
}>;

/** Step 9b's budgets, in order; the first full one refuses and the later ones are not counted. */

/**
 * Step 9b (review H1, M1): counts one reservation in the sponsor's shared
 * budgets: the client IP (unless the HTTP route's kit already counted it
 * before the body), then the account and platform daily limits for intents
 * governed by them. It runs after the policy and the dry run, so a request refused for
 * its body, its target or its simulation never spends the platform's budget,
 * and before the slot is claimed. A full budget
 * is `rate_limited` with its `Retry-After`; a limiter that cannot answer
 * throws, which the callers treat as unavailable (fail closed).
 */
async function countSponsorBudgets(
  limits: Pick<RateLimitPort, "consume">,
  request: Pick<SponsorKindRequest, "caller" | "ip" | "intent">,
  ipCounted: boolean,
): Promise<void> {
  if (!ipCounted) {
    await countSponsorBudget(limits, "presale_sponsor_ip", { ip: request.ip });
  }
  if (!hasDailySponsorshipLimit(request.intent)) {
    return;
  }
  await countSponsorBudget(limits, "presale_sponsor_account_daily", {
    accountId: sponsorAccountKey(request.caller),
  });
  await countSponsorBudget(limits, "presale_sponsor_global", {});
}

async function countSponsorBudget(
  limits: Pick<RateLimitPort, "consume">,
  bucket: PresaleRateBucket,
  subject: RateLimitSubject,
): Promise<void> {
  const decision = await limits.consume(bucket, subject);
  if (!decision.allowed) {
    recordPresaleMetric("presale.sponsor", {
      outcome: "budget_refused",
      bucket,
    });
    throw new DefiniteSponsorBudgetRefusal(bucket, decision.retryAfterSeconds);
  }
}

class DefiniteSponsorBudgetRefusal extends PresaleRouteError<"rate_limited"> {
  readonly bucket: PresaleRateBucket;
  constructor(bucket: PresaleRateBucket, retryAfterSeconds: number) {
    super("rate_limited", { retryAfterSeconds });
    this.bucket = bucket;
  }
}

/**
 * Sponsoring one kind, steps 3 to 12 of `POST /api/presale/sponsor` (below),
 * for the HTTP route and for the social swap path (social feed R3-31), which
 * calls it in-process with the `trade` intent and a kind it built itself from
 * the quote it pinned. Server-built trades accept any contract; the public
 * sponsor route never accepts the trade intent. Trades and withdrawals use
 * the request rate and open-reservation limits without a daily limit.
 */
export function createSponsorService(
  dependencies: PresaleSponsorServiceDependencies,
): PresaleSponsorService {
  const sponsor = sponsorKind(dependencies);
  return Object.freeze({
    recoverBridgeWithdrawal: (request: RecoverBridgeWithdrawal) => recoverBridgeWithdrawal(dependencies.reservations, request),
    sponsor: (request: SponsorKindRequest) =>
      sponsor(request, { ipCounted: false }),
    sponsorServerCommit: (request: Extract<SponsorKindRequest, { intent: "commit" }>) =>
      sponsor(request, { ipCounted: false, serverBuilt: true }),
  });
}

/** What the target policy reads for one call. */
type PolicyInputs = Readonly<{
  dependencies: PresaleSponsorServiceDependencies;
  body: SponsorKindRequest;
  kind: SponsorTransactionKind;
  config: ReturnType<PresaleSponsorServiceDependencies["config"]>;
  presalePackageId: string;
  vaultPackageId: string;
  migratorsPackageId: string;
  burnIds: ReturnType<typeof suiBurnIds> | null;
  /** The commit route built this commit from a sealed quote (`sponsorServerCommit`). */
  serverBuilt: boolean;
  signal: AbortSignal | undefined;
}>;

/** A keyed bridge withdrawal's retained answer, recovered before any external work. */
async function retainedReservation(
  dependencies: PresaleSponsorServiceDependencies,
  request: SponsorKindRequest,
): Promise<SponsorResponse | null> {
  if (request.reservationId === undefined) return null;
  if (!recoversByKey(request.intent) || !dependencies.reservations.completed || !dependencies.reservations.beginBudgetAttempt || !dependencies.reservations.budgetAttempt || !dependencies.reservations.refuseBudgetAttempt)
    throw new PresaleRouteError("service_unavailable");
  // The route bound this id to immutable facts before external work.
  return recoverBridgeWithdrawal(dependencies.reservations, { reservationId: request.reservationId, accountKey: sponsorAccountKey(request.caller), sender: request.sender });
}

/** Step 5: the intent's target policy. Server-built kinds (`trusted`, and `sponsorServerCommit`'s) never reach the public route. */
async function policyDecision(inputs: PolicyInputs) {
  const { body, kind, burnIds } = inputs;
  if (!namesPresale(body.intent) && body.presaleId !== null) {
    return refusal(`intent ${body.intent} names no presale`);
  }

  // A server-built swap-and-commit (`sponsorServerCommit`) is trusted like a trade.
  if (inputs.serverBuilt && body.intent === "commit") return { allowed: true as const };
  const policy = sponsorPolicyKind(body.intent);
  switch (policy) {
    case "trusted":
      return { allowed: true as const };
    case "bridge_withdraw":
      return burnIds
        ? evaluateBridgeWithdrawPolicy({ kind, sender: body.sender, ids: burnIds })
        : refusal("the identity names no Sui CCTP V2 burn");
    case "withdraw":
      return evaluateWithdrawPolicy({ kind, sender: body.sender });
    case "presale":
      return isPresaleCall(body)
        ? presaleDecision(inputs, body.presaleId, body.intent)
        : refusal("a presale intent names no presale");
    default:
      return policy satisfies never;
  }
}

function isPresaleCall(
  call: SponsorKindRequest,
): call is Extract<SponsorKindRequest, { presaleId: string }> {
  return namesPresale(call.intent) && call.presaleId !== null;
}

function refusal(reason: string) {
  return { allowed: false as const, code: "target_not_allowed" as const, reason };
}

async function presaleDecision(inputs: PolicyInputs, presaleId: string, intent: PresaleSponsorIntent) {
  const { dependencies, body, kind, config, presalePackageId, vaultPackageId, migratorsPackageId, signal } = inputs;
  const creator =
    intent === "claim"
      ? creatorSponsorTarget(kind, { presale: presalePackageId, vault: vaultPackageId, migrators: migratorsPackageId })
      : null;
  if (creator) {
    const expected = await dependencies.chain.creatorKind?.(
      presaleId,
      creator.vaultId,
      body.sender,
      creator.kind,
      signal,
    );
    const matches =
      expected !== undefined &&
      expected !== null &&
      Buffer.from(expected).equals(
        Buffer.from(bcs.TransactionKind.serialize(kind).toBytes()),
      );
    return matches
      ? { allowed: true as const }
      : {
          allowed: false as const,
          code: "target_not_allowed" as const,
          reason:
            "creator action differs from its authorized SDK transaction",
        };
  }

  const types = await dependencies.chain.presaleTypes(presaleId, {
    signal,
  });
  const rounds =
    types && intent === "reward_claim"
      ? await dependencies.chain.rewardRounds(
          referencedRewardRounds(kind, vaultPackageId),
          { signal },
        )
      : [];
  // P-13: a vested share's claim rides the `claim` intent; the policy pins it to schedules paying the sender.
  const schedules =
    types && intent === "claim" ? referencedVestingSchedules(kind) : [];
  const vestingSchedules =
    schedules.length > 0
      ? await dependencies.chain.vestingSchedules(schedules, { signal })
      : [];
  return types
    ? evaluateSponsorPolicy({
        kind,
        intent,
        presaleId,
        sender: body.sender,
        facts: {
          presalePackageId,
          vaultPackageId,
          ...types,
          rewardRounds: rounds,
          swapTargets: config.swapTargets,
          vestingSchedules,
          commitSwapFee:
            intent === "commit" &&
            kind.ProgrammableTransaction?.commands.some(
              (command) =>
                command.MoveCall &&
                ![presalePackageId, normalizeSuiAddress("0x2")].includes(
                  normalizeSuiAddress(command.MoveCall.package),
                ),
            )
              ? config.tradeFee()
              : null,
        },
      })
    : {
        allowed: false as const,
        code: "target_not_allowed" as const,
        reason: "presale is not a presale of this deployment",
      };
}

/**
 * A keyed withdrawal's durable first budget attempt: null when this call is the first. A repeat
 * returns the retained answer when the first completed.
 */
async function firstKeyedBudgetAttempt(
  dependencies: PresaleSponsorServiceDependencies,
  request: SponsorKindRequest,
  reservationId: string,
  at: Date,
): Promise<SponsorResponse | null> {
  if (await dependencies.reservations.beginBudgetAttempt!(reservationId, at)) return null;
  const completed = await retainedReservation(dependencies, request);
  if (completed) return completed;
  // Cross-store consumption may have happened before a crash. Never
  // guess, recount or refund: this identity needs reconciliation unless
  // its original owner completes the atomic reservation below.
  recordPresaleMetric("presale.sponsor", { outcome: "reconciliation_required", intent: request.intent });
  throw new PresaleRouteError("service_unavailable", { retryAfterSeconds: 60 });
}

/** Step 9b's shared budgets. A keyed withdrawal records a definite refusal before it answers. */
async function countBudgets(
  dependencies: PresaleSponsorServiceDependencies,
  request: SponsorKindRequest,
  ipCounted: boolean,
  clock: () => Date,
): Promise<void> {
  try {
    await countSponsorBudgets(dependencies.limits, request, ipCounted);
  } catch (error) {
    if (request.reservationId !== undefined && error instanceof DefiniteSponsorBudgetRefusal) {
      await dependencies.reservations.refuseBudgetAttempt!(request.reservationId, error.bucket as SponsorBudgetRefusal, clock());
      throw new KeyedSponsorRefusal(error.bucket as SponsorBudgetRefusal);
    }
    // A thrown limiter error leaves consumption ambiguous; never reset or recount it.
    throw error;
  }
}

/** A keyed withdrawal whose slot claim failed records the refusal, so its identity never retries the budgets. */
async function requireKeyedClaim(
  dependencies: PresaleSponsorServiceDependencies,
  reservationId: string,
  status: Awaited<ReturnType<SponsorReservationStore["claim"]>>["status"],
  clock: () => Date,
): Promise<void> {
  if (status === "claimed") return;
  const reason = status === "full" ? "open_reservations" : "claim_busy";
  await dependencies.reservations.refuseBudgetAttempt!(reservationId, reason, clock());
  throw new KeyedSponsorRefusal(reason);
}

/** Count a policy refusal (best effort) and refuse the target. */
async function refuseTarget(
  dependencies: PresaleSponsorServiceDependencies,
  intent: SponsorIntent,
  reason: string,
  clock: () => Date,
): Promise<never> {
  recordPresaleMetric("presale.sponsor", {
    outcome: "target_not_allowed",
    intent,
  });
  await dependencies.reservations
    .countRefusal(reason, clock())
    .catch(() => {
      recordPresaleMetric("presale.sponsor", {
        outcome: "refusal_count_failed",
      });
    });
  throw new PresaleRouteError("target_not_allowed");
}

/** Step 7: fewer than the daily execution limit, until UTC midnight. */
async function requireDailyExecution(
  dependencies: PresaleSponsorServiceDependencies,
  accountKey: string,
  checkedAt: Date,
): Promise<void> {
  if ((await dependencies.executions.today(accountKey)).allowed) return;
  throw new PresaleRouteError("budget_exceeded", {
    extra: { reason: "daily_limit" },
    now: checkedAt,
  });
}

/** Step 10's outcomes: a refused keyed claim is recorded; a full or busy slot refuses. */
async function requireClaimed(
  dependencies: PresaleSponsorServiceDependencies,
  reservationId: string | undefined,
  claim: SponsorClaimResult,
  claimedAt: Date,
  clock: () => Date,
): Promise<Extract<SponsorClaimResult, { status: "claimed" }>> {
  if (reservationId !== undefined) await requireKeyedClaim(dependencies, reservationId, claim.status, clock);
  if (claim.status === "full")
    throw openCapExceeded(claim.nextExpiry, claimedAt);
  // Another request of this account held the claim lock past the lock timeout (B-005).
  if (claim.status === "busy") throw openReservationsBusy();
  return claim;
}

/**
 * The service's one implementation. `ipCounted` is the HTTP route's alone:
 * its kit counts `presale_sponsor_ip` before the body (so junk from one
 * address stops before any read), and the count here would double it. An
 * in-process caller (the social swap and withdraw paths) never sets it.
 */
function sponsorKind(dependencies: PresaleSponsorServiceDependencies) {
  const clock = dependencies.clock ?? (() => new Date());
  return async function sponsor(
    request: SponsorKindRequest,
    options: Readonly<{ ipCounted: boolean; serverBuilt?: true }>,
  ): Promise<SponsorResponse> {
    const did = sponsorAccountKey(request.caller);
    const { signal } = request;
    const body = request;

    if ((await callerWallet(dependencies.wallets, request.caller)) !== body.sender)
      throw new PresaleRouteError("not_embedded_wallet");

    const retained = await retainedReservation(dependencies, request);
    if (retained) return retained;

    const identity = dependencies.authorizeSigning
      ? await dependencies.authorizeSigning(body.intent, signal)
      : await dependencies.deployment.authorize({ signal });

    const kind = decodeKind(body.kindBytes);
    const config = dependencies.config();
    const presalePackageId = normalizeSuiAddress(identity.presale.packageId);
    const vaultPackageId = normalizeSuiAddress(identity.presale.vault.packageId);
    const migratorsPackageId = normalizeSuiAddress(identity.presale.migrators.packageId);
    const burnIds =
      sponsorPolicyKind(body.intent) === "bridge_withdraw" ? suiBurnIds(identity.cctp) : null;
    const decision = await policyDecision({ dependencies, body, kind, config, presalePackageId, vaultPackageId, migratorsPackageId, burnIds, serverBuilt: options.serverBuilt === true, signal });
    if (!decision.allowed) await refuseTarget(dependencies, body.intent, decision.reason, clock);

    // Step 6 here refuses early, before simulation; the claim rechecks it under the account's lock (Q-001).
    const checkedAt = clock();
    const open = await dependencies.reservations.open(did, checkedAt);
    if (open.count >= MAX_OPEN_SPONSOR_RESERVATIONS)
      throw openCapExceeded(open.nextExpiry, checkedAt);

    if (hasDailySponsorshipLimit(body.intent)) await requireDailyExecution(dependencies, did, checkedAt);

    const cap = config.maxGasMist;
    const { price, epoch } = await dependencies.chain.gasContext({ signal });
    const expiration = {
      epoch,
      chain: identity.chainIdentifier,
      nonce: randomInt(2 ** 32),
    };
    const build = (budget: bigint) =>
      transactionData({
        kind,
        sender: body.sender,
        owner: config.sponsorAddress,
        price,
        budget,
        expiration,
      });
    const simulation = await dependencies.chain.simulate(build(cap), {
      signal,
    });
    const presalePackages = new Set([
      presalePackageId,
      normalizeSuiAddress(identity.presale.originalPackageId),
    ]);
    const budget = gasBudget(simulation, presalePackages, cap, capsNetStorage(body.intent));

    if (request.reservationId !== undefined) {
      const completed = await firstKeyedBudgetAttempt(dependencies, request, request.reservationId, clock());
      if (completed) return completed;
    }
    // Step 9b: the shared budgets, only now that the kind is allowed and simulates within the cap.
    await countBudgets(dependencies, request, options.ipCounted, clock);

    // Legacy flows claim and complete in separate short writes. A keyed
    // withdrawal stores its reservation, bytes and budget completion atomically.
    // Nothing is reserved elsewhere: the sponsor address balance pays at execute.
    const claimedAt = clock();
    const transactionBytes = build(budget);
    const expiresAt = new Date(claimedAt.getTime() + SPONSOR_RESERVATION_SECONDS * 1_000 - SPONSOR_EXPIRY_MARGIN_MS);
    const completion = { txBytes: transactionBytes, digest: TransactionDataBuilder.getDigestFromBytes(transactionBytes), expiresAt };
    const claimResult = await dependencies.reservations.claim(
      {
        privyDid: did,
        sender: body.sender,
        presaleId: body.presaleId,
        intent: body.intent,
        ...(identity.manifest && { deploymentFingerprint: deploymentFingerprint(identity.manifest) }),
        gasBudget: budget,
        ...sponsorClaimWindow(claimedAt),
        ...(request.reservationId === undefined ? {} : { id: request.reservationId, completion }),
      },
      claimedAt,
    );
    const claim = await requireClaimed(dependencies, request.reservationId, claimResult, claimedAt, clock);

    // Keyed workflows insert the bytes with the reservation. A crash cannot leave
    // an ambiguous gas reservation before its bytes are durable. There is no external
    // gas reservation: the sponsor address balance pays only when execute runs.
    if (request.reservationId === undefined) {
      await dependencies.reservations.complete(claim.id, completion, clock());
    }
    recordPresaleMetric("presale.sponsor", {
      outcome: "reserved",
      intent: body.intent,
    });
    return {
      reservation_id: claim.id,
      transaction_bytes: toBase64(transactionBytes),
      sponsor_signature: "",
      expires_at_ms: expiresAt.getTime(),
      gas_budget: `${budget}`,
    };
  };
}

/**
 * `POST /api/presale/sponsor`: full transaction bytes for the caller's own
 * wallet (a Privy account's embedded wallet, or an outside wallet's sign-in
 * session), with Blast's sponsor as gas owner and an empty payment: the
 * sponsor's address balance pays. The checks run in order and the first failure answers:
 *
 * 1. the Privy token or the wallet session cookie (kit: `unauthorized`) and
 *    buckets `presale_sponsor_ip` and `presale_sponsor` (per IP and per
 *    account, before the body);
 * 2. the body (exact keys; kind at most 16 KiB);
 * 3. `sender` is the caller's own wallet (`not_embedded_wallet`);
 * 4. the deployment identity against the node;
 * 5. the target policy over chain facts (`target_not_allowed`, counted per hour);
 *    a `withdraw` (no presale) passes the withdraw policy instead, which reads none;
 * 6. at most two open reservations (`budget_exceeded`), rechecked when the
 *    slot is claimed;
 * 7. fewer than 100 executions today for capped intents (`budget_exceeded` until UTC midnight);
 * 8. simulation with the sponsor's gas (`dry_run_failed`);
 * 9. the budget within the cap (`gas_cap_exceeded`);
 * 9b. the shared budgets, counted only now (`rate_limited`): the client IP's
 *    (counted by the kit in step 1 for this route), then the daily limits
 *    for capped intents (`countSponsorBudgets`);
 * 10. a `reserving` row claims the slot under the account's lock;
 * 11. the transaction bytes (`ValidDuring` this epoch or the next);
 * 12. the row completed to `reserved`.
 *
 * The web app signs nothing: the sponsor service co-signs at execute. Steps 3
 * to 12 are `createSponsorService`; the body never names `trade`.
 */
export function createPresaleSponsorRoute(
  dependencies: PresaleSponsorDependencies,
): (request: Request, client: ClientAddress) => Promise<Response> {
  const sponsor = sponsorKind(dependencies);
  return dependencies.kit.route(
    {
      name: "POST /api/presale/sponsor",
      auth: "account_or_wallet",
      // Per client IP, then per account, before the body (WP3). The account's daily share and the
      // platform's daily cap count in step 9b, after the dry run (review H1).
      bucket: ["presale_sponsor_ip", "presale_sponsor"],
      deployment: "none",
    },
    async (context) => {
      const caller = routeSponsorCaller(context);
      if (!caller) throw new PresaleRouteError("unauthorized");
      const body = parseSponsorRequest(
        await readJsonBody(context.request, { maxBytes: BODY_LIMIT_BYTES }),
      );
      return context.json(
        await sponsor(
          {
            caller,
            ...body,
            ip: context.client.rateKey,
            signal: context.request.signal,
          },
          { ipCounted: true },
        ),
      );
    },
  );
}
