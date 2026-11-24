import assert from "node:assert/strict";
import test from "node:test";
import { handleDiscoveryRequest } from "@blast/server/modules/launchpad-discovery/resource.ts";
import { handleWalletLaunchesRequest } from "@blast/server/modules/launchpad-discovery/wallet-launches.ts";
import { createPublicPresaleReader } from "@blast/server/modules/social/presales/public-reads.ts";
import { discoveryFixtureEngine } from "../../../test/fixtures/modules/launchpad-discovery/fixture-engine.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { GRADUATED_MARKET_CAP_PATH } from "@blast/core/modules/launchpad-discovery/bonding.ts";
import { BLAST_V1_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import {
  parseDiscoveryResponse,
  parseWalletLaunchesResponse,
} from "@blast/core/modules/launchpad-discovery/rows.ts";
const request = (query: string) =>
  new Request(`https://blast.test/api/launchpad/discovery?${query}`);
const engine = () => discoveryFixtureEngine({ state: () => "serving" });
test("catalog search and order select a complete set before pagination and reject cross-selection cursors", async () => {
  const fixture = engine();
  const deps = {
    ...fixture,
    fetch: (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/bonding")
        assert.equal(url.searchParams.get("exclude_quote"), CREATE_TEST_SUI_QUOTE_TYPE);
      return fixture.fetch(input);
    },
  };
  const answer = await handleDiscoveryRequest(
    request("catalog=bonding&sort=progress&q=PIXEL&limit=2"),
    deps,
  );
  assert.equal(answer.status, 200);
  const first = parseDiscoveryResponse(await answer.json());
  assert.equal(first.section.state, "available");
  if (first.section.state !== "available") throw Error("unavailable");
  assert.deepEqual(
    first.section.data.rows.map((r) => r.name),
    ["Pixel 7", "Pixel 6"],
  );
  const cursor = first.section.data.nextCursor!;
  const second = parseDiscoveryResponse(
    await (
      await handleDiscoveryRequest(
        request(
          `catalog=bonding&sort=progress&q=pixel&limit=2&cursor=${cursor}`,
        ),
        deps,
      )
    ).json(),
  );
  assert.equal(second.section.state, "available");
  if (second.section.state !== "available") throw Error("unavailable");
  assert.deepEqual(
    second.section.data.rows.map((r) => r.name),
    ["Pixel 5", "Pixel 4"],
  );
  const wrong = await handleDiscoveryRequest(
    request(`catalog=bonding&sort=newest&q=pixel&cursor=${cursor}`),
    deps,
  );
  assert.equal(wrong.status, 400);
});
test("invalid requests fail locally; empty and unavailable remain distinct", async () => {
  for (const q of [
    "catalog=bad",
    "catalog=graduated&sort=progress",
    "catalog=graduated-market-cap&cursor=one",
    "catalog=bonding&q=a&q=b",
    "catalog=bonding&limit=101",
    "catalog=bonding&creator=0x1",
  ]) {
    assert.equal(
      (await handleDiscoveryRequest(request(q), engine())).status,
      400,
      q,
    );
  }
  const empty = await handleDiscoveryRequest(
    request("catalog=bonding&q=doesnotexist"),
    engine(),
  );
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).section.state, "empty");
  const down = await handleDiscoveryRequest(
    request("catalog=bonding"),
    discoveryFixtureEngine({ state: () => "unreachable" }),
  );
  assert.equal(down.status, 503);
  assert.equal(down.headers.get("Cache-Control"), "private, no-store");
  assert.equal((await down.json()).section.state, "unavailable");
});

test("Home selects the highest market caps across pages and shares only complete rankings", async () => {
  const fixture = engine();
  const legacyCoin = BLAST_V1_COINS[0].coinType;
  const caps = new Map([
    ["Lofi the Yeti", "9007199254740992.0001"],
    ["Comet 8", "9007199254740992.0000"],
    ["Comet 7", "9007199254740992"],
    ["Comet 6", "0"],
    ["Comet 5", "99999999999999999"],
  ]);
  let pages = 0;
  let pageSize = 6;
  let secondPageUnavailable = false;
  const deps = {
    ...fixture,
    async fetch(input: string | URL | Request) {
      const url = new URL(String(input));
      pages++;
      assert.equal(url.searchParams.get("limit"), "100");
      assert.equal(url.searchParams.get("stage"), "graduated");
      assert.equal(url.searchParams.get("exclude_quote"), CREATE_TEST_SUI_QUOTE_TYPE);
      if (secondPageUnavailable && url.searchParams.has("cursor"))
        return new Response(null, { status: 503 });
      url.searchParams.set("limit", String(pageSize));
      const response = await fixture.fetch(url);
      const page = await response.json();
      return Response.json({
        ...page,
        pools: page.pools.map((row: { metadata: { name: string }; pool_key: string }) => ({
          ...row,
          ...(row.metadata.name === "Comet 5" ? { coin: legacyCoin } : {}),
          market: row.metadata.name === "Comet 3" ? null : {
            market_cap_usd: caps.get(row.metadata.name) ?? null,
            fdv_usd: row.metadata.name === "Comet 4" ? "99999999999999999" : null,
            change_24h_bps: null,
            interval_end_ms: 100_000_000,
            baseline_timestamp_ms: null,
            baseline_pool: null,
            current_pool: row.pool_key,
            basis: "usd_price",
            baseline_resolution_ms: 300_000,
          },
        })),
      });
    },
  };
  const readLegacy = async () => ({ legacyFdvUsd: { [legacyCoin]: "12.00" } });
  const read = (cache?: ReturnType<typeof createPublicPresaleReader>) =>
    handleDiscoveryRequest(
      new Request(`https://blast.test${GRADUATED_MARKET_CAP_PATH}`),
      deps, undefined, async () => new Set(), cache, readLegacy,
    );
  const cache = createPublicPresaleReader();
  const [response, concurrent] = await Promise.all([read(cache), read(cache)]);
  assert.equal(pages, 2);
  assert.equal(response.status, 200);
  assert.equal(concurrent.status, 200);
  const answer = parseDiscoveryResponse(await response.json());
  assert.equal(answer.view, "graduated");
  assert.equal(answer.legacyFdvUsd?.[legacyCoin], "12.00");
  assert.equal(answer.section.state, "available");
  if (answer.section.state !== "available") throw Error("ranking unavailable");
  const { rows, nextCursor } = answer.section.data;
  assert.equal(nextCursor, null);
  assert.equal(rows.length, 10);
  assert.equal(rows.some((row) => row.coinType === legacyCoin), false);
  assert.deepEqual(
    rows.slice(0, 5).map((row) => row.name),
    ["Lofi the Yeti", "Comet 8", "Comet 7", "Comet 6", "Comet 4"],
  );
  assert.equal(answer.metrics?.[rows[0].launchId].market?.market_cap_usd, "9007199254740992.0001");

  secondPageUnavailable = true;
  const incomplete = await read();
  assert.equal(incomplete.status, 503);
  assert.equal(parseDiscoveryResponse(await incomplete.json()).section.state, "unavailable");

  secondPageUnavailable = false;
  pageSize = 2;
  const pagesBeforeBudget = pages;
  const overBudget = await read();
  assert.equal(overBudget.status, 503);
  assert.equal(pages - pagesBeforeBudget, 4);
});
test("public bonding hides the TSUI launch and keeps the next page", async () => {
  const fixture = engine();
  const deps = {
    ...fixture,
    fetch: async (input: string | URL | Request) => {
      const response = await fixture.fetch(input);
      const url = new URL(String(input));
      if (url.pathname !== "/v1/bonding" || url.searchParams.has("cursor")) return response;
      const page = await response.json();
      page.pools[0].coin = "0xbb95f095a7601a3500ee0a6983459a21ed1c91253ea2a2599eeb1e1ead76ef83::tsui::TSUI";
      return Response.json(page);
    },
  };
  const first = parseDiscoveryResponse(await (await handleDiscoveryRequest(
    request("catalog=bonding&sort=progress&q=pixel&limit=1"), deps,
  )).json());
  if (first.section.state !== "available") throw Error("next page unavailable");
  assert.deepEqual(first.section.data.rows, []);
  const cursor = first.section.data.nextCursor;
  assert.ok(cursor);
  const second = parseDiscoveryResponse(await (await handleDiscoveryRequest(
    request(`catalog=bonding&sort=progress&q=pixel&limit=1&cursor=${cursor}`), deps,
  )).json());
  if (second.section.state !== "available") throw Error("second page unavailable");
  assert.deepEqual(second.section.data.rows.map((row) => row.name), ["Pixel 6"]);
});
test("wallet search uses complete creator selection and private responses", async () => {
  const address = `0x${"a1".repeat(32)}`;
  const url = `https://blast.test/api/launchpad/wallets/${address}/launches?q=ＣＯＭＥＴ&limit=2`;
  const answer = await handleWalletLaunchesRequest(
    new Request(url),
    address,
    engine(),
  );
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("Cache-Control"), "private, no-store");
  const body = parseWalletLaunchesResponse(await answer.json());
  assert.equal(body.section.state, "available");
  if (body.section.state !== "available") throw Error("unavailable");
  assert.equal(body.section.data.rows.length, 2);
  assert.ok(body.section.data.rows.every((r) => r.name?.startsWith("Comet")));
  const other = `0x${"b2".repeat(32)}`;
  const empty = await handleWalletLaunchesRequest(
    new Request(url.replaceAll(address, other)),
    other,
    engine(),
  );
  assert.equal((await empty.json()).section.state, "empty");
});


test("the banner overrides progress with a saved launch at any stage and falls back after removal", async () => {
  const id = (byte: string) => `0x${byte.repeat(32)}`;
  const banner = async (saved: string | null) => {
    const response = await handleDiscoveryRequest(request("catalog=featured"), engine(), async () => saved ? [saved] : []);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = parseDiscoveryResponse(await response.json());
    assert.equal(body.section.state, "available");
    if (body.section.state !== "available") throw Error("unavailable");
    assert.equal(body.section.data.nextCursor, null);
    return { id: body.section.data.rows[0]!.launchId, featured: body.featured };
  };
  const automatic = await banner(null);
  assert.equal(automatic.featured, false);
  for (const byte of ["01", "03", "04", "07"]) {
    assert.deepEqual(await banner(id(byte)), { id: id(byte), featured: true });
  }
  assert.deepEqual(await banner(id("ff")), automatic, "missing");
  assert.deepEqual(await banner(null), automatic, "cleared");
  const ordinary = await handleDiscoveryRequest(request("catalog=bonding&sort=progress&limit=1"), engine(), async () => { throw Error("Catalog must not read pin storage"); });
  assert.equal(ordinary.status, 200);
  assert.equal((await ordinary.json()).section.data.rows[0].launchId, automatic.id);
});

test("banner rejects catalog parameters and fails closed when selection or market is unavailable", async () => {
  for (const extra of ["&q=Comet", "&sort=newest", "&cursor=bad", "&limit=1", "&catalog=featured"]) {
    assert.equal((await handleDiscoveryRequest(request(`catalog=featured${extra}`), engine(), async () => [])).status, 400);
  }
  assert.equal((await handleDiscoveryRequest(request("catalog=featured"), engine(), async () => { throw Error("private database detail"); })).status, 503);
  const response = await handleDiscoveryRequest(request("catalog=featured"), discoveryFixtureEngine({ state: () => "unreachable" }), async () => [`0x${"01".repeat(32)}`]);
  assert.equal(response.status, 503);
});

test("featured curves retain pin order, deduplicate IDs and omit missing selections", async () => {
  const id = (byte: string) => `0x${byte.repeat(32)}`;
  const response = await handleDiscoveryRequest(request("catalog=featured"), engine(), async () => [id("04"), id("07"), id("03"), id("ff"), id("01"), id("04")]);
  const body = parseDiscoveryResponse(await response.json());
  assert.equal(body.featured, true);
  assert.equal(body.section.state, "available");
  if (body.section.state !== "available") throw Error("unavailable");
  assert.deepEqual(body.section.data.rows.map(row => row.launchId), [id("04"), id("07"), id("03"), id("01")]);
  assert.equal(body.section.data.nextCursor, null);
});

test("R3-23: the carousel reads the trust table once for all its rows, picked or automatic", async () => {
  const id = (byte: string) => `0x${byte.repeat(32)}`;
  for (const saved of [[id("01"), id("03"), id("04")], []]) {
    const reads: (readonly string[])[] = [];
    const response = await handleDiscoveryRequest(request("catalog=featured"), engine(), async () => saved, async (coinTypes) => {
      reads.push(coinTypes);
      return new Set(coinTypes.slice(0, 1));
    });
    const body = parseDiscoveryResponse(await response.json());
    if (body.section.state !== "available") throw Error("unavailable");
    assert.equal(reads.length, 1, "one trust read per carousel");
    assert.deepEqual(reads[0], body.section.data.rows.map((row) => row.coinType));
    assert.deepEqual(body.section.data.rows.map((row) => row.verifiedTeam === true), body.section.data.rows.map((_, index) => index === 0));
  }
});
