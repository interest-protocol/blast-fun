import assert from "node:assert/strict";
import test from "node:test";

import { CursorError, encodeCursor } from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import type { ChainJoinDependencies } from "@blast/server/modules/read-routing/chain-join.ts";
import { thesesCursor } from "@blast/server/modules/launchpad-social/contracts.ts";
import { FIXTURE_ALPHA_THESES, FIXTURE_LAUNCH_ALPHA, FIXTURE_LAUNCH_BETA } from "../../../test/fixtures/modules/launchpad-social/fixtures.ts";
import { parseThesisListResponse } from "@blast/core/modules/launchpad-social/list-contract.ts";
import { databaseThesisSource, handleThesisListRequest, type ThesisListSource } from "@blast/server/modules/launchpad-social/list-resource.ts";
import { listLaunchTheses, type ThesisPage } from "@blast/server/modules/launchpad-social/reads.ts";

const PROVENANCE = {
  source: "replica",
  network: "mainnet",
  deployment: "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c",
  checkpoint: 326_274_009,
  timestampMs: 1_790_000_000_000,
  observedAt: 1_790_000_000_500,
  lagMs: 500,
} as const;

type Call = Readonly<{ launchId: string; limit: string | null; cursor: string | null }>;

function source(answer: RoutedRead<ThesisPage> | Error, calls: Call[] = []): ThesisListSource {
  return async (launchId, request) => {
    calls.push({ launchId, limit: request.limit, cursor: request.cursor });
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

const ALPHA_PAGE: RoutedRead<ThesisPage> = { status: "fresh", data: { ...FIXTURE_ALPHA_THESES, nextCursor: "next-token" }, provenance: PROVENANCE };

function list(query: string, read: ThesisListSource | null) {
  return handleThesisListRequest(new Request(`https://blast.test/api/launchpad/theses${query}`), read);
}

test("a malformed list request is refused before any read and never cached", async () => {
  const calls: Call[] = [];
  for (const query of [
    "",
    "?launchId=",
    "?launchId=0x1",
    `?launchId=${FIXTURE_LAUNCH_ALPHA.toUpperCase()}`,
    `?launchId=${FIXTURE_LAUNCH_ALPHA}&launchId=${FIXTURE_LAUNCH_BETA}`,
    `?launchId=${FIXTURE_LAUNCH_ALPHA}&sort=hot`,
    `?launchId=${FIXTURE_LAUNCH_ALPHA}&limit=1&limit=2`,
  ]) {
    const response = await list(query, source(ALPHA_PAGE, calls));
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "LAUNCHPAD_QUERY_INVALID", query);
  }
  assert.deepEqual(calls, []);
});

test("a bad page token or limit is a 400 with the cursor's code", async () => {
  const response = await list(`?launchId=${FIXTURE_LAUNCH_ALPHA}&cursor=forged`, source(new CursorError("the cursor is malformed")));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: "LAUNCHPAD_CURSOR_INVALID", message: "the cursor is malformed" } });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("a launch's public posts are one private section with their page token and provenance", async () => {
  const calls: Call[] = [];
  const response = await list(`?launchId=${FIXTURE_LAUNCH_ALPHA}&limit=2&cursor=abc`, source(ALPHA_PAGE, calls));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store", "social records are never cached publicly");
  assert.deepEqual(calls, [{ launchId: FIXTURE_LAUNCH_ALPHA, limit: "2", cursor: "abc" }]);
  const body = await response.json();
  assert.deepEqual(body, {
    launchId: FIXTURE_LAUNCH_ALPHA,
    theses: {
      state: "available",
      data: { items: FIXTURE_ALPHA_THESES.theses, nextCursor: "next-token" },
      provenance: PROVENANCE,
    },
  });
  assert.deepEqual(parseThesisListResponse(body, FIXTURE_LAUNCH_ALPHA), body, "the browser parses the served answer as served");
});

test("no posts is Empty, a lagging read Stale, and an unanswered or unconfigured read a 503 Unavailable", async () => {
  const empty = await list(`?launchId=${FIXTURE_LAUNCH_BETA}`, source({
    status: "fresh", data: { launchId: FIXTURE_LAUNCH_BETA, theses: [], nextCursor: null }, provenance: PROVENANCE,
  }));
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).theses, { state: "empty", provenance: PROVENANCE });

  const stale = await list(`?launchId=${FIXTURE_LAUNCH_ALPHA}`, source({ ...ALPHA_PAGE, status: "stale", provenance: { ...PROVENANCE, reason: "replica-lag" } }));
  assert.equal(stale.status, 200);
  assert.equal((await stale.json()).theses.state, "stale");

  const down = await list(`?launchId=${FIXTURE_LAUNCH_ALPHA}`, source({
    status: "unavailable", provenance: { ...PROVENANCE, source: "primary", reason: "social-unavailable" },
  }));
  assert.equal(down.status, 503);
  assert.equal(down.headers.get("retry-after"), "5");
  assert.equal(down.headers.get("cache-control"), "private, no-store");
  const downBody = await down.json();
  assert.equal(downBody.theses.state, "unavailable");
  assert.equal(downBody.theses.reason, "social-unavailable");

  const unconfigured = await list(`?launchId=${FIXTURE_LAUNCH_ALPHA}`, null);
  assert.equal(unconfigured.status, 503);
  assert.deepEqual((await unconfigured.json()).theses, { state: "unavailable", reason: "unconfigured" });
});

test("a served post that breaks the public contract makes the section Unavailable, never shown", () => {
  const [post] = FIXTURE_ALPHA_THESES.theses;
  const served = (change: Record<string, unknown>) => ({
    launchId: FIXTURE_LAUNCH_ALPHA,
    theses: { state: "available", data: { items: [{ ...post, ...change }], nextCursor: null }, provenance: PROVENANCE },
  });
  for (const [label, change] of [
    ["a javascript: link", { evidenceLinks: ["javascript:alert(1)"] }],
    ["a plain http link", { evidenceLinks: ["http://example.com/a"] }],
    ["a link with credentials", { evidenceLinks: ["https://user:pass@example.com/"] }],
    ["another launch's post", { launchId: FIXTURE_LAUNCH_BETA }],
    ["a hidden record", { moderationState: "hidden" }],
    ["an unknown label", { authorLabels: ["verified"] }],
    ["a stanceless thesis", { kind: "community_thesis", stance: null }],
    ["an extra field", { score: 9 }],
    ["a checkpointless verification", { disclosure: { ...post.disclosure, observedCheckpoint: null, observedAt: null } }],
    ["a bidi override in the text", { body: "safe \u202E txet" }],
  ] as const) {
    assert.deepEqual(parseThesisListResponse(served(change), FIXTURE_LAUNCH_ALPHA).theses, { state: "unavailable", reason: "contract-violation" }, label);
  }
  assert.throws(() => parseThesisListResponse({ theses: [] }, FIXTURE_LAUNCH_ALPHA));
  assert.throws(() => parseThesisListResponse(served({}), FIXTURE_LAUNCH_BETA), "an answer for another launch");
});

/** Chain-join dependencies that record every database touch and answer none. */
function untouchable(): ChainJoinDependencies & { touched: string[] } {
  const touched: string[] = [];
  const refuse = (where: string) => ({
    read: async () => {
      touched.push(where);
      throw new Error(`no read expected on the ${where}`);
    },
  });
  return {
    touched,
    replica: refuse("replica"),
    primary: refuse("primary"),
    position: async (source) => {
      touched.push(`${source} position`);
      throw new Error("no position expected");
    },
    now: () => 0,
    requireRecovery: false,
    expected: null,
  };
}

test("an envelope-valid list token whose values are out of range is a 400 before any read", async () => {
  const shape = thesesCursor(FIXTURE_LAUNCH_ALPHA);
  const thesis = FIXTURE_ALPHA_THESES.theses[0].thesisId;
  for (const [label, key, tie] of [
    ["a tie-break that is not a thesis ID", "1790000000000000", "not-a-uuid"],
    ["a 30-digit key", "1".repeat(30), thesis],
    ["a key of 2^63", "9223372036854775808", thesis],
  ] as const) {
    const cursor = encodeCursor(shape, [key], [tie]);
    const dependencies = untouchable();
    await assert.rejects(listLaunchTheses(FIXTURE_LAUNCH_ALPHA, { cursor }, dependencies), CursorError, label);
    const response = await handleThesisListRequest(
      new Request(`https://blast.test/api/launchpad/theses?launchId=${FIXTURE_LAUNCH_ALPHA}&cursor=${encodeURIComponent(cursor)}`),
      databaseThesisSource(dependencies),
    );
    assert.equal(response.status, 400, label);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "LAUNCHPAD_CURSOR_INVALID", label);
    assert.deepEqual(dependencies.touched, [], `${label}: no SQL`);
  }
});

/** A fresh replica whose chain views list `launchId`, and a primary that refuses every connection. */
function primaryDown(launchId: string): ChainJoinDependencies & { primaryReads: number } {
  const now = 1_790_000_000_000;
  const state = { primaryReads: 0 };
  return Object.assign(state, {
    replica: {
      read: async (text: string) => {
        assert.match(text, /chain_read_v1\.pools/, "the replica serves chain identity only");
        return {
          rows: [{
            pool_key: `blast_curve:${launchId}`, coin_type: `0x${"a2".padStart(64, "0")}::alpha::ALPHA`, name: "Alpha", symbol: "ALPHA",
            icon_url: null, lifecycle: "live", creator: null, launch_created_at_ms: "1790000000001",
          }],
          rowCount: 1,
        };
      },
    },
    primary: {
      read: async () => {
        state.primaryReads += 1;
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
      },
    },
    position: async () => ({
      inRecovery: true, network: "mainnet", deployment: PROVENANCE.deployment, checkpoint: 9, timestampMs: now - 100, observedAt: now, lagMs: 100,
    }),
    now: () => now,
    requireRecovery: false,
    expected: null,
  }) as unknown as ChainJoinDependencies & { primaryReads: number };
}

test("a primary that cannot answer makes the list and search Unavailable as social-unavailable, not a replica outage", async () => {
  const { searchTheses } = await import("@blast/server/modules/launchpad-social/reads.ts");
  const list = primaryDown(FIXTURE_LAUNCH_ALPHA);
  const listed = await listLaunchTheses(FIXTURE_LAUNCH_ALPHA, {}, list);
  assert.equal(listed.status, "unavailable");
  assert.equal(listed.provenance.reason, "social-unavailable");
  assert.equal(listed.provenance.source, "primary");
  assert.ok(list.primaryReads > 0);

  const search = primaryDown(FIXTURE_LAUNCH_ALPHA);
  const found = await searchTheses("graduation", {}, search);
  assert.equal(found.status, "unavailable");
  assert.equal(found.provenance.reason, "social-unavailable", "never misattributed to the replica");
});
