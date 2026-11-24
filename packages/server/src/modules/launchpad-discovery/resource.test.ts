import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { FIXTURE_TIMESTAMP_MS, infraProvenanceFixture } from "../../../test/fixtures/modules/launchpad-contract/fixtures.ts";
import { handleDiscoveryRequest } from "@blast/server/modules/launchpad-discovery/resource.ts";

const ORIGIN = "https://api.blast.test";
const EXCLUDE_TEST_QUOTE = `&exclude_quote=${encodeURIComponent(CREATE_TEST_SUI_QUOTE_TYPE)}`;

function captured(view: string): Record<string, unknown> {
  const url = new URL(`../../../../core/test/fixtures/modules/launchpad-contract/fixtures/v1-discovery-${view}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

/** blast-infra answering every `/v1/pools` read with `reply`; the paths it saw go in `seen`. */
function blastInfra(reply: () => Response | Promise<Response>, seen: string[] = []): MarketDataDependencies {
  return {
    origin: ORIGIN,
    now: () => FIXTURE_TIMESTAMP_MS + 412,
    timeoutMs: 1_000,
    statusCacheMs: 0,
    expected: null,
    fetch: async (input: string | URL | Request) => {
      const path = String(input).slice(ORIGIN.length);
      if (path === "/v1/status") return Response.json({ provenance: infraProvenanceFixture() });
      seen.push(path);
      return reply();
    },
  };
}

function get(query: string, dependencies: MarketDataDependencies) {
  return handleDiscoveryRequest(new Request(`https://blast.test/api/launchpad/discovery${query}`), dependencies);
}

test("Hot is refused as unsupported and never reaches blast-infra", async () => {
  const seen: string[] = [];
  const response = await get("?view=hot", blastInfra(() => Response.json({}), seen));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "LAUNCHPAD_VIEW_UNSUPPORTED");
  assert.match(body.error.message, /Hot/);
  assert.deepEqual(seen, []);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

const TOAD = "0x7a79ac93eb3b3c2a93828a0a85367d15557e4d0b74bab119debb654c803f00fa";
const FROG = "0x26f6bc569182e7ab9db81fab58a06e784e7e0d23dc1675fef444f4bf8ff75fb8";

/** A captured engine page, observed now (412 ms behind). */
function current(view: string): Record<string, unknown> {
  return { ...captured(view), provenance: infraProvenanceFixture() };
}

test("a view page is served as an available section of display rows in blast-infra's order", async () => {
  const seen: string[] = [];
  const response = await get("?view=near_graduation", blastInfra(() => Response.json(current("near_graduation")), seen));
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [`/v1/pools?view=near_graduation&limit=25${EXCLUDE_TEST_QUOTE}`]);
  const body = await response.json();
  assert.equal(body.view, "near_graduation");
  assert.equal(body.section.state, "available");
  assert.equal(body.section.provenance.source, "blast-infra");
  assert.equal(body.section.provenance.checkpoint, 326_274_009);
  assert.equal(body.section.data.nextCursor, null);
  assert.deepEqual(body.section.data.rows.map((row: { launchId: string }) => row.launchId), [TOAD, FROG]);
  assert.deepEqual(body.section.data.rows[0], {
    launchId: TOAD,
    coinType: "0xc87fedd65e88c8517369ab363f8104caa51c711b323307b60ae2f447165ccd04::meme::MEME",
    quoteType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
    lifecycle: "live",
    name: "TOAD fixture",
    symbol: "TOAD",
    iconUrl: "https://blast.fun/icons/toad.png",
    createdAtMs: 1_790_289_083_000,
    graduatedAtMs: null,
    // 30000000000 − 4888582743, and 4888582743 / 30000000000 = 16.29…%.
    quoteRemaining: "25111417257",
    quoteDecimals: 9,
    progressBps: 1629,
    partner: null,
  });
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=0, s-maxage=10, stale-while-revalidate=30");
});

test("a view is the whole selection: unknown views and other parameters are refused before blast-infra", async () => {
  const seen: string[] = [];
  const dependencies = blastInfra(() => Response.json(current("new")), seen);
  for (const query of ["?view=trending", "?view=", "?view=new&sort=volume_24h", "?view=new&lifecycle=live", "?view=new&view=graduated"]) {
    const response = await get(query, dependencies);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, "LAUNCHPAD_VIEW_UNSUPPORTED", query);
  }
  assert.deepEqual(seen, []);
  // Without a view the core launch collection is served.
  const response = await get("", dependencies);
  assert.equal((await response.json()).view, "new");
  assert.deepEqual(seen, [`/v1/pools?view=new&limit=25${EXCLUDE_TEST_QUOTE}`]);
});

test("a page token or limit that is not one is a 400 and never reaches blast-infra", async () => {
  const seen: string[] = [];
  const dependencies = blastInfra(() => Response.json(current("new")), seen);
  const otherView = Buffer.from(JSON.stringify({ v: 1, s: "pools:graduated", k: [1], t: ["1", "2", "3"] })).toString("base64url");
  for (const query of ["?view=new&limit=0", "?view=new&limit=101", "?view=new&limit=ten", "?view=new&cursor=bad!", `?view=new&cursor=${otherView}`]) {
    const response = await get(query, dependencies);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, "LAUNCHPAD_CURSOR_INVALID", query);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  }
  assert.deepEqual(seen, []);
  const page = await get("?view=new&limit=100", dependencies);
  assert.equal(page.status, 200);
  assert.deepEqual(seen, [`/v1/pools?view=new&limit=100${EXCLUDE_TEST_QUOTE}`]);
});

test("blast-infra refusing a page token is a 400 for the client, not an empty list", async () => {
  const refusal = () => Response.json({ error: { code: "invalid_parameter", message: "bad cursor" } }, { status: 400 });
  const response = await get("?view=graduated", blastInfra(refusal));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "LAUNCHPAD_CURSOR_INVALID");
});

test("a lagging or halted engine's page is served Stale with its provenance", async () => {
  const lagging = { ...captured("graduated"), provenance: infraProvenanceFixture({ lag_ms: 45_000 }) };
  const response = await get("?view=graduated", blastInfra(() => Response.json(lagging)));
  assert.equal(response.status, 200);
  const { section } = await response.json();
  assert.equal(section.state, "stale");
  assert.equal(section.reason, "lagging");
  assert.equal(section.provenance.lagMs, 45_000);
  assert.deepEqual(section.data.rows.map((row: { launchId: string }) => row.launchId), [TOAD, FROG]);
  assert.equal(section.data.rows[0].graduatedAtMs, 1_790_294_734_750);
});

async function unavailable(response: Response, reason: string) {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Retry-After"), "5");
  const body = await response.json();
  assert.equal(body.section.state, "unavailable");
  assert.equal(body.section.reason, reason);
  assert.equal("data" in body.section, false);
  return body;
}

test("a starting or unreachable engine makes the view Unavailable, never an empty list", async () => {
  const starting = () => Response.json({ error: { code: "not_ready", message: "starting" } }, { status: 503 });
  await unavailable(await get("?view=new", blastInfra(starting)), "not_ready");
  const unreachable = blastInfra(() => {
    throw new TypeError("fetch failed");
  });
  const body = await unavailable(await get("?view=new", unreachable), "unreachable");
  assert.equal(body.view, "new");
  assert.equal(body.section.provenance.source, "blast-infra");
  const missing = () => Response.json({ error: { code: "not_found", message: "no route" } }, { status: 404 });
  await unavailable(await get("?view=new", blastInfra(missing)), "not_found");
});

test("a page holding an unrelated Sui pool is refused whole, never shown in part", async () => {
  const page = current("new");
  const pools = page.pools as Record<string, unknown>[];
  const cetus = { ...pools[1], venue: "cetus", pool_key: `cetus:${pools[1].pool_id}` };
  const response = await get("?view=new", blastInfra(() => Response.json({ ...page, pools: [pools[0], cetus] })));
  await unavailable(response, "contract-violation");
});

test("a current page with no launches is Empty with its provenance", async () => {
  const response = await get("?view=near_graduation", blastInfra(() => Response.json({ ...current("near_graduation"), pools: [] })));
  assert.equal(response.status, 200);
  const { section } = await response.json();
  assert.deepEqual(Object.keys(section).sort(), ["provenance", "state"]);
  assert.equal(section.state, "empty");
  assert.equal(section.provenance.checkpoint, 326_274_009);
});

test("without a blast-infra origin the view is Unavailable as unconfigured, never recomputed", async () => {
  const saved = process.env.BLAST_INFRA_ORIGIN;
  delete process.env.BLAST_INFRA_ORIGIN;
  try {
    await unavailable(await get("?view=new", undefined as unknown as MarketDataDependencies), "unconfigured");
  } finally {
    if (saved !== undefined) process.env.BLAST_INFRA_ORIGIN = saved;
  }
});
