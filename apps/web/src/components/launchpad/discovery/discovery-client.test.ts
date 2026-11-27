import assert from "node:assert/strict";
import test from "node:test";

import { FIXTURE_TIMESTAMP_MS } from "../../../../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts";
import { discoveryFixtureEngine } from "../../../../../../packages/server/test/fixtures/modules/launchpad-discovery/fixture-engine.ts";
import { handleDiscoveryRequest } from "@blast/server/modules/launchpad-discovery/resource.ts";
import { CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/web/contracts/create.ts";
import { parseDiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { readRailPage } from "./discovery-client.ts";
import { liveDiscoveryPage } from "./discovery-live.ts";

type Call = Readonly<{ url: string; init: RequestInit | undefined }>;

/** The browser's fetch, answered by the real discovery resource over the fixture engine. */
function browser(calls: Call[], state: "serving" | "unreachable" = "serving"): typeof fetch {
  const engine = discoveryFixtureEngine({ state: () => state, now: () => FIXTURE_TIMESTAMP_MS });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handleDiscoveryRequest(new Request(new URL(String(input), "https://blast.test")), engine);
  }) as typeof fetch;
}

test("every rail read bypasses the browser's HTTP cache, so Refresh and Load more reach the server", async () => {
  const calls: Call[] = [];
  const first = await readRailPage("new", null, browser(calls));
  assert.equal(first?.section.state, "available");
  const cursor = first?.section.state === "available" ? first.section.data.nextCursor : null;
  assert.ok(cursor);
  await readRailPage("new", cursor, browser(calls));
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.init?.cache, "no-store", call.url);
  assert.equal(calls[1].url, `/api/launchpad/discovery?view=new&limit=10&cursor=${cursor}`);
});

test("an outage answer is read as such, and a request that fails or is refused is null", async () => {
  const down = await readRailPage("graduated", null, browser([], "unreachable"));
  assert.deepEqual(down?.section.state, "unavailable");
  const offline = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  assert.equal(await readRailPage("new", null, offline), null);
  assert.equal(await readRailPage("new", "not-a-token", browser([])), null);
});

const provenance = { source: "blast-infra", network: "mainnet", deployment: "d", checkpoint: 7, timestampMs: 1, observedAt: 1, lagMs: 0 };
const curve = (byte: string, progressBps: number | null, quoteType = CREATE_SUI_QUOTE_TYPE) => ({
  launchId: `0x${byte.repeat(32)}`,
  coinType: `0x${byte.repeat(31)}ff::meme::MEME`,
  quoteType,
  lifecycle: "live",
  name: "Froggy",
  symbol: "FROG",
  iconUrl: null,
  createdAtMs: 1_790_235_061_218,
  graduatedAtMs: null,
  quoteRemaining: "5000000000",
  quoteDecimals: 9,
  progressBps,
  partner: null,
});
/** A fetch that answers every read with `body` and `status`. */
const answering = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;

test("a current live page owns the order and pagination token while a newer HTTP page wins during recovery", () => {
  const first = curve("0a", 7_000);
  const second = curve("0b", 8_000);
  const page = (checkpoint: number, rows: readonly unknown[], nextCursor: string, verifiedTeam: string[] = []) =>
    parseDiscoveryResponse({ view: "near_graduation", verifiedTeam, section: {
      state: "available", provenance: { ...provenance, checkpoint }, data: { rows, nextCursor },
    } });
  const seed = page(7, [first, second], "old-cursor", [first.launchId]);
  const stream = page(8, [second, first], "live-cursor");
  const visible = liveDiscoveryPage(stream, seed);
  assert.ok(visible?.section.state === "available");
  assert.deepEqual(visible.section.data.rows.map((row) => [row.launchId, row.verifiedTeam]), [
    [second.launchId, undefined], [first.launchId, true],
  ]);
  assert.equal(visible.section.data.nextCursor, "live-cursor");
  const fresh = page(9, [first], "fallback-cursor");
  assert.equal(liveDiscoveryPage(stream, fresh), fresh);
});

test("Almost graduated reads curves by progress and lists only those at 60% or more", async () => {
  const urls: string[] = [];
  // The bonding catalog answers under the `new` view, highest progress first.
  const pages: Record<string, unknown[]> = {
    start: [curve("0e", 9_900, CREATE_TEST_SUI_QUOTE_TYPE)],
    b: [curve("0a", 9_100), curve("0b", 6_000), curve("0c", 5_999), curve("0d", 0)],
  };
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const cursor = new URL(url, "https://blast.test").searchParams.get("cursor");
    return Response.json({ view: "new", section: { state: "available", data: { rows: pages[cursor ?? "start"], nextCursor: cursor ? "c" : "b" }, provenance } });
  }) as typeof fetch;
  const answer = await readRailPage("near_graduation", null, fetcher);
  assert.deepEqual(urls, ["/api/launchpad/discovery?catalog=bonding&sort=progress&q=&limit=10", "/api/launchpad/discovery?catalog=bonding&sort=progress&q=&limit=10&cursor=b"]);
  assert.equal(answer?.view, "near_graduation");
  assert.ok(answer?.section.state === "available");
  // A page of only a test launch reads on; the list ends at the first curve below 60%.
  assert.deepEqual(answer.section.data.rows.map((row) => row.launchId.slice(2, 4)), ["0a", "0b"]);
  assert.equal(answer.section.data.nextCursor, null);
});

test("Almost graduated: a stale page is cut the same way, a first curve below 60% lists none, and an outage stays an outage", async () => {
  const stale = await readRailPage("near_graduation", null, answering({ view: "new", section: { state: "stale", reason: "lagging", data: { rows: [curve("0a", 7_000), curve("0b", 100)], nextCursor: "n" }, provenance } }));
  assert.ok(stale?.section.state === "stale");
  assert.deepEqual(stale.section.data.rows.map((row) => row.progressBps), [7_000]);
  assert.equal(stale.section.data.nextCursor, null);

  const none = await readRailPage("near_graduation", null, answering({ view: "new", section: { state: "available", data: { rows: [curve("0a", 3_237)], nextCursor: "n" }, provenance } }));
  assert.ok(none?.section.state === "available");
  assert.deepEqual(none.section.data, { rows: [], nextCursor: null });

  const down = await readRailPage("near_graduation", null, answering({ view: "new", section: { state: "unavailable", reason: "unavailable", retryAfterSeconds: 5 } }, 503));
  assert.equal(down?.view, "near_graduation");
  assert.equal(down?.section.state, "unavailable");
});
