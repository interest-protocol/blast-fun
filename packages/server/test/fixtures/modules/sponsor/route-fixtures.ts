/**
 * Test-only harness for `POST /api/presale/sponsor` (T-016): real Privy token
 * verification, the real deployment gate over a fixture node, the real
 * sui-gas-pool client over a fake pool that records reservations, a fixture
 * node for chain facts and simulation, and in-memory budgets and
 * reservations unless a test passes its own. Runtime code must not import it.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { bcs } from "@mysten/sui/bcs";
import { toBase64 } from "@mysten/sui/utils";

import { createPrivyTokenVerifier } from "../../../../../core/src/lib/privy-adapter/token-verifier.ts";
import type { RateBucket, RateLimitDecision, RateLimitPort, RateLimitSubject } from "../../../../../core/src/lib/web-security/rate-limits.ts";
import { PRESALE_ERRORS, type PresaleErrorCode } from "../../../../../core/src/modules/presale/contracts/errors.ts";
import { createPresaleValidator } from "../../../../../core/src/modules/presale/contracts/validate.ts";
import { fixtureChainNode, SUI_MAINNET_CHAIN_IDENTIFIER, presaleIdentityFixture } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate } from "../../../../../core/src/modules/presale/deployment/service.ts";
import { PresaleRouteError } from "../../../../../core/src/modules/presale/route-kit/errors.ts";
import { createPresaleRouteKit } from "../../../../../core/src/modules/presale/route-kit/route.ts";
import type { SponsorChain, SponsorSimulation } from "@blast/server/modules/sponsor/chain.ts";
import {
  CETUS_SWAP_TARGETS,
  OTHER_WALLET,
  PRESALE_ID,
  PRESALE_PACKAGE,
  QUOTE,
  ROUND_ID,
  SALE_TOKEN,
  SENDER,
  VAULT_ID,
  kindOf,
  sdkCancel,
  sdkClaim,
  sdkCommit,
  sdkRewardClaim,
  sdkSettle,
} from "../../../../../core/test/fixtures/modules/sponsor/fixtures.ts";
import { parseSwapTargets, type SponsorTransactionKind } from "../../../../../core/src/modules/sponsor/policy.ts";
import {
  MAX_OPEN_SPONSOR_RESERVATIONS,
  OPEN_SPONSOR_RESERVATION_STATES,
  type SponsorReservationClaim,
  type SponsorReservationCompletion,
  type SponsorReservationState,
  type SponsorReservationStore,
} from "@blast/server/modules/sponsor/reservations.ts";
import { createPresaleSponsorRoute, type SponsorConfig, type PresaleSponsorDependencies } from "@blast/server/modules/sponsor/service.ts";

export const ORIGIN = "https://blast.fun";
const APP_ID = "presale-sponsor-app";
const NOW_S = Math.floor(Date.now() / 1_000);
export const DID = "did:privy:presale-sponsor-alice";
export const OTHER_DID = "did:privy:presale-sponsor-bob";
export const OUTAGE_DID = "did:privy:presale-sponsor-outage";
export const WALLETLESS_DID = "did:privy:presale-sponsor-walletless";
/** Alice's linked external wallet: never sponsored. */
export const EXTERNAL_WALLET = `0x${"e1".repeat(32)}`;
export const SPONSOR = `0x${"5b".repeat(32)}`;
export const CAP = 50_000_000n;
export const RGP = 750n;
/** The fixture node's current epoch: sponsored bytes are `ValidDuring` it and the next. */
export const EPOCH = 900n;
export const CLOCK = new Date("2026-10-02T21:00:00.000Z");
export const SECONDS_TO_UTC_MIDNIGHT = 3 * 3_600;
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
export const validator = createPresaleValidator();
export const INTENTS = ["commit", "claim", "settle", "cancel", "reward_claim"] as const;

export function token(did = DID): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW_S + 3_600, iat: NOW_S - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

/** Records every count (bucket and subject); a bucket in `refuse` is full, with a Retry-After of 42 s. */
export class MemoryLimiter implements RateLimitPort {
  readonly calls: RateBucket[] = [];
  readonly subjects: RateLimitSubject[] = [];
  readonly refuse = new Set<RateBucket>();
  async consume(bucket: RateBucket, subject: RateLimitSubject = {}): Promise<RateLimitDecision> {
    this.calls.push(bucket);
    this.subjects.push(subject);
    const allowed = !this.refuse.has(bucket);
    return { allowed, bucket, policyVersion: 1, retryAfterSeconds: allowed ? 0 : 42 };
  }
}

/** The fixture identity, on the policy fixtures' presale package. */
export function identity(overrides: Record<string, unknown> = {}) {
  const base = presaleIdentityFixture();
  const presale = { ...(base.presale as Record<string, unknown>), packageId: PRESALE_PACKAGE, originalPackageId: PRESALE_PACKAGE };
  return { PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify({ ...base, presale, ...overrides }) };
}

/** P-13: vesting schedules the fixture node holds: the sender's own in the sale's token, and another wallet's. */
export const VESTING_SCHEDULE = { objectId: `0x${"70".repeat(32)}`, initialSharedVersion: "12", coinType: SALE_TOKEN, beneficiary: SENDER };
export const OTHER_VESTING_SCHEDULE = { ...VESTING_SCHEDULE, objectId: `0x${"71".repeat(32)}`, beneficiary: `0x${"e9".repeat(32)}` };

/** A fixture node: the sale's types, one reward round, two vesting schedules, a reference gas price, and a scripted simulation. */
export function fixtureChain() {
  const state = {
    simulation: { status: "success", gasUsed: { computationCost: 1_000_000n, storageCost: 2_000_000n } } as SponsorSimulation,
    simulated: [] as Uint8Array[],
    reads: 0,
  };
  const chain: SponsorChain = {
    async presaleTypes(presaleId) {
      state.reads += 1;
      return presaleId === PRESALE_ID ? { saleToken: SALE_TOKEN, quote: QUOTE } : null;
    },
    async rewardRounds(roundIds) {
      state.reads += 1;
      return roundIds.filter((id) => id === ROUND_ID).map((roundId) => ({ roundId, vaultId: VAULT_ID, vaultPresaleId: PRESALE_ID }));
    },
    async vestingSchedules(scheduleIds) {
      state.reads += 1;
      return [VESTING_SCHEDULE, OTHER_VESTING_SCHEDULE].filter((schedule) => scheduleIds.includes(schedule.objectId));
    },
    async gasContext() {
      return { price: RGP, epoch: EPOCH };
    },
    async simulate(transactionBytes) {
      state.simulated.push(transactionBytes);
      return state.simulation;
    },
  };
  return { state, chain };
}

/** The Postgres store's next-change time: a running claim's stored pool deadline, else the row's expiry. */
function nextChange(open: readonly { state: string; poolDeadline: Date; expiresAt: Date }[], now: Date): Date | null {
  const times = open.map((row) => {
    const deadline = row.poolDeadline.getTime();
    return row.state === "reserving" && deadline > now.getTime() ? deadline : row.expiresAt.getTime();
  });
  return times.length ? new Date(Math.min(...times)) : null;
}

/** In-memory reservations with the store's contract: at most two open per DID, `reserving` rows included. */
export function memoryReservations() {
  type Row = SponsorReservationClaim & Partial<SponsorReservationCompletion> & { id: string; state: SponsorReservationState };
  const rows: Row[] = [];
  const refusals = new Map<string, number>();
  const budgetAttempts = new Map<string, import("@blast/server/modules/sponsor/reservations.ts").SponsorBudgetAttempt>();
  const store: SponsorReservationStore = {
    async beginBudgetAttempt(id) {
      if (budgetAttempts.has(id)) return false;
      budgetAttempts.set(id, { state: "started", refusalReason: null });
      return true;
    },
    async budgetAttempt(id) { return budgetAttempts.get(id) ?? null; },
    async refuseBudgetAttempt(id, reason) {
      if (budgetAttempts.get(id)?.state !== "started") throw new Error("No active budget attempt");
      budgetAttempts.set(id, { state: "refused", refusalReason: reason });
    },
    async completed(id) {
      const row = rows.find((candidate) => candidate.id === id && candidate.txBytes !== undefined);
      return row ? { ...row, txBytes: row.txBytes!, digest: row.digest!, expiresAt: row.expiresAt } : null;
    },
    async open(privyDid, now) {
      const open = rows.filter((row) =>
        row.privyDid === privyDid && OPEN_SPONSOR_RESERVATION_STATES.includes(row.state as never) && row.expiresAt > now);
      return { count: open.length, nextExpiry: nextChange(open, now) };
    },
    async claim(claim, now) {
      // No await between the count and the insert: one turn of the event loop is the Postgres lock.
      const open = rows.filter((row) =>
        row.privyDid === claim.privyDid && OPEN_SPONSOR_RESERVATION_STATES.includes(row.state as never) && row.expiresAt > now);
      if (open.length >= MAX_OPEN_SPONSOR_RESERVATIONS) {
        return { status: "full", nextExpiry: nextChange(open, now) };
      }
      const id = claim.id ?? `00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, "0")}`;
      if (rows.some((row) => row.id === id)) return { status: "busy" };
      rows.push({ ...claim, ...claim.completion, id, state: claim.completion ? "reserved" : "reserving" });
      if (claim.id && claim.completion) budgetAttempts.set(id, { state: "completed", refusalReason: null });
      return { status: "claimed", id };
    },
    async complete(id, completion, now) {
      const row = rows.find((candidate) => candidate.id === id && candidate.state === "reserving" && candidate.expiresAt > now);
      if (!row) throw new Error("The sponsor reservation is no longer being reserved.");
      Object.assign(row, completion, { state: "reserved" });
    },
    async countRefusal(reason, at) {
      const key = `${at.toISOString().slice(0, 13)}|${reason}`;
      refusals.set(key, (refusals.get(key) ?? 0) + 1);
    },
  };
  /** The completed reservations: what a reader other than the cap may see. */
  const reserved = () => rows.filter((row) => row.state === "reserved");
  return { rows, reserved, refusals, store };
}

/**
 * The presale route kit with real Privy token verification (`token()`), the
 * given limiter, and the fixture deployment gate; with `walletSessions`, it
 * also signs in a wallet session's cookie.
 */
export function fixtureKit(
  limiter: RateLimitPort,
  deployment = createPresaleDeploymentGate({ environment: identity(), node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER) }),
  walletSessions?: Parameters<typeof createPresaleRouteKit>[0]["walletSessions"],
) {
  let requestId = 0;
  return createPresaleRouteKit({
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
    limiter,
    deployment,
    createRequestId: () => `req-${++requestId}`,
    ...(walletSessions ? { walletSessions } : {}),
  });
}

export function harness(
  overrides: Partial<PresaleSponsorDependencies> = {},
  options: { environment?: Record<string, string>; limiter?: RateLimitPort } = {},
) {
  const limiter = options.limiter ?? new MemoryLimiter();
  const chain = fixtureChain();
  const reservations = memoryReservations();
  const executed = new Map<string, number>();
  const node = fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER);
  const deployment = createPresaleDeploymentGate({ environment: options.environment ?? identity(), node: async () => node });
  const wallets = new Map([[DID, SENDER], [OTHER_DID, OTHER_WALLET]]);
  const kit = fixtureKit(limiter, deployment);
  const config: SponsorConfig = { sponsorAddress: SPONSOR, maxGasMist: CAP, swapTargets: parseSwapTargets(CETUS_SWAP_TARGETS), tradeFee: () => null };
  const route = createPresaleSponsorRoute({
    kit,
    deployment,
    wallets: {
      async require(did) {
        if (did === OUTAGE_DID) throw new PresaleRouteError("identity_unavailable");
        const address = wallets.get(did);
        if (!address) throw new PresaleRouteError("not_embedded_wallet");
        return address;
      },
    },
    chain: chain.chain,
    reservations: reservations.store,
    executions: { async today(did) { return { allowed: (executed.get(did) ?? 0) < 10 }; } },
    config: () => config,
    clock: () => new Date(CLOCK),
    // The same limiter as the kit's: one list of counts, in order.
    limits: limiter,
    ...overrides,
  });
  // `limiter` is the in-memory one unless the test passed its own.
  return { route, limiter: limiter as MemoryLimiter, chain, reservations, executed, node };
}

export async function kindBytes(kind: SponsorTransactionKind | Promise<SponsorTransactionKind>): Promise<string> {
  return toBase64(bcs.TransactionKind.serialize(await kind).toBytes());
}

export const commitKind = () => kindBytes(kindOf(sdkCommit("open")));

export function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/presale/sponsor`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", ...headers },
  });
}

export async function sponsorBody(overrides: Record<string, unknown> = {}) {
  return { presale_id: PRESALE_ID, sender: SENDER, transaction_kind_bytes: await commitKind(), intent: "commit", ...overrides };
}

/** Asserts the published error: status, code, closed schema, Retry-After exactly when the code has one. */
export async function assertError(response: Response, code: PresaleErrorCode): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(body.error.code, code, JSON.stringify(body));
  assert.equal(response.status, PRESALE_ERRORS[code].status);
  assert.deepEqual(validator.validate(`errors/${code}`, body).errors, []);
  const retryAfter = response.headers.get("retry-after");
  if (PRESALE_ERRORS[code].retryAfter) assert.match(retryAfter ?? "", /^[1-9][0-9]*$/, `${code} carries Retry-After`);
  else assert.equal(retryAfter, null, `${code} carries no Retry-After`);
  return body.error;
}

export function assertNothingReserved(h: ReturnType<typeof harness>, label = ""): void {
  assert.equal(h.reservations.rows.length, 0, `${label}: a slot was claimed`);
}

/** The kind each intent's SDK builder makes for the sender. */
export async function intentKind(intent: (typeof INTENTS)[number]): Promise<string> {
  switch (intent) {
    case "commit":
      return commitKind();
    case "claim":
      return kindBytes(kindOf(sdkClaim()));
    case "settle":
      return kindBytes(kindOf(sdkSettle()));
    case "cancel":
      return kindBytes(kindOf(sdkCancel()));
    case "reward_claim":
      return kindBytes(kindOf(sdkRewardClaim()));
  }
}
