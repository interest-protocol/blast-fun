import assert from "node:assert/strict";
import test from "node:test";

import { ProviderUnavailable } from "./provider.ts";
import { attributeDigests, classifyFailure, keepRecords, notSubmitted, sendLeasedBatch, unsettledVisit } from "./record-keeper.ts";
import { SignerRefusal } from "./signer.ts";

type Row = Readonly<{ id: string; weight: number; alone?: boolean }>;
type Visit = Readonly<{ outcome: "sent" | "read" | "skipped" }> | Readonly<{ outcome: "retry"; errorClass: string; counted?: boolean }>;
type Ready = Readonly<{ record: Row; leaseKey: string }>;
type RecordKeeper = Parameters<typeof keepRecords<Row, Visit, Ready>>[1];
type Batching = NonNullable<RecordKeeper["batching"]>;

/** A keeper whose rows are all ready to send, and a journal of every lease, send, record and report, in order. */
function harness(batching: Partial<Batching> = {}, overrides: Partial<RecordKeeper> = {}) {
  const journal: string[] = [];
  const context = {
    leases: {
      acquire: async (_job: string, key: string) => {
        journal.push(`acquire ${key}`);
        return !key.startsWith("busy");
      },
      release: async (_job: string, key: string) => {
        journal.push(`release ${key}`);
      },
    },
    log: (event: string, fields: Record<string, unknown>) => {
      journal.push(`log ${event} ${String(fields.error)}`);
    },
  } as unknown as Parameters<typeof keepRecords>[0];
  const keeper: RecordKeeper = {
    job: "test-job",
    leaseKey: (row) => row.id,
    examine: async (row, leaseKey) => ({ record: row, leaseKey }),
    classify: (error) => classifyFailure(error) as Visit,
    record: async (row, visit) => {
      journal.push(`record ${row.id} ${visit.outcome}`);
    },
    report: async (row, visit) => {
      journal.push(`report ${row.id} ${visit.outcome}`);
    },
    batching: {
      capacity: 2,
      weight: (ready) => ready.record.weight,
      alone: (ready) => ready.record.alone === true,
      sendWhenFull: true,
      send: async (batch) => {
        journal.push(`send ${batch.map((ready) => ready.record.id).join(",")}`);
        return async () => ({ outcome: "sent" });
      },
      ...batching,
    },
    ...overrides,
  };
  const sends = () => journal.filter((line) => line.startsWith("send "));
  return { context, keeper, journal, sends };
}

test("a full batch is sent at once, and a record tried alone goes out before the open batch", async () => {
  const { context, keeper, sends } = harness();

  await keepRecords(context, keeper, [
    { id: "a", weight: 1 },
    { id: "b", weight: 1 },
    { id: "x", weight: 1, alone: true },
    { id: "c", weight: 1 },
    { id: "d", weight: 1, alone: true },
    { id: "e", weight: 1 },
  ]);

  assert.deepEqual(sends(), ["send a,b", "send x", "send d", "send c,e"]);
});

test("without sending when full, a batch goes out only once the next record would not fit", async () => {
  const { context, keeper, sends } = harness({ capacity: 3, sendWhenFull: false });

  await keepRecords(context, keeper, [
    { id: "a", weight: 2 },
    { id: "b", weight: 1 },
    { id: "c", weight: 1 },
    { id: "d", weight: 2 },
  ]);

  assert.deepEqual(sends(), ["send a,b", "send c,d"]);
});

test("a row whose lease another worker holds is neither examined nor returned", async () => {
  const { context, keeper, journal } = harness({}, {
    examine: async (row) => ({ outcome: row.id === "a" ? "read" : "skipped" }),
  });

  const visits = await keepRecords(context, keeper, [
    { id: "busy-1", weight: 1 },
    { id: "a", weight: 1 },
  ]);

  assert.deepEqual(visits, [{ outcome: "read" }]);
  assert.deepEqual(journal, ["acquire busy-1", "acquire a", "record a read", "release a", "report a read"]);
});

test("a batch that fails to send finishes every record with that failure, logged once", async () => {
  const { context, keeper, journal } = harness({
    send: async () => {
      throw new Error("build broke");
    },
  });

  const visits = await keepRecords(context, keeper, [
    { id: "a", weight: 1 },
    { id: "b", weight: 1 },
  ]);

  const failure = { outcome: "retry", errorClass: "internal-error", counted: true };
  assert.deepEqual(visits, [failure, failure]);
  assert.deepEqual(journal.filter((line) => line.startsWith("log ")), ["log worker.job_error Error"]);
});

test("a record whose settlement fails finishes alone with that failure; the rest of its batch settles", async () => {
  const { context, keeper } = harness({
    send: async () => async (ready) => {
      if (ready.record.id === "a") throw new ProviderUnavailable("timeout");
      return { outcome: "sent" };
    },
  });

  const visits = await keepRecords(context, keeper, [
    { id: "a", weight: 1 },
    { id: "b", weight: 1 },
  ]);

  assert.deepEqual(visits, [{ outcome: "retry", errorClass: "provider-unavailable" }, { outcome: "sent" }]);
});

test("a lease is released even when recording the visit fails, and the visit is not reported", async () => {
  const { context, keeper, journal } = harness({}, {
    examine: async () => ({ outcome: "read" }),
    record: async (row) => {
      journal.push(`record ${row.id}`);
      throw new Error("write failed");
    },
  });

  await assert.rejects(keepRecords(context, keeper, [{ id: "a", weight: 1 }]), /write failed/);

  assert.deepEqual(journal, ["acquire a", "record a", "release a"]);
});

test("node outages retry uncounted, signer refusals stall, and anything else is a counted local failure", () => {
  assert.deepEqual(classifyFailure(new ProviderUnavailable("error")), { outcome: "retry", errorClass: "provider-unavailable" });
  assert.deepEqual(classifyFailure(new SignerRefusal("wrong target")), { outcome: "stalled", errorClass: "signer-refused" });
  assert.deepEqual(classifyFailure(new TypeError("bad bytes")), { outcome: "retry", errorClass: "internal-error", counted: true });
});

test("a digest that is ours settles at once; one the node cannot answer leaves the question open", async () => {
  const asked: string[] = [];
  const verdicts = { d1: "not-ours", d2: "unknown", d3: "ours" } as const;
  const verdictOf = async (digest: string) => {
    asked.push(digest);
    return verdicts[digest as keyof typeof verdicts];
  };

  assert.equal(await attributeDigests(["d1", "d1", "d3", "d2"], verdictOf), "ours");
  assert.deepEqual(asked, ["d1", "d3"]);
  assert.equal(await attributeDigests(["d1", "d2"], verdictOf), null);
  assert.equal(await attributeDigests(["d1"], verdictOf), "not-ours");
});

// This fails if a record sunk by another record's transaction stops getting its attempt back, if
// its own failure or an unknown submission is refunded, or if a busy or unfunded signer counts.
test("a sent record that did not settle is counted, refunded or left unknown exactly as its attempt says", () => {
  const visit = (outcome: string, blame?: string) =>
    unsettledVisit({ outcome } as Parameters<typeof unsettledVisit>[0], blame as Parameters<typeof unsettledVisit>[1]);
  assert.deepEqual(visit("simulation-failed"), { outcome: "retry", errorClass: "simulation-failed", counted: true });
  assert.deepEqual(visit("failed", "another"), { outcome: "retry", errorClass: "batch-failed", refunded: true });
  assert.deepEqual(visit("failed", "own"), { outcome: "retry", errorClass: "execution-failed" });
  assert.deepEqual(visit("unknown"), { outcome: "retry", errorClass: "submission-unknown" });
  assert.deepEqual(visit("executed"), { outcome: "retry", errorClass: "awaiting-effects" });
  assert.deepEqual(notSubmitted("signer-busy"), { outcome: "retry", errorClass: "signer-busy" });
  assert.deepEqual(notSubmitted("insufficient-gas"), { outcome: "retry", errorClass: "insufficient-gas" });
  assert.deepEqual(notSubmitted("foreign deployment"), { outcome: "skipped" });
});

// This fails (or hangs, in chunks of zero) if an unfunded signer sends anyway, or if a record whose lease was lost while it was
// examined is still sent.
test("a batch is not sent when the balance pays for no record, and a record whose lease is lost is skipped", async () => {
  const send = async (affordable: number, renew: boolean) => {
    const context = {
      affordableRecords: async () => affordable,
      leases: { renew: async () => renew },
    } as unknown as Parameters<typeof sendLeasedBatch>[0];
    const ready = { leaseKey: "a" } as unknown as Parameters<typeof sendLeasedBatch>[2][number];
    const steps = {
      recordSubmissions: async () => assert.fail("nothing is submitted"),
      reconcile: async () => assert.fail("nothing is reconciled"),
      settler: () => assert.fail("nothing is settled"),
    };
    return (await sendLeasedBatch(context, "test-job", [ready], steps))(ready);
  };
  assert.deepEqual(await send(0, true), { outcome: "retry", errorClass: "insufficient-gas" });
  assert.deepEqual(await send(5, false), { outcome: "skipped" });
});
