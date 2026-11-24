import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { requestWorkSignal } from "@blast/server/lib/request-work.ts";
import { PARTNER_ADMIN_OPERATION_MS } from "@blast/core/modules/backend-api/admin-budget.ts";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import type { Pool } from "pg";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import { configuredRedis, RedisBusy } from "@blast/core/lib/redis.ts";
import { GatewayReplayError } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { partnerRecognitionNamespace } from "./recognition-namespace.ts";
import {
  withTransaction,
  type TransactionContext,
} from "@blast/core/modules/database/transaction.ts";
import {
  assertEntitlementCapacity,
  partnerCapacity,
  PartnerCapacityError,
  type PartnerCapacity,
  type Entitlement,
} from "./capacity.ts";
import {
  PartnerRecognitionStore,
  RecognitionRequestInvalid,
  RecognitionUnavailable,
  RecognitionIntegrityError,
  type RecognitionMarker,
  type RecognitionSnapshot,
} from "./recognition-store.ts";

// Separate domain from engine writer, publication and account locks; one checked-out transaction owns it.
export const PARTNER_RECOGNITION_LOCK = "4832097501130831";
const MAX_REVISION = 9_223_372_036_854_775_807n;
const PAGE_SIZE = 128;
const OPERATION_MS = 8_000;
// A verified map stays servable through primary contention for at most this long:
// longer than one full write (OPERATION_MS) plus its follow-up tick, short enough
// that a deferred trim, origin removal or fairness effect stays bounded.
const PRESERVE_MS = 30_000;
// Operator writes may wait this long for an in-progress trim or rebuild. A write
// that waited the full 5 s has ~3 s of OPERATION_MS left for its snapshots and publish.
const WRITE_LOCK_WAIT_MS = 5_000;
// Recovery makes one try until half the preservation bound has passed, then polls
// like a writer for up to this long so sustained operator writes cannot starve it.
const RECOVERY_LOCK_WAIT_MS = 1_000;
// Woken passes run at most this often, so a classify that keeps failing while Redis
// otherwise answers cannot turn request traffic into reconcile traffic.
const WAKE_FLOOR_MS = 1_000;

/** Another transaction holds the recognition lock; recovery does not queue behind it. */
export class RecognitionLockBusy extends Error {
  constructor() {
    super("Partner recognition is being updated elsewhere.");
  }
}
type KeyRow = Entitlement & { id: string; key_hash: Buffer; origins: string[] };
type RegistrySnapshot = { recognition: RecognitionSnapshot; keys: KeyRow[] };

/** Quarantine a tenant's incompatible entitlements without changing its stored policy. */
function availableKeys(
  capacity: PartnerCapacity,
  keys: readonly KeyRow[],
  previous?: readonly KeyRow[],
): KeyRow[] {
  const tenants = new Map<string, KeyRow[]>();
  for (const key of keys) {
    const group = tenants.get(key.partner_id) ?? [];
    group.push(key);
    tenants.set(key.partner_id, group);
  }
  const prior = new Map(previous?.map((key) => [key.id, key]));
  const available: KeyRow[] = [];
  for (const group of tenants.values()) {
    try {
      assertEntitlementCapacity(capacity, group);
      available.push(...group);
    } catch (error) {
      if (!(error instanceof PartnerCapacityError)) throw error;
      // Existing incompatible keys may remain or be reduced/revoked. Never issue
      // another unusable key or increase a tenant's already unsupported allowance.
      if (
        previous &&
        group.some((key) => {
          const old = prior.get(key.id);
          return (
            !old ||
            old.partner_id !== key.partner_id ||
            (key.tier !== "internal" &&
              (old.tier === "internal" ||
                key.requests_per_minute! > old.requests_per_minute!))
          );
        })
      )
        throw error;
    }
  }
  return available;
}

function nextMarker(
  marker: RecognitionMarker,
  rebuild = false,
): RecognitionMarker {
  const revision = BigInt(marker.revision);
  if (revision < 0 || revision >= MAX_REVISION)
    throw new RecognitionUnavailable();
  return {
    generation: rebuild ? randomUUID() : marker.generation,
    revision: String(revision + 1n),
  };
}
function sameMarker(
  left: RecognitionMarker | null,
  right: RecognitionMarker,
): boolean {
  return (
    left?.generation === right.generation && left.revision === right.revision
  );
}
/** Lock-free steady state accepts only an exact, untrimmed match: publication precedes COMMIT. */
export function steadyState(
  redis: RecognitionMarker | null | undefined,
  primary: RecognitionMarker | undefined,
): boolean {
  return !!primary && sameMarker(redis ?? null, primary) && !redis!.needsTrim;
}
/** A same-generation map at or ahead of the primary is a conservative, grantless superset. */
export function redisCoversPrimary(
  redis: RecognitionMarker | null | undefined,
  primary: RecognitionMarker | undefined,
): boolean {
  return (
    !!redis &&
    !!primary &&
    redis.generation === primary.generation &&
    BigInt(redis.revision) >= BigInt(primary.revision)
  );
}
/** PostgreSQL contention or connection loss: no evidence about the Redis map. */
export function primaryContention(error: unknown): boolean {
  if (error instanceof RecognitionLockBusy) return true;
  if (
    !(error instanceof Error) ||
    error instanceof RecognitionUnavailable ||
    error instanceof PartnerCapacityError
  )
    return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code))
    return code.startsWith("08") || ["55P03", "57014", "53300"].includes(code);
  if (typeof code === "string")
    return ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(code);
  return /^(timeout exceeded when trying to connect|Connection terminated unexpectedly|Connection terminated due to connection timeout|Query read timeout)$/.test(
    error.message,
  );
}
/** What one reconcile or write attempt observed and did, for its failure decision. */
type Attempt = {
  primary?: RecognitionMarker;
  redis?: RecognitionMarker | null;
  storeFailed: boolean;
  redisWritten: boolean;
};
function newAttempt(): Attempt {
  return { storeFailed: false, redisWritten: false };
}

function union(
  before: RecognitionSnapshot,
  after: RecognitionSnapshot,
): RecognitionSnapshot {
  const entries = new Map(before.entries.map((entry) => [entry.digest, entry]));
  for (const entry of after.entries) {
    const prior = entries.get(entry.digest);
    if (prior && (prior.tenant !== entry.tenant || prior.keyId !== entry.keyId))
      throw new RecognitionUnavailable();
    entries.set(entry.digest, entry);
  }
  return {
    entries: [...entries.values()],
    origins: [...new Set([...before.origins, ...after.origins])],
  };
}

/** Bounded primary/Redis scheduling coordinator. This never returns an authorization grant. */
export class PartnerRecognition {
  #readyEpoch: number | undefined;
  #reconciling: Promise<void> | undefined;
  #requestedRepair = 0n;
  #completedRepair = 0n;
  #recoveryStop: (() => Promise<void>) | undefined;
  #lastRecovery: Readonly<{ successAt?: number; failureAt?: number }> = {};
  #verifiedAt = 0;
  #nudged = false;
  #lastWokenAt = 0;
  #shortenServingSleep: ((ms: number) => void) | undefined;
  #wake: (() => void) | undefined;
  readonly #preserveMs: number;
  readonly pool: Pool;
  readonly store: PartnerRecognitionStore;
  /** `preserveMs` may only shorten PRESERVE_MS, for bounded local tests. */
  constructor(
    pool: Pool,
    store: PartnerRecognitionStore,
    options: Readonly<{ preserveMs?: number }> = {},
  ) {
    this.pool = pool;
    this.store = store;
    this.#preserveMs = Math.min(options.preserveMs ?? PRESERVE_MS, PRESERVE_MS);
  }
  ready(): boolean {
    return (
      this.#readyEpoch !== undefined &&
      this.#readyEpoch === this.store.epoch() &&
      this.#requestedRepair === this.#completedRepair
    );
  }
  invalidate(): void {
    this.#requestedRepair += 1n;
    this.#withdraw();
  }
  /** Clear readiness; a loop sleeping at serving cadence is woken once to recover. */
  #withdraw(): void {
    this.#readyEpoch = undefined;
    this.#readinessLost();
  }
  /**
   * Readiness may also lapse outside the loop (request path, health, writes, or a
   * reconnect by another user of the connection). A loop still sleeping at serving
   * cadence wakes now, or WAKE_FLOOR_MS after its last woken pass; while unready it
   * keeps its own bounded backoff.
   */
  #readinessLost(): void {
    this.#shortenServingSleep?.(
      Math.max(0, this.#lastWokenAt + WAKE_FLOOR_MS - Date.now()),
    );
  }
  /** Ask the recovery loop for a prompt pass; coalesced, and remembered if one is running. */
  nudge(): void {
    this.#nudged = true;
    this.#wake?.();
  }
  async #fromStore<T>(attempt: Attempt, operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      attempt.storeFailed = true;
      throw error;
    }
  }

  /**
   * Try-lock only: recovery gives up at once (a peer is trimming or a write is in
   * flight), so it never queues ahead of operators; writes poll up to WRITE_LOCK_WAIT_MS.
   */
  async #lock(
    transaction: TransactionContext,
    waitMs: number,
    check: () => void,
  ): Promise<void> {
    const until = Date.now() + waitMs;
    for (;;) {
      const result = await transaction.read<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked",
        [PARTNER_RECOGNITION_LOCK],
      );
      if (result.rows[0]?.locked === true) return;
      if (Date.now() >= until) throw new RecognitionLockBusy();
      // Jitter keeps polls from phase-locking with periodic writers.
      await pause(25 + Math.floor(Math.random() * 50));
      check();
    }
  }
  async #locked<T>(
    operation: (
      transaction: TransactionContext,
      marker: RecognitionMarker,
      check: () => void,
    ) => Promise<T>,
    lockWaitMs = 0,
    signal?: AbortSignal,
  ): Promise<T> {
    const deadline = Date.now() + OPERATION_MS;
    const check = () => {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new RecognitionUnavailable();
    };
    return withTransaction(
      this.pool,
      async (transaction) => {
        await this.#lock(transaction, lockWaitMs, check);
        check();
        const result = await transaction.read<RecognitionMarker>(
          "SELECT generation::text, revision::text FROM partner_api_recognition WHERE singleton = true FOR UPDATE",
        );
        if (result.rows.length !== 1) throw new RecognitionUnavailable();
        return operation(transaction, result.rows[0], check);
      },
      {
        signal,
        label: "partner.recognition",
        retry: false,
        timeouts: {
          lockTimeoutMs: 1_000,
          statementTimeoutMs: 2_000,
          idleInTransactionMs: 2_000,
        },
      },
    );
  }

  async #snapshot(
    transaction: TransactionContext,
    check: () => void,
    previous?: RegistrySnapshot,
  ): Promise<RegistrySnapshot> {
    const rows: KeyRow[] = [];
    let cursor: string | null = null;
    for (;;) {
      check();
      const result: { rows: KeyRow[] } = await transaction.read<KeyRow>(
        `SELECT k.id::text, k.key_hash, k.partner_id, k.tier, k.requests_per_minute, p.origins
         FROM partner_api_keys k JOIN partner_api_partners p ON p.id = k.partner_id
         WHERE k.revoked_at IS NULL AND ($1::uuid IS NULL OR k.id > $1::uuid)
         ORDER BY k.id LIMIT $2`,
        [
          cursor,
          Math.min(PAGE_SIZE, this.store.capacity.maxEntries - rows.length + 1),
        ],
      );
      rows.push(...result.rows);
      if (rows.length > this.store.capacity.maxEntries)
        throw new PartnerCapacityError();
      if (result.rows.length < PAGE_SIZE) break;
      cursor = result.rows[result.rows.length - 1].id;
    }
    const eligible = availableKeys(this.store.capacity, rows, previous?.keys);
    const entries = eligible.map((row) => ({
      digest: this.store.digest(row.key_hash),
      tenant: row.partner_id,
      keyId: row.id,
      keyRequestsPerMinute: this.store.capacity.tenants.find(
        (tenant) => tenant.id === row.partner_id,
      )!.keyRequestsPerMinute,
    }));
    const origins = [
      ...new Set(
        eligible
          .filter((row) => row.tier !== "internal")
          .flatMap((row) => row.origins),
      ),
    ];
    const snapshot = { entries, origins };
    this.#assertSize(snapshot);
    check();
    return { recognition: snapshot, keys: rows };
  }
  #assertSize(snapshot: RecognitionSnapshot): void {
    const bytes =
      snapshot.entries.reduce(
        (total, entry) =>
          total +
          64 +
          Buffer.byteLength(
            JSON.stringify([
              entry.tenant,
              entry.keyId,
              entry.keyRequestsPerMinute,
            ]),
          ),
        0,
      ) +
      snapshot.origins.reduce(
        (total, origin) => total + Buffer.byteLength(origin),
        0,
      );
    if (
      snapshot.entries.length > this.store.capacity.maxEntries ||
      snapshot.origins.length > this.store.capacity.maxOrigins ||
      bytes > this.store.capacity.maxBytes
    )
      throw new PartnerCapacityError();
  }
  async #saveMarker(
    transaction: TransactionContext,
    marker: RecognitionMarker,
  ): Promise<void> {
    const result = await transaction
      .forModule("partner-api-keys")
      .write(
        "partner_api_recognition",
        "UPDATE partner_api_recognition SET generation = $1::uuid, revision = $2::bigint WHERE singleton = true",
        [marker.generation, marker.revision],
      );
    if (result.rowCount !== 1) throw new RecognitionUnavailable();
  }

  reconcile(): Promise<void> {
    this.#reconciling ??= this.#reconcile().finally(() => {
      this.#reconciling = undefined;
    });
    return this.#reconciling;
  }
  async #reconcile(): Promise<void> {
    const repair = this.#requestedRepair;
    let epoch: number;
    try {
      epoch = await this.store.connect();
    } catch (error) {
      if (!(error instanceof RedisBusy)) this.#withdraw();
      throw error;
    }
    const force = repair !== this.#completedRepair;
    const attempt = newAttempt();
    try {
      if (force || !(await this.#observe(attempt, epoch))) {
        if (!force && this.#servableWhileTrimming(attempt, epoch, repair))
          this.#readyEpoch = epoch;
        await this.#repair(attempt, epoch, force);
      }
      if (this.store.epoch() !== epoch) throw new RecognitionUnavailable();
      this.#completedRepair = repair;
      if (this.#requestedRepair !== repair) throw new RecognitionUnavailable();
      this.#readyEpoch = epoch;
      this.#verifiedAt = Date.now();
    } catch (error) {
      if (
        !(error instanceof RedisBusy) &&
        !this.#preservable(error, attempt, epoch, repair, force)
      )
        this.#withdraw();
      throw error;
    }
  }
  /**
   * An exact marker with only a trim pending is a grantless superset. After a
   * reconnect it may serve at once while the last full verification is within the
   * bound; the trim follows, and only its success refreshes that verification.
   */
  #servableWhileTrimming(
    attempt: Attempt,
    epoch: number,
    repair: bigint,
  ): boolean {
    return (
      !!attempt.primary &&
      sameMarker(attempt.redis ?? null, attempt.primary) &&
      attempt.redis!.needsTrim === true &&
      epoch === this.store.epoch() &&
      this.#requestedRepair === repair &&
      repair === this.#completedRepair &&
      Date.now() - this.#verifiedAt <= this.#preserveMs
    );
  }
  /** One unlocked primary read, then the Redis marker. */
  async #observe(attempt: Attempt, epoch: number): Promise<boolean> {
    const result = await withTransaction(
      this.pool,
      (transaction) =>
        transaction.read<RecognitionMarker>(
          "SELECT generation::text, revision::text FROM partner_api_recognition WHERE singleton = true",
        ),
      {
        label: "partner.recognition.observe",
        retry: false,
        timeouts: { statementTimeoutMs: 1_000, idleInTransactionMs: 1_000 },
      },
    );
    if (result.rows.length !== 1) throw new RecognitionUnavailable();
    attempt.primary = result.rows[0];
    attempt.redis = await this.#fromStore(attempt, this.store.marker(epoch));
    return steadyState(attempt.redis, attempt.primary);
  }
  async #repair(
    attempt: Attempt,
    epoch: number,
    force: boolean,
  ): Promise<void> {
    await this.#locked(async (transaction, primary, check) => {
      const redis = await this.#fromStore(attempt, this.store.marker(epoch));
      attempt.primary = primary;
      attempt.redis = redis;
      if (!force && sameMarker(redis, primary) && !redis?.needsTrim) return;
      const matched = sameMarker(redis, primary);
      const next = matched && !force ? primary : nextMarker(primary, true);
      // Keep a valid conservative map while preparing; replacing it is one guarded script.
      if (!redis) {
        attempt.redisWritten = true;
        await this.#fromStore(attempt, this.store.building(next, epoch));
      }
      const { recognition: snapshot } = await this.#snapshot(
        transaction,
        check,
      );
      check();
      attempt.redisWritten = true;
      await this.#fromStore(
        attempt,
        this.store.publish(redis ?? next, next, snapshot, epoch, !redis),
      );
      if (!matched || force) await this.#saveMarker(transaction, next);
      check();
    }, this.#recoveryLockWait());
  }
  /** Zero until half the bound has passed, then at most the bound's remainder (≤ 1 s). */
  #recoveryLockWait(): number {
    const remaining = this.#preserveMs - (Date.now() - this.#verifiedAt);
    if (remaining >= this.#preserveMs / 2) return 0;
    return Math.max(0, Math.min(RECOVERY_LOCK_WAIT_MS, remaining));
  }
  /**
   * Skip clearing only for primary contention before this attempt wrote Redis, on a
   * map verified at this live epoch within the bound and at or ahead of the primary.
   * It never re-asserts readiness that another path withdrew.
   */
  #preservable(
    error: unknown,
    attempt: Attempt,
    epoch: number,
    repair: bigint,
    force: boolean,
  ): boolean {
    return (
      !force &&
      !attempt.storeFailed &&
      !attempt.redisWritten &&
      primaryContention(error) &&
      this.#readyEpoch === epoch &&
      epoch === this.store.epoch() &&
      this.#requestedRepair === repair &&
      repair === this.#completedRepair &&
      Date.now() - this.#verifiedAt <= this.#preserveMs &&
      (attempt.redis === undefined ||
        redisCoversPrimary(attempt.redis, attempt.primary))
    );
  }

  /** No implicit reconciliation/SQL in request admission. Startup/health owns reconciliation. */
  async classify(input: Parameters<PartnerRecognitionStore["classify"]>[0]) {
    const epoch = this.#readyEpoch;
    if (epoch === undefined || !this.ready()) {
      this.#readinessLost();
      throw new RecognitionUnavailable();
    }
    try {
      return await this.store.classify(input, epoch);
    } catch (error) {
      if (error instanceof RecognitionRequestInvalid)
        recordMetric("partner.recognition_request_invalid");
      else if (error instanceof RecognitionIntegrityError) this.invalidate();
      else if (
        !(error instanceof GatewayReplayError) &&
        !(error instanceof RedisBusy)
      )
        this.#withdraw();
      throw error;
    }
  }

  responseWindow(
    input: Parameters<PartnerRecognitionStore["responseWindow"]>[0],
  ) {
    if (!this.ready() || this.#readyEpoch === undefined)
      throw new RecognitionUnavailable();
    return this.store.responseWindow(input, this.#readyEpoch);
  }

  /** One process-owned recovery loop, independent of requests and health polling. */
  recoveryStatus() {
    return this.#lastRecovery;
  }
  startRecovery(): () => Promise<void> {
    if (this.#recoveryStop) return this.#recoveryStop;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = (async () => {
      let failures = 0;
      while (!stopped) {
        try {
          await this.reconcile();
          failures = 0;
          this.#lastRecovery = { ...this.#lastRecovery, successAt: Date.now() };
          recordMetric("partner.recognition_recovery", { outcome: "success" });
        } catch {
          failures++;
          this.#lastRecovery = { ...this.#lastRecovery, failureAt: Date.now() };
          recordMetric("partner.recognition_recovery", {
            outcome: "failure",
            preserved: this.ready(),
          });
        }
        if (stopped) break;
        if (this.#nudged) {
          this.#nudged = false;
          continue;
        }
        const serving = failures === 0 || this.ready();
        let woken = false;
        await new Promise<void>((resolve) => {
          let deadline = 0;
          const arm = (ms: number) => {
            clearTimeout(timer);
            deadline = Date.now() + ms;
            timer = setTimeout(resolve, ms);
            timer.unref();
          };
          this.#wake = resolve;
          arm(this.#retryDelay(failures));
          if (serving)
            this.#shortenServingSleep = (ms) => {
              if (Date.now() + ms >= deadline) return;
              woken = true;
              arm(ms);
            };
        });
        clearTimeout(timer);
        if (woken) this.#lastWokenAt = Date.now();
        this.#shortenServingSleep = undefined;
        this.#wake = undefined;
        this.#nudged = false;
      }
    })();
    this.#recoveryStop = async () => {
      stopped = true;
      clearTimeout(timer);
      this.#wake?.();
      await running;
    };
    return this.#recoveryStop;
  }
  /**
   * Serving replicas tick every 1–5 s, including after a preserved failure. An
   * unready replica retries from 100 ms, doubling to a 1 s ceiling, so recovery
   * after a Redis reconnect costs at most ~1 s plus the client's reconnect backoff.
   */
  #retryDelay(failures: number): number {
    if (failures === 0 || this.ready())
      return 1000 + Math.floor(Math.random() * 4001);
    const ceiling = Math.min(1_000, 100 * 2 ** Math.min(failures - 1, 4));
    return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
  }

  async write<T>(
    mutation: (transaction: TransactionContext) => Promise<T>,
  ): Promise<T> {
    // The optional coalesced handshake and write share one complete operation budget.
    const parent = requestWorkSignal();
    const budget = AbortSignal.timeout(PARTNER_ADMIN_OPERATION_MS);
    const signal = parent ? AbortSignal.any([parent, budget]) : budget;
    if (!this.ready()) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void this.reconcile()
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    if (!this.ready()) throw new RecognitionUnavailable();
    const epoch = this.#readyEpoch!;
    const attempt = newAttempt();
    let published = false;
    let committedOverCapacity = false;
    try {
      return await this.#locked(
        async (transaction, primary, check) => {
          const redis = await this.#fromStore(
            attempt,
            this.store.marker(epoch),
          );
          attempt.primary = primary;
          attempt.redis = redis;
          if (!sameMarker(redis, primary)) throw new RecognitionUnavailable();
          const before = await this.#snapshot(transaction, check).catch(
            (error: unknown) => {
              committedOverCapacity = error instanceof PartnerCapacityError;
              throw error;
            },
          );
          check();
          if (
            !this.ready() ||
            this.#readyEpoch !== epoch ||
            this.store.epoch() !== epoch
          )
            throw new RecognitionUnavailable();
          const result = await mutation(transaction);
          check();
          const after = await this.#snapshot(transaction, check, before);
          // Publication may precede SQL COMMIT. Preserve all committed identities/origins
          // even on deletion/revocation/rollback; these false positives never authorize.
          const candidate = union(before.recognition, after.recognition);
          this.#assertSize(candidate);
          const next = nextMarker(primary);
          attempt.redisWritten = true;
          await this.#fromStore(
            attempt,
            this.store.publish(primary, next, candidate, epoch, false, true),
          );
          published = true;
          await this.#saveMarker(transaction, next);
          check();
          return result;
        },
        WRITE_LOCK_WAIT_MS,
        signal,
      );
    } catch (error) {
      this.#afterFailedWrite(attempt, published, committedOverCapacity);
      throw error;
    }
  }
  /**
   * Before publication Redis is unchanged (operator input, candidate capacity,
   * contention, deadline). After it, Redis holds a same-generation superset that
   * recovery rebuilds. Store failures and an over-capacity committed state clear.
   */
  #afterFailedWrite(
    attempt: Attempt,
    published: boolean,
    committedOverCapacity: boolean,
  ): void {
    if (attempt.storeFailed || committedOverCapacity) {
      this.#withdraw();
      return;
    }
    if (published) return this.nudge();
    if (
      attempt.primary &&
      !sameMarker(attempt.redis ?? null, attempt.primary)
    ) {
      if (redisCoversPrimary(attempt.redis, attempt.primary)) this.nudge();
      else this.#withdraw();
    }
  }
}

const coordinators = new WeakMap<Pool, PartnerRecognition>();
export function configuredPartnerRecognition(pool: Pool): PartnerRecognition {
  const existing = coordinators.get(pool);
  if (existing) return existing;
  const redis = configuredRedis("quota");
  if (!redis) throw new RecognitionUnavailable();
  const store = new PartnerRecognitionStore(
    redis,
    partnerRecognitionNamespace(
      process.env.BLAST_PARTNER_RECOGNITION_NAMESPACE,
      quotaNamespace(process.env.BLAST_REDIS_NAMESPACE, deploymentIdentity(process.env)),
    ),
    process.env.RATE_LIMIT_SUBJECT_PEPPER ?? "",
    partnerCapacity(process.env.BLAST_PARTNER_CAPACITY_CONFIG),
  );
  const coordinator = new PartnerRecognition(pool, store);
  coordinators.set(pool, coordinator);
  return coordinator;
}
