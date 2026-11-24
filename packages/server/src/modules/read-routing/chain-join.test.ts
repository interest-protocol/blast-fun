import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, QueryResultRow } from "pg";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { readChainJoin, type ChainJoinDependencies, type ChainPosition } from "@blast/server/modules/read-routing/chain-join.ts";

const NOW = 1_790_000_000_000;
const FINGERPRINT = "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c";

interface FakeDatabase extends ReadableDatabase {
  readonly statements: string[];
}

function database(rows: QueryResultRow[], error?: unknown): FakeDatabase {
  const statements: string[] = [];
  return {
    statements,
    read: async <Row extends QueryResultRow>(text: string) => {
      statements.push(text);
      if (error) throw error;
      return { rows } as unknown as QueryResult<Row>;
    },
  };
}

function sqlError(code: string): Error & { code: string } {
  return Object.assign(new Error(`sqlstate ${code}`), { code });
}

/** A database whose committed checkpoint was produced `lagMs` before now, read at NOW. */
function at(
  checkpoint: number | null,
  lagMs: number | null,
  inRecovery = true,
  network: ChainPosition["network"] = "mainnet",
  deployment = FINGERPRINT,
): ChainPosition {
  return {
    inRecovery,
    network,
    deployment,
    checkpoint,
    timestampMs: lagMs === null ? null : NOW - lagMs,
    observedAt: NOW,
    lagMs,
  };
}

/** The provenance of a join served by `source` at a checkpoint `lagMs` old. */
function served(
  source: "replica" | "primary",
  lagMs: number | null,
  checkpoint: number | null,
  reason?: string,
  known = true,
  network: string | null = "mainnet",
  deployment = FINGERPRINT,
) {
  return {
    source,
    network: known ? network : null,
    deployment: known ? deployment : null,
    checkpoint,
    timestampMs: lagMs === null ? null : NOW - lagMs,
    observedAt: NOW,
    lagMs,
    ...(reason ? { reason } : {}),
  };
}

function dependencies(
  replicaPosition: ChainPosition | Error,
  replica = database([{ symbol: "REPLICA" }]),
  primary = database([{ symbol: "PRIMARY" }]),
  primaryPosition: ChainPosition | Error = at(1_000, 300, false),
): ChainJoinDependencies & { replica: FakeDatabase; primary: FakeDatabase; probed: string[] } {
  const probed: string[] = [];
  return {
    replica,
    primary,
    probed,
    position: async (source) => {
      probed.push(source);
      const position = source === "replica" ? replicaPosition : primaryPosition;
      if (position instanceof Error) throw position;
      return position;
    },
    now: () => NOW,
    requireRecovery: true,
  };
}

const symbols = async (db: ReadableDatabase) =>
  (await db.read<{ symbol: string }>("SELECT symbol FROM chain_read_v1.coins")).rows.map((row) => row.symbol);

test("a replica within the resource's freshness policy serves the join with its checkpoint and deployment", async () => {
  const deps = dependencies(at(990, 400));
  assert.deepEqual(await readChainJoin("search", symbols, deps), {
    status: "fresh",
    data: ["REPLICA"],
    provenance: served("replica", 400, 990, undefined),
  });
  assert.deepEqual(deps.primary.statements, []);
  assert.deepEqual(deps.probed, ["replica"]);
});

test("search on a replica whose checkpoint stopped advancing is stale with its age, and never from the primary", async () => {
  const deps = dependencies(at(900, 45_000));
  assert.deepEqual(await readChainJoin("search", symbols, deps), {
    status: "stale",
    data: ["REPLICA"],
    provenance: served("replica", 45_000, 900, "replica-lag"),
  });
  assert.deepEqual(deps.primary.statements, []);
});

test("search past its staleness ceiling, before any checkpoint, or with the replica down is unavailable, not empty", async () => {
  for (const [position, reason, lagMs, checkpoint] of [
    [at(900, 120_001), "replica-lag", 120_001, 900],
    [at(null, null), "replica-lag", null, null],
    [Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), "replica-unavailable", null, null],
  ] as const) {
    const deps = dependencies(position);
    const result = await readChainJoin("search", symbols, deps);
    assert.deepEqual(result, {
      status: "unavailable",
      provenance: served("replica", lagMs, checkpoint, reason, !(position instanceof Error)),
    });
    assert.equal("data" in result, false);
    assert.deepEqual(deps.primary.statements, []);
  }
});

test("thesis joins on a lagging or unreachable replica are a primary read with the primary's checkpoint", async () => {
  const lagged = dependencies(at(900, 5_001));
  assert.deepEqual(await readChainJoin("thesis-join", symbols, lagged), {
    status: "fresh",
    data: ["PRIMARY"],
    provenance: served("primary", 300, 1_000, "replica-lag"),
  });
  assert.deepEqual(lagged.replica.statements, []);

  const down = dependencies(Object.assign(new Error("timeout"), { code: "57P03" }));
  assert.deepEqual(await readChainJoin("thesis-join", symbols, down), {
    status: "fresh",
    data: ["PRIMARY"],
    provenance: served("primary", 300, 1_000, "replica-unavailable"),
  });
});

test("when blast-infra itself lags, a thesis join stays on the replica as stale indexer lag, with no primary read", async () => {
  // Equal checkpoints: the primary has nothing newer (indexer halted).
  const halted = dependencies(at(900, 8_000), undefined, undefined, at(900, 8_000, false));
  assert.deepEqual(await readChainJoin("thesis-join", symbols, halted), {
    status: "stale",
    data: ["REPLICA"],
    provenance: served("replica", 8_000, 900, "indexer-lag"),
  });
  assert.deepEqual(halted.primary.statements, []);

  // Catch-up: the primary is a checkpoint ahead but just as far outside the policy.
  const catchingUp = dependencies(at(900, 60_000), undefined, undefined, at(901, 59_000, false));
  const result = await readChainJoin("thesis-join", symbols, catchingUp);
  assert.equal(result.status, "stale");
  assert.equal(result.provenance.source, "replica");
  assert.equal(result.provenance.reason, "indexer-lag");
  assert.deepEqual(catchingUp.primary.statements, []);
});

test("during a fast catch-up the primary is ahead but outside the policy too, so the join stays on the replica", async () => {
  // blast-infra replays faster than real time and the replica applies 500 ms behind:
  // the primary is many checkpoints ahead, and both are older than the 5 s thesis policy.
  const catchUp = dependencies(at(900, 7_000), undefined, undefined, at(960, 6_500, false));
  assert.deepEqual(await readChainJoin("thesis-join", symbols, catchUp), {
    status: "stale",
    data: ["REPLICA"],
    provenance: served("replica", 7_000, 900, "indexer-lag"),
  });
  assert.deepEqual(catchUp.primary.statements, []);

  // Far behind as well: without a fresh primary there is still no primary read.
  const farBehind = dependencies(at(900, 60_000), undefined, undefined, at(1_000, 10_000, false));
  const result = await readChainJoin("thesis-join", symbols, farBehind);
  assert.equal(result.provenance.source, "replica");
  assert.equal(result.provenance.reason, "indexer-lag");
  assert.deepEqual(farBehind.primary.statements, []);
});

test("with the replica and the primary both down a thesis join is unavailable with provenance, like search", async () => {
  const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  for (const resource of ["thesis-join", "search"] as const) {
    const down = dependencies(refused(), undefined, undefined, refused());
    assert.deepEqual(await readChainJoin(resource, symbols, down), {
      status: "unavailable",
      provenance: served("replica", null, null, "replica-unavailable", false),
    }, resource);
    assert.deepEqual(down.primary.statements, []);
  }

  const primaryQueryFails = dependencies(refused(), undefined, database([], refused()));
  assert.equal((await readChainJoin("thesis-join", symbols, primaryQueryFails)).status, "unavailable");
});

test("a fresh primary that fails the join leaves the replica's answer stale", async () => {
  const deps = dependencies(at(900, 6_000), undefined, database([], Object.assign(new Error("x"), { code: "57P01" })));
  assert.deepEqual(await readChainJoin("thesis-join", symbols, deps), {
    status: "stale",
    data: ["REPLICA"],
    provenance: served("replica", 6_000, 900, "primary-unavailable"),
  });
});

test("before blast-infra's first checkpoint a join is unavailable; a primary it cannot compare with leaves it stale", async () => {
  const empty = dependencies(at(null, null), undefined, undefined, at(null, null, false));
  for (const resource of ["thesis-join", "search"] as const) {
    const result = await readChainJoin(resource, symbols, empty);
    assert.deepEqual(result, {
      status: "unavailable",
      provenance: served("replica", null, null, "no-checkpoint"),
    });
  }
  assert.deepEqual(empty.primary.statements, []);

  const primaryDown = dependencies(at(900, 8_000), undefined, undefined, Object.assign(new Error("x"), { code: "57P01" }));
  const stale = await readChainJoin("thesis-join", symbols, primaryDown);
  assert.equal(stale.status, "stale");
  assert.equal(stale.provenance.source, "replica");
  assert.equal(stale.provenance.reason, "primary-unavailable");
});

test("search attributes its staleness: indexer lag when the primary is no newer, replica lag when it is", async () => {
  const indexer = dependencies(at(900, 45_000), undefined, undefined, at(900, 45_000, false));
  const stale = await readChainJoin("search", symbols, indexer);
  assert.equal(stale.status, "stale");
  assert.equal(stale.provenance.reason, "indexer-lag");

  const halted = dependencies(at(900, 130_000), undefined, undefined, at(900, 130_000, false));
  assert.deepEqual(await readChainJoin("search", symbols, halted), {
    status: "unavailable",
    provenance: served("replica", 130_000, 900, "indexer-lag"),
  });
  assert.deepEqual(halted.primary.statements, []);
});

test("a replica that fails the join itself degrades the same way; a bug in the query is not masked", async () => {
  const failing = dependencies(at(990, 10), database([], new Error("Connection terminated unexpectedly")));
  assert.equal((await readChainJoin("search", symbols, failing)).status, "unavailable");
  const thesis = dependencies(at(990, 10), database([], sqlError("57014")));
  assert.deepEqual((await readChainJoin("thesis-join", symbols, thesis)).provenance.source, "primary");

  const buggy = dependencies(at(990, 10), database([], sqlError("42703")));
  await assert.rejects(readChainJoin("search", symbols, buggy), { code: "42703" });
  assert.deepEqual(buggy.primary.statements, []);
});

test("a replica endpoint that is not in recovery is a configuration error", async () => {
  const deps = dependencies(at(990, 0, false));
  await assert.rejects(readChainJoin("search", symbols, deps), /DATABASE_REPLICA_URL names a read-write compute/);
  assert.deepEqual(deps.primary.statements, []);
  assert.deepEqual(deps.replica.statements, []);

  const local = { ...dependencies(at(990, 0, false)), requireRecovery: false };
  assert.equal((await readChainJoin("search", symbols, local)).status, "fresh");
});

test("a database that indexes another deployment or network serves no chain join", async () => {
  // The expectation is always mainnet; the database indexes something else.
  const expected = { network: "mainnet", deployment: FINGERPRINT } as const;
  for (const [position, reason, network, deployment] of [
    [at(990, 400, true, "testnet"), "network-mismatch", "testnet", FINGERPRINT],
    [at(990, 400, true, "mainnet", "0".repeat(64)), "deployment-mismatch", "mainnet", "0".repeat(64)],
  ] as const) {
    const deps = { ...dependencies(position), expected };
    assert.deepEqual(await readChainJoin("search", symbols, deps), {
      status: "unavailable",
      provenance: served("replica", 400, 990, reason, true, network, deployment),
    });
    assert.deepEqual(deps.replica.statements, []);
    assert.deepEqual(deps.primary.statements, []);
  }
  const matching = { ...dependencies(at(990, 400)), expected: { network: "mainnet", deployment: FINGERPRINT } as const };
  assert.equal((await readChainJoin("search", symbols, matching)).status, "fresh");
});

test("a chain join that names a blast-infra table instead of its chain_read_v1 views never reaches a database", async () => {
  const deps = dependencies(at(990, 400));
  const tables = async (db: ReadableDatabase) => (await db.read("SELECT symbol FROM coins")).rows;
  await assert.rejects(readChainJoin("search", tables, deps), /chain_read_v1/);
  assert.deepEqual(deps.replica.statements, []);
  assert.deepEqual(deps.primary.statements, []);
});

test("a primary that indexes another deployment serves no chain join either", async () => {
  const other = { ...at(1_000, 300, false), deployment: "0".repeat(64) };
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const expected = { network: "mainnet", deployment: FINGERPRINT } as const;
  for (const replica of [refused, at(900, 5_001)]) {
    const deps = { ...dependencies(replica, undefined, undefined, other), expected };
    const result = await readChainJoin("thesis-join", symbols, deps);
    assert.equal(result.status, "unavailable");
    assert.equal(result.provenance.source, "primary");
    assert.equal(result.provenance.reason, "deployment-mismatch");
    assert.deepEqual(deps.primary.statements, [], "no query on the primary");
  }
});
