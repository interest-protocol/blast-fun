import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { encodeCursor } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { walletLaunchesCursor } from "@blast/core/modules/launchpad-contract/rewards.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { FIXTURE_TIMESTAMP_MS, infraProvenanceFixture } from "../../../test/fixtures/modules/launchpad-contract/fixtures.ts";
import { parseWalletLaunchesResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { handleWalletLaunchesRequest } from "@blast/server/modules/launchpad-discovery/wallet-launches.ts";

const ORIGIN = "https://api.blast.test";
const WALLET = `0x${"a1".repeat(32)}`;

/** The captured `new` view's rows, which are in creation order, as a wallet's page. */
function walletPage(nextCursor: string | null = null): Record<string, unknown> {
  const url = new URL("../../../../core/test/fixtures/modules/launchpad-contract/fixtures/v1-discovery-new.json", import.meta.url);
  const view = JSON.parse(readFileSync(url, "utf8")) as { pools: unknown[] };
  return { address: WALLET, launches: view.pools, next_cursor: nextCursor, provenance: infraProvenanceFixture() };
}

function blastInfra(reply: () => Response, seen: string[] = []): MarketDataDependencies {
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

const get = (address: string, query: string, dependencies: MarketDataDependencies) =>
  handleWalletLaunchesRequest(new Request(`https://blast.test/api/launchpad/wallets/${address}/launches${query}`), address, dependencies);

test("a wallet's page is served as the discovery views' display rows, private to its reader", async () => {
  const seen: string[] = [];
  const response = await get(WALLET, "?limit=10", blastInfra(() => Response.json(walletPage()), seen));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(seen, [`/v1/wallets/${WALLET}/launches?limit=10`]);
  const body = parseWalletLaunchesResponse(await response.json());
  assert.equal(body.section.state, "available");
  assert.ok(body.section.state === "available" && body.section.data.rows.length > 0);
});

test("only a full address, with limit and cursor of this wallet's list, reaches blast-infra", async () => {
  const seen: string[] = [];
  const infra = blastInfra(() => Response.json(walletPage()), seen);
  const other = encodeCursor(walletLaunchesCursor(`0x${"b2".repeat(32)}`), [], ["00000000000000000001", "00000000000000000000", "00000000000000000000"]);
  for (const [address, query] of [
    ["0x1", ""],
    [WALLET, "?sort=new"],
    [WALLET, "?limit=1&limit=2"],
    [WALLET, "?limit=101"],
    [WALLET, `?cursor=${other}`],
  ]) {
    const response = await get(address, query, infra);
    assert.equal(response.status, 400, `${address}${query}`);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  }
  assert.deepEqual(seen, []);
});

test("an answer about another wallet, or out of creation order, is Unavailable, never shown in part", async () => {
  const wrong = await get(WALLET, "", blastInfra(() => Response.json({ ...walletPage(), address: `0x${"b2".repeat(32)}` })));
  assert.equal(wrong.status, 503);
  const page = walletPage();
  const reversed = await get(WALLET, "", blastInfra(() => Response.json({ ...page, launches: [...(page.launches as unknown[])].reverse() })));
  assert.equal(reversed.status, 503);
  assert.equal((await reversed.json()).section.state, "unavailable");
});
