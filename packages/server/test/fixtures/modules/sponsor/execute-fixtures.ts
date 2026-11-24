/**
 * Test-only harness for `POST /api/presale/sponsor/{reservation_id}/execute`
 * (T-018): the real sui-gas-pool execute client over a fake pool, a fake
 * fullnode digest lookup that shares the pool's chain, in-memory executions
 * with the Postgres store's conditional transitions, a recorder spy, and a
 * clock that `sleep` advances. It signs nothing: tests sign as the browser.
 * Runtime code must not import it.
 */
import { bcs } from "@mysten/sui/bcs";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";

import type { RateLimitPort } from "../../../../../core/src/lib/web-security/rate-limits.ts";
import type { PresaleOutcomeRecorder } from "@blast/server/modules/presale/outcomes/recorder.ts";
import type { SponsorTransactionLookup } from "@blast/server/modules/sponsor/chain.ts";
import {
  createPresaleSponsorExecuteRoute,
  type PresaleSponsorExecuteDependencies,
} from "@blast/server/modules/sponsor/execute.ts";
import { createSponsorSignatureVerifier } from "@blast/server/modules/sponsor/signature.ts";
import type {
  SponsorExecutionRow,
  SponsorExecutionStore,
} from "@blast/server/modules/sponsor/executions.ts";
import {
  kindOf,
  PRESALE_ID,
  sdkCommit,
} from "../../../../../core/test/fixtures/modules/sponsor/fixtures.ts";
import {
  createSuiGasPoolExecutor,
  type SponsorExecutionEffects,
} from "@blast/server/modules/sponsor/pool-execute.ts";
import {
  CLOCK,
  fixtureKit,
  MemoryLimiter,
  ORIGIN,
  SPONSOR,
  token,
} from "./route-fixtures.ts";

/** Fixed net gas parts: 1,000,000 + 2,000,000 − 980,000. */
export const GAS = {
  computationCost: "1000000",
  storageCost: "2000000",
  storageRebate: "980000",
  nonRefundableStorageFee: "9880",
};
export const NET_GAS_USED = "2020000";

/** sui-gas-pool's `SuiTransactionBlockEffects` JSON for `digest`. */
export function poolEffects(digest: string, status: "success" | "failure") {
  return {
    messageVersion: "v1",
    status:
      status === "success"
        ? { status }
        : {
            status,
            error:
              "MoveAbort(MoveLocation { module: blast_presale }, 25) in command 0",
          },
    executedEpoch: "812",
    gasUsed: GAS,
    transactionDigest: digest,
    mutated: [],
    gasObject: {
      owner: { AddressOwner: SPONSOR },
      reference: { objectId: `0x${"c7".repeat(32)}`, version: 42, digest },
    },
    dependencies: [],
  };
}

/**
 * A fake sponsor service `POST /v1/execute`.
 * - `success` / `failure`: executes and answers effects with that status;
 * - `sent_then_timeout`: executes (the digest lands on the chain), then never answers;
 * - `timeout`: never answers and executes nothing;
 * - `pool_error`: the pool's error envelope, nothing executed;
 * - `wrong_digest`: executes, but answers another digest's effects.
 * `delayMs` holds every answer, so concurrent requests interleave.
 */
export function fakeExecutePool(
  options: {
    mode?:
      | "success"
      | "failure"
      | "sent_then_timeout"
      | "timeout"
      | "pool_error"
      | "wrong_digest";
    delayMs?: number;
  } = {},
) {
  const state = {
    mode: options.mode ?? "success",
    delayMs: options.delayMs ?? 5,
    submissions: [] as {
      raw: string;
      authorization: string | null;
      body: { tx_bytes: string; user_sig: string };
    }[],
    /** The chain: what the fullnode knows, by digest. */
    chain: new Map<string, SponsorExecutionEffects>(),
    lookups: 0,
  };
  const hang = (signal: AbortSignal | null | undefined) =>
    new Promise<Response>((_, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const raw = String(init?.body);
    const body = JSON.parse(raw) as { tx_bytes: string; user_sig: string };
    state.submissions.push({
      raw,
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    });
    await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    const digest = TransactionDataBuilder.getDigestFromBytes(
      fromBase64(body.tx_bytes),
    );
    const status = state.mode === "failure" ? "failure" : "success";
    if (state.mode === "timeout") return hang(init?.signal);
    if (state.mode === "pool_error")
      return Response.json(
        { error: "the gas payment must be empty (address balance)" },
        { status: 400 },
      );
    state.chain.set(digest, { digest, status, gasUsed: BigInt(NET_GAS_USED) });
    if (state.mode === "sent_then_timeout") return hang(init?.signal);
    const answered =
      state.mode === "wrong_digest"
        ? "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"
        : digest;
    return Response.json({ effects: poolEffects(answered, status) });
  };
  const executor = createSuiGasPoolExecutor({
    url: "http://127.0.0.1:9527",
    token: "pool-fixture-token",
    fetch,
    timeoutMs: 50,
  });
  const lookup: SponsorTransactionLookup = {
    async effects(digest) {
      state.lookups += 1;
      return state.chain.get(digest) ?? null;
    },
  };
  return { state, executor, lookup };
}

/** In-memory executions with the Postgres store's conditional transitions (no await between check and write). */
export function memoryExecutions() {
  type Stored = SponsorExecutionRow & { completedAt: Date | null };
  const rows: Stored[] = [];
  const hidden = new Set<string>();
  const store: SponsorExecutionStore = {
    async find(id, privyDid) {
      const row = rows.find(
        (candidate) => candidate.id === id && candidate.privyDid === privyDid,
      );
      return row && !hidden.has(id) ? { ...row } : null;
    },
    async submit(id, privyDid, now) {
      const row = rows.find(
        (candidate) => candidate.id === id && candidate.privyDid === privyDid,
      );
      if (!row || row.state !== "reserved" || row.expiresAt <= now)
        return false;
      Object.assign(row, { state: "submitted", submittedAt: now });
      return true;
    },
    async expire(id, privyDid, now) {
      const row = rows.find(
        (candidate) => candidate.id === id && candidate.privyDid === privyDid,
      );
      if (!row || row.state !== "reserved" || row.expiresAt > now) return false;
      Object.assign(row, { state: "expired" });
      return true;
    },
    async revoke(id, privyDid) {
      const row = rows.find(
        (candidate) => candidate.id === id && candidate.privyDid === privyDid,
      );
      if (!row || row.state !== "reserved") return false;
      Object.assign(row, { state: "expired" });
      return true;
    },
    async settle(id, outcome, now) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || (row.state !== "submitted" && row.state !== "unconfirmed"))
        return false;
      Object.assign(row, {
        state: outcome.status === "success" ? "executed" : "failed_execution",
        outcome,
        completedAt: now,
      });
      return true;
    },
    async unconfirm(id, now) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || row.state !== "submitted") return false;
      Object.assign(row, { state: "unconfirmed", completedAt: now });
      return true;
    },
  };
  /** A `reserving` or `reservation_failed` row: stored, but never returned to execute. */
  const hide = (id: string) => hidden.add(id);
  return { rows, store, hide };
}

/** A clock that only `sleep` moves. */
export function fakeClock(start = new Date(CLOCK.getTime() + 5_000)) {
  let now = start.getTime();
  return {
    clock: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
    sleep: async (ms: number) => {
      now += ms;
      // A little real time too, so a fake pool's answer can land while a waiter polls.
      await new Promise((resolve) => setTimeout(resolve, 2));
    },
  };
}

/** Real time, `factor` times faster, from the sponsor fixture clock + 5 s: for requests that run concurrently. */
export function scaledClock(factor: number) {
  let start = CLOCK.getTime() + 5_000;
  const realStart = Date.now();
  return {
    clock: () => new Date(start + (Date.now() - realStart) * factor),
    advance: (ms: number) => {
      start += ms;
    },
    sleep: (ms: number) =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(1, ms / factor)),
      ),
  };
}

/** The `TransactionData` bytes a reservation holds for `sender`: an SDK commit, sponsored by the fixture pool. */
export async function sponsoredBytes(
  sender: string,
  presaleId = PRESALE_ID,
): Promise<Uint8Array> {
  const kind = await kindOf(
    sdkCommit("open", { recipient: sender, presaleId }),
    { sender },
  );
  return bcs.TransactionData.serialize({
    V1: {
      kind,
      sender,
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
}

let rowNumber = 0;

/** A completed (`reserved`) reservation row for `privyDid`, expiring 110 s after the sponsor fixture clock. */
export function reservedRow(
  input: {
    privyDid: string;
    sender: string;
    txBytes: Uint8Array;
  } & Partial<SponsorExecutionRow>,
): SponsorExecutionRow & { completedAt: null } {
  rowNumber += 1;
  return {
    id: `00000000-0000-4000-8000-${String(rowNumber).padStart(12, "0")}`,
    presaleId: PRESALE_ID,
    intent: "commit",
    digest: TransactionDataBuilder.getDigestFromBytes(input.txBytes),
    state: "reserved",
    expiresAt: new Date(CLOCK.getTime() + 110_000),
    submittedAt: null,
    outcome: null,
    completedAt: null,
    ...input,
  };
}

export function executeRequest(
  reservationId: string,
  body: unknown,
  options: { did?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(`${ORIGIN}/api/presale/sponsor/${reservationId}/execute`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token(options.did)}`,
      "content-type": "application/json",
      ...options.headers,
    },
  });
}

export function executeHarness(
  overrides: Partial<PresaleSponsorExecuteDependencies> = {},
  options: {
    mode?: NonNullable<Parameters<typeof fakeExecutePool>[0]>["mode"];
    delayMs?: number;
    limiter?: RateLimitPort;
    /** The route's clock and sleep: `fakeClock()` unless given (`scaledClock` for concurrent requests). */
    time?: ReturnType<typeof fakeClock> | ReturnType<typeof scaledClock>;
  } = {},
) {
  const limiter = options.limiter ?? new MemoryLimiter();
  const pool = fakeExecutePool({
    mode: options.mode,
    delayMs: options.delayMs,
  });
  const executions = memoryExecutions();
  const time = options.time ?? fakeClock();
  const recorded: Parameters<
    PresaleOutcomeRecorder["recordSponsoredCommit"]
  >[0][] = [];
  const background: Promise<unknown>[] = [];
  const route = createPresaleSponsorExecuteRoute({
    kit: fixtureKit(limiter),
    executions: executions.store,
    pool: () => pool.executor,
    transactions: pool.lookup,
    // Plain keys verify offline; no fixture signature carries a zkLogin proof.
    verifySignature: createSponsorSignatureVerifier(() => {
      throw new Error("The execute fixture has no node for zkLogin proofs.");
    }),
    outcomes: {
      async recordSponsoredCommit(input) {
        recorded.push(input);
        return { status: "recorded" };
      },
    },
    reserveBackground: () => {
      let available = true;
      return {
        attach(task) {
          if (!available) throw new Error("Test reservation already consumed.");
          available = false;
          background.push(task());
        },
        release() {
          available = false;
        },
      };
    },
    clock: time.clock,
    sleep: time.sleep,
    // The same limiter as the kit's: one list of counts, in order.
    limits: limiter,
    ...overrides,
  });
  /** The budget units execute consumed. */
  const consumed = () =>
    (limiter as MemoryLimiter).calls.filter(
      (bucket) => bucket === "presale_sponsor_exec",
    ).length;
  return {
    route,
    pool,
    executions,
    time,
    recorded,
    background,
    limiter,
    consumed,
  };
}
