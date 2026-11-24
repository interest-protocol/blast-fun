import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import type { Pool } from "pg";
import { partnerCapacity, PartnerCapacityError } from "./capacity.ts";
import { syntheticCapacity } from "./capacity.test.ts";
import {
  PartnerRecognition,
  RecognitionLockBusy,
  primaryContention,
  redisCoversPrimary,
  steadyState,
} from "./recognition.ts";
import {
  RecognitionIntegrityError,
  RecognitionRequestInvalid,
  RecognitionUnavailable,
  type PartnerRecognitionStore,
  type RecognitionMarker,
  type RecognitionSnapshot,
} from "./recognition-store.ts";

type Marker = { generation: string; revision: string; needsTrim?: boolean };
const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const sql = (code: string) => Object.assign(new Error("synthetic"), { code });

/** In-memory Redis side of recognition: marker only, as `inspect` returns it. */
class FakeStore {
  readonly capacity = partnerCapacity(JSON.stringify(syntheticCapacity));
  currentEpoch = 1;
  redis: Marker | null;
  markerError: Error | undefined;
  publishError: Error | undefined;
  publishes = 0;
  snapshot: RecognitionSnapshot | undefined;
  onMarker: (() => void) | undefined;
  constructor(redis: Marker | null) {
    this.redis = redis;
  }
  epoch() {
    return this.currentEpoch;
  }
  async connect() {
    return this.currentEpoch;
  }
  async marker(): Promise<RecognitionMarker | null> {
    this.onMarker?.();
    if (this.markerError) throw this.markerError;
    return (
      this.redis && {
        generation: this.redis.generation,
        revision: this.redis.revision,
        needsTrim: !!this.redis.needsTrim,
      }
    );
  }
  async building() {
    this.redis = null;
  }
  /** `flags` mirrors the store's trailing (building, needsTrim) parameters. */
  async publish(
    _previous: RecognitionMarker,
    next: RecognitionMarker,
    snapshot: RecognitionSnapshot,
    _epoch: number,
    ...flags: boolean[]
  ) {
    const needsTrim = flags[1] ?? false;
    this.publishes++;
    if (this.publishError) throw this.publishError;
    this.snapshot = snapshot;
    this.redis = {
      generation: next.generation,
      revision: next.revision,
      needsTrim,
    };
  }
  digest(hash: Uint8Array) {
    return Buffer.from(hash).toString("hex").padEnd(64, "0").slice(0, 64);
  }
  classifyError: Error | undefined;
  async classify() {
    if (this.classifyError) throw this.classifyError;
    return { kind: "unknown" as const };
  }
}

type KeyRow = {
  id: string;
  key_hash: Buffer;
  partner_id: string;
  tier: string;
  requests_per_minute: number;
  origins: string[];
};
/** In-memory primary: marker row, advisory lock, snapshot rows and injectable step errors. */
class FakePrimary {
  marker: Marker;
  errors: Partial<Record<"observe" | "lock" | "snapshot" | "connect", Error>> =
    {};
  lockQueries = 0;
  snapshotCalls = 0;
  saveRowCount = 1;
  snapshotRows: (call: number) => KeyRow[] = () => [];
  onObserve: (() => void) | undefined;
  lockGate: Promise<void> | undefined;
  lockBusy = false;
  // A real transaction-scoped mutex: concurrent transactions contend for it.
  #holder: object | undefined;
  #pending = new Map<object, Marker>();
  constructor(marker: Marker) {
    this.marker = marker;
  }
  async #answer(text: string, values: unknown[], client: object) {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text))
      return this.#control(text, client);
    if (text.includes("pg_try_advisory_xact_lock")) {
      this.lockQueries++;
      await this.lockGate;
      if (this.errors.lock) throw this.errors.lock;
      const locked =
        !this.lockBusy &&
        (this.#holder === undefined || this.#holder === client);
      if (locked) this.#holder = client;
      return { rows: [{ locked }] };
    }
    if (text.includes("FROM partner_api_recognition"))
      return this.#marker(text.includes("FOR UPDATE"));
    if (text.includes("FROM partner_api_keys")) {
      this.snapshotCalls++;
      if (this.errors.snapshot) throw this.errors.snapshot;
      return { rows: this.snapshotRows(this.snapshotCalls) };
    }
    if (text.startsWith("UPDATE partner_api_recognition")) {
      if (this.saveRowCount === 0) return { rowCount: 0, rows: [] };
      this.#pending.set(client, {
        generation: String(values[0]),
        revision: String(values[1]),
      });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected fake statement: ${text.slice(0, 60)}`);
  }
  #control(text: string, client: object) {
    const pending = this.#pending.get(client);
    if (text === "COMMIT" && pending) this.marker = pending;
    if (text === "COMMIT" || text === "ROLLBACK") {
      this.#pending.delete(client);
      if (this.#holder === client) this.#holder = undefined;
    }
    return { command: text.split(";")[0], rows: [] };
  }
  #marker(locked: boolean) {
    if (!locked) {
      this.onObserve?.();
      if (this.errors.observe) throw this.errors.observe;
    }
    return {
      rows: [
        { generation: this.marker.generation, revision: this.marker.revision },
      ],
    };
  }
  pool(): Pool {
    return {
      connect: async () => {
        if (this.errors.connect) throw this.errors.connect;
        const client = {
          on() {},
          removeListener() {},
          release() {},
          query: (text: string, values: unknown[] = []): Promise<unknown> =>
            this.#answer(text, values, client),
        };
        return client;
      },
    } as unknown as Pool;
  }
}

async function readyPair(
  redis: Marker | null = { generation: G1, revision: "5" },
  primary: Marker = { generation: G1, revision: "5" },
  options = {},
) {
  const store = new FakeStore(redis);
  const db = new FakePrimary(primary);
  const coordinator = new PartnerRecognition(
    db.pool(),
    store as unknown as PartnerRecognitionStore,
    options,
  );
  await coordinator.reconcile();
  assert.equal(coordinator.ready(), true);
  return { store, db, coordinator };
}

test("pure marker predicates use exact untrimmed matches and BigInt revisions", () => {
  const primary = { generation: G1, revision: "10" };
  assert.equal(steadyState({ ...primary, needsTrim: false }, primary), true);
  assert.equal(steadyState({ ...primary, needsTrim: true }, primary), false);
  assert.equal(steadyState(null, primary), false);
  assert.equal(steadyState({ generation: G2, revision: "10" }, primary), false);
  assert.equal(
    redisCoversPrimary(
      { generation: G1, revision: "10" },
      { generation: G1, revision: "9" },
    ),
    true,
  );
  assert.equal(
    redisCoversPrimary(
      { generation: G1, revision: "9" },
      { generation: G1, revision: "10" },
    ),
    false,
    "string order would wrongly accept 9 > 10",
  );
  assert.equal(
    redisCoversPrimary({ generation: G2, revision: "11" }, primary),
    false,
  );
  assert.equal(redisCoversPrimary(null, primary), false);
  assert.equal(
    redisCoversPrimary(
      { generation: G1, revision: "9223372036854775807" },
      { generation: G1, revision: "9223372036854775806" },
    ),
    true,
  );
});

test("only PostgreSQL contention and connection loss are preservable errors", () => {
  for (const error of [
    sql("55P03"),
    sql("57014"),
    sql("53300"),
    sql("08006"),
    sql("08001"),
    Object.assign(new Error("connect"), { code: "ECONNRESET" }),
    new Error("timeout exceeded when trying to connect"),
    new Error("Connection terminated unexpectedly"),
    new Error("Query read timeout"),
  ])
    assert.equal(
      primaryContention(error),
      true,
      String((error as { code?: string }).code ?? error.message),
    );
  for (const error of [
    sql("23505"),
    sql("23503"),
    sql("40001"),
    sql("42501"),
    new RecognitionUnavailable(),
    new PartnerCapacityError(),
    new Error("Redis command refused."),
    new Error("Redis operation unavailable."),
    "not an error",
  ])
    assert.equal(primaryContention(error), false, String(error));
});

// Protocol model: write publishes the union superset (needsTrim) before COMMIT;
// rollback leaves Redis ahead; rebuild deletes, publishes a new generation, then commits.
type ModelState = {
  pg: Marker;
  committed: Set<string>;
  redis: Marker | null;
  map: Set<string>;
};
type ModelEvent = (state: ModelState) => void;
const publishEvent =
  (
    generation: string,
    revision: string,
    keys: string[],
    needsTrim: boolean,
  ): ModelEvent =>
  (state) => {
    state.redis = { generation, revision, needsTrim };
    state.map = new Set(keys);
  };
const commitEvent =
  (generation: string, revision: string, keys: string[]): ModelEvent =>
  (state) => {
    state.pg = { generation, revision };
    state.committed = new Set(keys);
  };
const SEQUENCES: Record<string, ModelEvent[]> = {
  "publish-before-commit": [
    publishEvent(G1, "2", ["a", "b"], true),
    commitEvent(G1, "2", ["a", "b"]),
    publishEvent(G1, "2", ["a", "b"], false),
  ],
  "revocation-trim": [
    publishEvent(G1, "2", ["a"], true),
    commitEvent(G1, "2", []),
    publishEvent(G1, "2", [], false),
  ],
  "rollback-after-publish": [
    publishEvent(G1, "2", ["a", "b"], true),
    () => {},
    publishEvent(G2, "3", ["a"], false),
    commitEvent(G2, "3", ["a"]),
  ],
  "rebuild-new-generation": [
    (state) => {
      state.redis = null;
      state.map = new Set();
    },
    publishEvent(G2, "2", ["a"], false),
    commitEvent(G2, "2", ["a"]),
  ],
};

/** Returns the map observed by an accepted lock-free check, or null when it was not accepted. */
async function observeInterleaving(
  events: ModelEvent[],
  first: number,
  second: number,
  order: "primary-first" | "redis-first",
) {
  const state: ModelState = {
    pg: { generation: G1, revision: "1" },
    committed: new Set(["a"]),
    redis: { generation: G1, revision: "1", needsTrim: false },
    map: new Set(["a"]),
  };
  let applied = 0;
  const advance = (to: number) => {
    for (; applied < to; applied++) events[applied](state);
  };
  let observed = new Set<string>();
  if (order === "redis-first") {
    advance(first);
    const redis = state.redis && { ...state.redis };
    observed = new Set(state.map);
    advance(second);
    return steadyState(redis, state.pg)
      ? { observed, committed: state.committed }
      : null;
  }
  // Drive the actual coordinator: its observe SELECT happens at `first`, inspect at `second`.
  const store = new FakeStore(state.redis);
  const db = new FakePrimary(state.pg);
  db.onObserve = () => {
    advance(first);
    db.marker = state.pg;
  };
  store.onMarker = () => {
    advance(second);
    store.redis = state.redis;
    observed = new Set(state.map);
  };
  const coordinator = new PartnerRecognition(
    db.pool(),
    store as unknown as PartnerRecognitionStore,
  );
  db.errors.lock = sql("55P03");
  await coordinator.reconcile().catch(() => undefined);
  if (db.lockQueries > 0) return null;
  assert.equal(coordinator.ready(), true);
  return { observed, committed: state.committed };
}

test("lock-free observe never accepts a map that is a strict subset of committed primary state", async () => {
  const cases = Object.entries(SEQUENCES).flatMap(([name, events]) =>
    events.flatMap((_, first) =>
      [...events.keys(), events.length]
        .filter((second) => second >= first)
        .flatMap((second) =>
          (["primary-first", "redis-first"] as const).map((order) => ({
            name,
            events,
            first,
            second,
            order,
          })),
        ),
    ),
  );
  let accepted = 0;
  for (const { name, events, first, second, order } of cases) {
    const result = await observeInterleaving(events, first, second, order);
    if (!result) continue;
    accepted++;
    // Later Redis changes are re-validated by every classify (metadata state/marker).
    const missing = [...result.committed].filter(
      (key) => !result.observed.has(key),
    );
    assert.deepEqual(
      missing,
      [],
      `${name}/${order}/${first},${second}: accepted map lacks committed keys`,
    );
  }
  assert.ok(
    accepted > 0,
    "Some interleavings are genuinely accepted lock-free.",
  );
});

test("primary contention on a verified superset preserves readiness; every flipped condition clears", async () => {
  const trim = { generation: G1, revision: "5", needsTrim: true };
  const contended = async (
    mutate: (
      pair: Awaited<ReturnType<typeof readyPair>>,
    ) => void | Promise<void>,
    error: Error = sql("55P03"),
    options = {},
  ) => {
    const pair = await readyPair(undefined, undefined, options);
    pair.store.redis = trim;
    pair.db.errors.lock = error;
    await mutate(pair);
    await assert.rejects(pair.coordinator.reconcile());
    return pair.coordinator.ready();
  };
  assert.equal(await contended(() => {}), true, "55P03 while trim is deferred");
  assert.equal(await contended(() => {}, sql("57014")), true);
  assert.equal(
    await contended(
      () => {},
      new Error("timeout exceeded when trying to connect"),
    ),
    true,
  );
  assert.equal(
    await contended(({ store }) => {
      store.redis = { generation: G1, revision: "7" };
    }),
    true,
    "Redis ahead after an in-flight write",
  );
  assert.equal(
    await contended(() => {}, sql("23505")),
    false,
    "not contention",
  );
  assert.equal(
    await contended(() => {}, new RecognitionUnavailable()),
    false,
    "deadline/marker class",
  );
  assert.equal(
    await contended(({ store }) => {
      store.redis = { generation: G2, revision: "9" };
    }),
    false,
    "other generation",
  );
  assert.equal(
    await contended(({ store }) => {
      store.redis = { generation: G1, revision: "4" };
    }),
    false,
    "Redis behind",
  );
  assert.equal(
    await contended(({ store }) => {
      store.redis = null;
    }),
    false,
    "absent or malformed metadata",
  );
  assert.equal(
    await contended(({ store }) => {
      store.markerError = new Error("Redis command refused.");
    }),
    false,
    "Lua error reply from inspect",
  );
  assert.equal(
    await contended(({ store }) => {
      store.markerError = new RecognitionUnavailable();
    }),
    false,
    "malformed inspect reply",
  );
  assert.equal(
    await contended(({ coordinator }) => coordinator.invalidate()),
    false,
    "requested repair",
  );
  assert.equal(
    await contended(async () => pause(5), sql("55P03"), { preserveMs: 1 }),
    false,
    "past the bound",
  );
  // Epoch change: Redis reconnected, so readiness is never carried across it. A
  // Redis-ahead superset preserved at the same epoch must be re-verified here.
  const moved = await readyPair();
  moved.store.redis = { generation: G1, revision: "7" };
  moved.store.currentEpoch = 2;
  moved.db.errors.lock = sql("55P03");
  await assert.rejects(moved.coordinator.reconcile());
  assert.equal(moved.coordinator.ready(), false);
  // A Redis write by this attempt disqualifies: building then a snapshot timeout.
  const rebuilding = await readyPair();
  rebuilding.store.redis = null;
  rebuilding.db.errors.snapshot = sql("57014");
  await assert.rejects(rebuilding.coordinator.reconcile());
  assert.equal(rebuilding.coordinator.ready(), false);
  // Observe failure with no marker read relies only on the bound.
  const blind = await readyPair();
  blind.db.errors.observe = new Error(
    "timeout exceeded when trying to connect",
  );
  await assert.rejects(blind.coordinator.reconcile());
  assert.equal(blind.coordinator.ready(), true);
});

test("preservation never resurrects readiness withdrawn concurrently by classify", async () => {
  const { store, db, coordinator } = await readyPair();
  store.redis = { generation: G1, revision: "5", needsTrim: true };
  let release!: () => void;
  db.lockGate = new Promise((resolve) => {
    release = resolve;
  });
  db.errors.lock = sql("55P03");
  const running = coordinator.reconcile();
  while (db.lockQueries === 0) await pause(1);
  store.classifyError = new Error("Redis command refused.");
  await assert.rejects(coordinator.classify({ ip: "198.18.0.1" }));
  assert.equal(coordinator.ready(), false);
  release();
  await assert.rejects(running);
  assert.equal(coordinator.ready(), false);
});

test("an unreserved partner cannot block another partner's writes or recovery", async () => {
  const { db, store, coordinator } = await readyPair();
  const legacy: KeyRow = {
    id: "33333333-3333-4333-8333-333333333333",
    key_hash: Buffer.alloc(32, 1),
    partner_id: "unreserved",
    tier: "standard",
    requests_per_minute: 300,
    origins: ["https://unreserved.example"],
  };
  const allowed = {
    ...legacy,
    id: "44444444-4444-4444-8444-444444444444",
    key_hash: Buffer.alloc(32, 2),
    partner_id: "quiet",
    origins: ["https://quiet.example"],
  };
  let issued = false;
  db.snapshotRows = () => (issued ? [legacy, allowed] : [legacy]);
  await coordinator.write(async () => {
    issued = true;
  });
  assert.equal(issued, true);
  assert.deepEqual(
    store.snapshot?.entries.map((entry) => entry.tenant),
    ["quiet"],
  );
  assert.deepEqual(store.snapshot?.origins, ["https://quiet.example"]);
  coordinator.invalidate();
  await coordinator.reconcile();
  assert.equal(coordinator.ready(), true);
  assert.deepEqual(
    store.snapshot?.entries.map((entry) => entry.tenant),
    ["quiet"],
  );
});

test("an over-reserved tenant stays isolated until its stored quotas fit again", async () => {
  const { db, store, coordinator } = await readyPair();
  let rows: KeyRow[] = [1, 2, 3].map((number) => ({
    id: `33333333-3333-4333-8333-33333333333${number}`,
    key_hash: Buffer.alloc(32, number),
    partner_id: "noisy",
    tier: "custom",
    requests_per_minute: 600,
    origins: ["https://noisy.example"],
  }));
  const quiet: KeyRow = {
    ...rows[0],
    id: "44444444-4444-4444-8444-444444444444",
    key_hash: Buffer.alloc(32, 4),
    partner_id: "quiet",
    origins: ["https://quiet.example"],
  };
  db.snapshotRows = () => rows;
  coordinator.invalidate();
  await coordinator.reconcile();
  assert.equal(store.snapshot?.entries.length, 0);
  await coordinator.write(async () => {
    rows = [...rows, quiet];
  });
  assert.deepEqual(
    store.snapshot?.entries.map((entry) => entry.tenant),
    ["quiet"],
  );
  await coordinator.write(async () => {
    rows = rows.map((row) =>
      row.partner_id === "noisy" ? { ...row, requests_per_minute: 500 } : row,
    );
  });
  await coordinator.reconcile();
  assert.deepEqual(
    store.snapshot?.entries.map((entry) => entry.tenant),
    ["quiet"],
  );
  assert.deepEqual(
    rows.slice(0, 3).map((row) => row.requests_per_minute),
    [500, 500, 500],
  );
  await coordinator.write(async () => {
    rows = rows.slice(1);
  });
  await coordinator.reconcile();
  assert.deepEqual(
    store.snapshot?.entries.map((entry) => entry.tenant),
    ["noisy", "noisy", "quiet"],
  );
});

test("quarantine refuses new keys and quota increases without withdrawing healthy service", async () => {
  for (const partner of ["unreserved", "noisy"]) {
    const { db, store, coordinator } = await readyPair();
    const existing: KeyRow = {
      id: "33333333-3333-4333-8333-333333333333",
      key_hash: Buffer.alloc(32, 1),
      partner_id: partner,
      tier: "custom",
      requests_per_minute: 700,
      origins: [],
    };
    for (const candidate of [
      [{ ...existing, requests_per_minute: 800 }],
      [
        existing,
        {
          ...existing,
          id: "44444444-4444-4444-8444-444444444444",
          key_hash: Buffer.alloc(32, 2),
        },
      ],
    ]) {
      let mutated = false;
      db.snapshotRows = () => (mutated ? candidate : [existing]);
      await assert.rejects(
        coordinator.write(async () => {
          mutated = true;
        }),
        PartnerCapacityError,
      );
      assert.equal(coordinator.ready(), true);
      assert.equal(store.publishes, 0);
    }
  }
});

test("write failures clear only when Redis may differ unsafely", async () => {
  const row = (partner: string): KeyRow => ({
    id: "33333333-3333-4333-8333-333333333333",
    key_hash: Buffer.alloc(32, 1),
    partner_id: partner,
    tier: "standard",
    requests_per_minute: 300,
    origins: [],
  });
  const outcome = async (
    prepare: (pair: Awaited<ReturnType<typeof readyPair>>) => void,
    mutation: () => Promise<unknown> = async () => undefined,
  ) => {
    const pair = await readyPair();
    let nudged = 0;
    const original = pair.coordinator.nudge.bind(pair.coordinator);
    pair.coordinator.nudge = () => {
      nudged++;
      original();
    };
    prepare(pair);
    await assert.rejects(pair.coordinator.write(mutation));
    return {
      ready: pair.coordinator.ready(),
      nudged,
      publishes: pair.store.publishes,
    };
  };
  assert.deepEqual(
    await outcome(
      () => {},
      async () => {
        throw sql("23505");
      },
    ),
    { ready: true, nudged: 0, publishes: 0 },
    "operator duplicate",
  );
  assert.deepEqual(
    await outcome(({ db }) => {
      db.snapshotRows = (call) => (call === 2 ? [row("unknown-tenant")] : []);
    }),
    { ready: true, nudged: 0, publishes: 0 },
    "candidate over capacity",
  );
  assert.deepEqual(
    await outcome(({ db }) => {
      db.snapshotRows = () => Array.from({ length: 101 }, () => row("quiet"));
    }),
    { ready: false, nudged: 0, publishes: 0 },
    "committed registry exceeds the shared entry bound",
  );
  assert.deepEqual(
    await outcome(({ store }) => {
      store.publishError = new Error("Redis command refused.");
    }),
    { ready: false, nudged: 0, publishes: 1 },
    "during publish",
  );
  assert.deepEqual(
    await outcome(({ db }) => {
      db.saveRowCount = 0;
    }),
    { ready: true, nudged: 1, publishes: 1 },
    "after publish",
  );
  assert.deepEqual(
    await outcome(({ store }) => {
      store.redis = { generation: G1, revision: "6" };
    }),
    { ready: true, nudged: 1, publishes: 0 },
    "Redis ahead mismatch",
  );
  assert.deepEqual(
    await outcome(({ store }) => {
      store.redis = { generation: G2, revision: "6" };
    }),
    { ready: false, nudged: 0, publishes: 0 },
    "other generation mismatch",
  );
  assert.deepEqual(
    await outcome(({ store }) => {
      store.markerError = new Error("Redis command refused.");
    }),
    { ready: false, nudged: 0, publishes: 0 },
    "store read failure",
  );
});

test("request-scoped input refusals never touch readiness", async () => {
  const { store, coordinator } = await readyPair();
  store.classifyError = new RecognitionRequestInvalid();
  await assert.rejects(
    coordinator.classify({ ip: "not-an-ip" }),
    RecognitionRequestInvalid,
  );
  assert.equal(coordinator.ready(), true);
  assert.equal(
    new RecognitionRequestInvalid() instanceof RecognitionUnavailable,
    false,
  );
});

test("unready recovery retries quickly and boundedly; serving replicas keep the 1–5 s cadence; nudges coalesce", async () => {
  const unready = new PartnerRecognition(
    new FakePrimary({ generation: G1, revision: "5" }).pool(),
    new FakeStore(null) as unknown as PartnerRecognitionStore,
  );
  const store = new FakeStore({ generation: G1, revision: "5" });
  let connects = 0;
  store.connect = async () => {
    connects++;
    throw new Error("Redis connection failed.");
  };
  const failing = new PartnerRecognition(
    new FakePrimary({ generation: G1, revision: "5" }).pool(),
    store as unknown as PartnerRecognitionStore,
  );
  const stopFailing = failing.startRecovery();
  await pause(1_500);
  await stopFailing();
  assert.ok(
    connects >= 4 && connects <= 12,
    `unready attempts in 1.5 s: ${connects}`,
  );

  const { store: trimStore, db, coordinator } = await readyPair();
  trimStore.redis = { generation: G1, revision: "5", needsTrim: true };
  db.errors.lock = sql("55P03");
  const stopPreserved = coordinator.startRecovery();
  await pause(900);
  const preservedAttempts = db.lockQueries;
  await stopPreserved();
  assert.equal(coordinator.ready(), true);
  assert.ok(
    preservedAttempts <= 1,
    `serving replica does not herd the lock: ${preservedAttempts}`,
  );

  // A nudge that arrives during an in-flight pass causes one immediate rerun.
  const nudgeStore = new FakeStore({ generation: G1, revision: "5" });
  const nudgeDb = new FakePrimary({ generation: G1, revision: "5" });
  let observes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const nudged = new PartnerRecognition(
    nudgeDb.pool(),
    nudgeStore as unknown as PartnerRecognitionStore,
  );
  const original = nudgeStore.connect.bind(nudgeStore);
  nudgeStore.connect = async () => {
    observes++;
    if (observes === 1) await gate;
    return original();
  };
  const stopNudged = nudged.startRecovery();
  while (observes === 0) await pause(1);
  nudged.nudge();
  nudged.nudge();
  release();
  await pause(100);
  await stopNudged();
  assert.equal(
    observes,
    2,
    "one coalesced immediate rerun, then the normal 1–5 s sleep",
  );
  assert.equal(unready.ready(), false);
});

test("recovery never queues on the recognition lock; operator writes wait boundedly for it", async () => {
  assert.equal(primaryContention(new RecognitionLockBusy()), true);
  const { store, db, coordinator } = await readyPair();
  store.redis = { generation: G1, revision: "5", needsTrim: true };
  db.lockBusy = true;
  const started = performance.now();
  await assert.rejects(coordinator.reconcile(), RecognitionLockBusy);
  assert.ok(performance.now() - started < 100, "a busy lock is not waited for");
  assert.equal(
    coordinator.ready(),
    true,
    "a peer's trim or write is contention",
  );
  assert.equal(db.lockQueries, 1);
  setTimeout(() => {
    db.lockBusy = false;
  }, 200);
  const writing = performance.now();
  await coordinator.write(async () => undefined);
  const waited = performance.now() - writing;
  assert.ok(
    waited >= 150 && waited < 2_000,
    `write polled for the lock: ${Math.round(waited)} ms`,
  );
  assert.ok(db.lockQueries > 2);
});

test("after a reconnect, an exact marker with only a trim pending serves at once within the bound", async () => {
  const reconnect = async (options = {}, wait = 0) => {
    const { store, db, coordinator } = await readyPair(
      undefined,
      undefined,
      options,
    );
    await pause(wait);
    store.currentEpoch = 2;
    store.redis = { generation: G1, revision: "5", needsTrim: true };
    db.lockBusy = true;
    await assert.rejects(coordinator.reconcile(), RecognitionLockBusy);
    return coordinator.ready();
  };
  assert.equal(
    await reconnect(),
    true,
    "serves the superset while a peer trims",
  );
  assert.equal(
    await reconnect({ preserveMs: 1 }, 5),
    false,
    "past the bound it waits for its own trim",
  );
  const fresh = new PartnerRecognition(
    new FakePrimary({ generation: G1, revision: "5" }).pool(),
    new FakeStore({
      generation: G1,
      revision: "5",
      needsTrim: true,
    }) as unknown as PartnerRecognitionStore,
  );
  await fresh.reconcile();
  assert.equal(
    fresh.ready(),
    true,
    "a free lock trims and becomes ready normally",
  );
  const neverVerifiedDb = new FakePrimary({ generation: G1, revision: "5" });
  neverVerifiedDb.lockBusy = true;
  const neverVerified = new PartnerRecognition(
    neverVerifiedDb.pool(),
    new FakeStore({
      generation: G1,
      revision: "5",
      needsTrim: true,
    }) as unknown as PartnerRecognitionStore,
  );
  await assert.rejects(neverVerified.reconcile(), RecognitionLockBusy);
  assert.equal(
    neverVerified.ready(),
    false,
    "a replica that never verified must trim first",
  );
});

test(
  "past half the bound, recovery wins the lock against sustained 50 ms-interval operator writes",
  { timeout: 60_000 },
  async () => {
    const { store, coordinator } = await readyPair(undefined, undefined, {
      preserveMs: 2_000,
    });
    let writing = true;
    const writes = { done: 0, refused: 0 };
    // One operator starts a write every ~50 ms and holds the lock ~30 ms of it.
    const operator = (async () => {
      while (writing) {
        await coordinator
          .write(() => pause(30))
          .then(
            () => writes.done++,
            () => writes.refused++,
          );
        await pause(20);
      }
    })();
    const trials: { ready: boolean; won: boolean }[] = [];
    try {
      await pause(100);
      for (let trial = 0; trial < 5; trial++) {
        // Just past half the bound: one try alone loses ~60% of the time here.
        await pause(1_150);
        const won = await coordinator.reconcile().then(
          () => true,
          () => false,
        );
        trials.push({ ready: coordinator.ready(), won });
      }
    } finally {
      writing = false;
      await operator;
    }
    assert.ok(writes.done > 50, JSON.stringify(writes));
    assert.deepEqual(
      trials,
      Array(5).fill({ ready: true, won: true }),
      `trials ${JSON.stringify(trials)}, writes ${JSON.stringify(writes)}, publishes ${store.publishes}`,
    );
  },
);

test(
  "write()'s own lock wait surfaces RecognitionLockBusy and leaves readiness unchanged",
  { timeout: 15_000 },
  async () => {
    const { store, db, coordinator } = await readyPair();
    db.lockBusy = true;
    const started = performance.now();
    await assert.rejects(
      coordinator.write(async () => assert.fail("never runs")),
      RecognitionLockBusy,
    );
    assert.ok(
      performance.now() - started >= 4_900,
      "operators wait up to 5 s for the lock",
    );
    assert.equal(coordinator.ready(), true);
    assert.equal(store.publishes, 0);
  },
);

test("the reconnect grant never refreshes the bound, never overrides a repair, and needs an exact same-generation map", async () => {
  // (a) Granted at E2, then past the bound with the lock still busy: unready.
  const { store, db, coordinator } = await readyPair(undefined, undefined, {
    preserveMs: 50,
  });
  store.currentEpoch = 2;
  store.redis = { generation: G1, revision: "5", needsTrim: true };
  db.lockBusy = true;
  await assert.rejects(coordinator.reconcile(), RecognitionLockBusy);
  assert.equal(coordinator.ready(), true);
  await pause(80);
  await assert.rejects(coordinator.reconcile(), RecognitionLockBusy);
  assert.equal(
    coordinator.ready(),
    false,
    "the grant did not refresh the last full verification",
  );
  // (b) A requested repair blocks the grant.
  const repaired = await readyPair();
  repaired.coordinator.invalidate();
  repaired.store.currentEpoch = 2;
  repaired.store.redis = { generation: G1, revision: "5", needsTrim: true };
  repaired.db.lockBusy = true;
  await assert.rejects(repaired.coordinator.reconcile(), RecognitionLockBusy);
  assert.equal(repaired.coordinator.ready(), false);
  // (c) Other generation or Redis behind at the new epoch: unready.
  for (const redis of [
    { generation: G2, revision: "5", needsTrim: true },
    { generation: G1, revision: "4", needsTrim: true },
  ]) {
    const moved = await readyPair();
    moved.store.currentEpoch = 2;
    moved.store.redis = redis;
    moved.db.lockBusy = true;
    await assert.rejects(moved.coordinator.reconcile(), RecognitionLockBusy);
    assert.equal(moved.coordinator.ready(), false, JSON.stringify(redis));
  }
});

test("preserveMs can only shorten the production bound", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { store, db, coordinator } = await readyPair(undefined, undefined, {
    preserveMs: 3_600_000,
  });
  store.redis = { generation: G1, revision: "5", needsTrim: true };
  db.lockBusy = true;
  t.mock.timers.tick(31_000);
  await assert.rejects(coordinator.reconcile(), RecognitionLockBusy);
  assert.equal(
    coordinator.ready(),
    false,
    "a longer test value is clamped to 30 s",
  );
});

test("readiness lost outside the loop wakes a serving-cadence sleep once and stays bounded while unready", async () => {
  const { store, db, coordinator } = await readyPair();
  let observes = 0;
  db.onObserve = () => {
    observes++;
  };
  const stop = coordinator.startRecovery();
  try {
    while (observes === 0) await pause(5);
    await pause(50);
    const before = observes;
    store.classifyError = new Error("Redis command refused.");
    await assert.rejects(coordinator.classify({ ip: "198.18.0.1" }));
    store.classifyError = undefined;
    assert.equal(coordinator.ready(), false);
    const lost = performance.now();
    while (!coordinator.ready() && performance.now() - lost < 1_000)
      await pause(5);
    assert.equal(
      coordinator.ready(),
      true,
      "recovered without waiting for the 1–5 s tick",
    );
    assert.ok(performance.now() - lost < 200, "woken promptly");
    assert.equal(observes, before + 1, "exactly one extra pass");
    // Unready with Redis down: refusals on the request path do not spin the loop.
    // Start after the 1 s wake floor, so this phase measures the unready backoff.
    await pause(1_100);
    let connects = 0;
    store.connect = async () => {
      connects++;
      throw new Error("Redis connection failed.");
    };
    store.classifyError = new Error("Redis command refused.");
    await assert.rejects(coordinator.classify({ ip: "198.18.0.1" }));
    const started = performance.now();
    while (performance.now() - started < 1_000) {
      await assert.rejects(coordinator.classify({ ip: "198.18.0.1" }));
      await pause(5);
    }
    assert.ok(
      connects >= 3 && connects <= 10,
      `bounded unready attempts in 1 s: ${connects}`,
    );
  } finally {
    await stop();
  }
});

/** A recovering coordinator whose first pass is done and whose loop now sleeps at serving cadence. */
async function servingLoop() {
  const pair = await readyPair();
  let observes = 0;
  pair.db.onObserve = () => {
    observes++;
  };
  const stop = pair.coordinator.startRecovery();
  while (observes === 0) await pause(5);
  await pause(50);
  return { ...pair, stop, observes: () => observes };
}
/** Unauthenticated-rate classify calls for `ms`, one per macrotask turn. */
async function flood(coordinator: PartnerRecognition, ms: number) {
  let requests = 0;
  const started = performance.now();
  while (performance.now() - started < ms) {
    requests++;
    await coordinator.classify({ ip: "198.18.0.1" }).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return requests;
}

test("a classify that keeps failing while Redis answers cannot drive more than ~1 woken pass per second", async () => {
  const generic = await servingLoop();
  try {
    generic.store.classifyError = new Error("Redis command refused.");
    const before = generic.observes();
    const requests = await flood(generic.coordinator, 1_000);
    const extra = generic.observes() - before;
    assert.ok(requests > 200, `request pressure: ${requests}`);
    assert.ok(
      extra >= 1 && extra <= 2,
      `extra observe passes in 1 s: ${extra} for ${requests} requests`,
    );
  } finally {
    await generic.stop();
  }
  const integrity = await servingLoop();
  try {
    integrity.store.classifyError = new RecognitionIntegrityError();
    const before = integrity.store.publishes;
    const lockBefore = integrity.db.lockQueries;
    const requests = await flood(integrity.coordinator, 1_000);
    const forced = integrity.store.publishes - before;
    assert.ok(requests > 200, `request pressure: ${requests}`);
    assert.ok(
      forced >= 1 && forced <= 2,
      `forced repair publishes in 1 s: ${forced} for ${requests} requests`,
    );
    assert.ok(integrity.db.lockQueries - lockBefore <= 2);
  } finally {
    await integrity.stop();
  }
});

test("an early refusal wakes a serving-cadence sleep after a reconnect; after a failed pass it does not", async () => {
  const loop = await servingLoop();
  try {
    loop.store.currentEpoch++;
    assert.equal(
      loop.coordinator.ready(),
      false,
      "readiness lapses by epoch, without a withdrawal",
    );
    const lost = performance.now();
    await assert.rejects(
      loop.coordinator.classify({ ip: "198.18.0.1" }),
      RecognitionUnavailable,
    );
    while (!loop.coordinator.ready() && performance.now() - lost < 1_000)
      await pause(5);
    assert.equal(loop.coordinator.ready(), true, "recovered at the new epoch");
    assert.ok(
      performance.now() - lost < 200,
      "woken promptly by the early refusal",
    );
    // Next: the reconnect pass fails, so the loop is in unready backoff and early
    // refusals must not shorten it.
    let connects = 0;
    loop.store.connect = async () => {
      connects++;
      throw new Error("Redis connection failed.");
    };
    await pause(1_100);
    loop.store.currentEpoch++;
    await assert.rejects(loop.coordinator.classify({ ip: "198.18.0.1" }));
    while (connects === 0) await pause(5);
    const afterFailure = connects;
    await flood(loop.coordinator, 600);
    assert.ok(
      connects - afterFailure <= 4,
      `backoff-bound attempts in 600 ms: ${connects - afterFailure}`,
    );
  } finally {
    await loop.stop();
  }
});

test("a failed startup handshake cannot reach the mutation", async () => {
  const store = new FakeStore(null);
  store.markerError = new RecognitionUnavailable();
  const db = new FakePrimary({ generation: G1, revision: "5" });
  const coordinator = new PartnerRecognition(
    db.pool(),
    store as unknown as PartnerRecognitionStore,
  );
  let mutated = false;
  await assert.rejects(
    coordinator.write(async () => {
      mutated = true;
    }),
    RecognitionUnavailable,
  );
  assert.equal(mutated, false);
  assert.equal(db.lockQueries, 0);
  assert.equal(store.publishes, 0);
});

test("epoch loss during the before snapshot refuses the mutation", async () => {
  const { coordinator, store, db } = await readyPair();
  db.snapshotRows = () => {
    store.currentEpoch++;
    return [];
  };
  let mutated = false;
  await assert.rejects(
    coordinator.write(async () => {
      mutated = true;
    }),
    RecognitionUnavailable,
  );
  assert.equal(mutated, false);
  assert.equal(store.publishes, 0);
});
