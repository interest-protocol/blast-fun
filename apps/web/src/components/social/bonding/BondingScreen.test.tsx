import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";

import { handleBondingRequest } from "@blast/server/modules/launchpad-discovery/bonding.ts";
import {
  installTestDom,
  setInputValue,
} from "../../../../test/fixtures/social/test-dom.ts";
import { discoveryFixtureEngine } from "../../../../../../packages/server/test/fixtures/modules/launchpad-discovery/fixture-engine.ts";
import { handleDiscoveryRequest } from "@blast/server/modules/launchpad-discovery/resource.ts";
import type { VerifiedReader } from "@blast/server/modules/launchpad-discovery/verified.ts";
import { FIXTURE_TIMESTAMP_MS } from "../../../../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts";
import { parseDiscoveryResponse, type DiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import type { BondingHeroSeed } from "#web/lib/backend-api/bonding.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { createTestQueryClient, settleQueries, withQueryClient } = await import(
  "#web/lib/query/test-client.ts"
);
const state = {
  signedIn: false,
  status: "signed_out",
  account: null as unknown,
};
Object.assign(globalThis, { __bondingSession: state });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/use-social-account.ts"))
      return {
        url: "data:text/javascript,export const useSocialAccount=()=>({...globalThis.__bondingSession,refresh(){}})",
        shortCircuit: true,
      };
    if (specifier.endsWith("/SignInGate.tsx"))
      return {
        url: 'data:text/javascript,export const useSocialViewer=()=>({...globalThis.__bondingSession,sessionIdentity:"fixture"});export const useSignInGate=()=>({signInHref:"/sign-in",openSignIn(){}})',
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { BondingScreen } = await import("./BondingScreen.tsx");
hooks.deregister();

/** The trust table the served pages read: none verified unless a test says so. */
let trusted: VerifiedReader = async () => new Set();

async function mount(
  t: TestContext,
  failDetails = false,
  delayFeatured = false,
  savedFeature: readonly string[] = [],
  hero?: BondingHeroSeed,
) {
  state.signedIn = false;
  state.status = "signed_out";
  state.account = null;
  const engine = discoveryFixtureEngine({
    state: () => "serving",
    now: () => FIXTURE_TIMESTAMP_MS,
  });
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  let releaseFeatured = () => {};
  const featuredGate = new Promise<void>((resolve) => {
    releaseFeatured = resolve;
  });
  globalThis.fetch = async (input) => {
    const path = String(input);
    // The shell's health poll: the backend is healthy, so empty lists stay honest empties.
    if (path === "/api/social/health") return Response.json({ checkedAt: 1, backend: "healthy", sui: { status: "healthy", checkpoint: "1", timestampMs: 1 } });
    requests.push(path);
    if (
      delayFeatured &&
      path.includes("catalog=featured")
    )
      await featuredGate;
    if (path.startsWith("/api/launchpad/launch-details/")) {
      return failDetails
        ? Response.json({}, { status: 503 })
        : Response.json({
            details: {
              tagline: "A published cover story",
              cover: null,
              links: [],
            },
          });
    }
    if (path.includes("/api/social/me/launches/discovery")) {
      const url = new URL(`https://blast.test${path}`),
        address = url.searchParams.get("wallet")!;
      url.searchParams.delete("wallet");
      return handleBondingRequest(new Request(url), engine, address);
    }
    const response = await handleDiscoveryRequest(
      new Request(`https://blast.test${path}`),
      engine,
      async () => savedFeature,
      trusted,
    );
    const body = (await response.json()) as DiscoveryResponse;
    if (body.section.state === "available" || body.section.state === "stale") {
      const first = body.section.data.rows[0]!;
      return Response.json({
        ...body,
        metrics: {
          [first.launchId]: {
            holders: 0,
            market: {
              market_cap_usd: "50", fdv_usd: "0",
              change_24h_bps: "-125",
              interval_end_ms: 100_000_000,
              baseline_timestamp_ms: 13_300_001,
              baseline_pool: `blast_curve:${first.launchId}`,
              current_pool: `blast_curve:${first.launchId}`,
              basis: "usd_price",
              baseline_resolution_ms: 300_000,
            },
          },
        },
      });
    }
    return Response.json(body);
  };
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    releaseFeatured();
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await act(async () =>
    root.render(withQueryClient(client, <BondingScreen hero={hero} />)),
  );
  if (delayFeatured) {
    await act(async () => {
      const deadline = performance.now() + 2_000;
      while (
        !client.getQueryData([
          "blast",
          "public",
          "bonding-catalog",
          "bonding",
          "progress",
          "",
          null,
        ])
      ) {
        if (performance.now() > deadline)
          throw new Error("Primary page did not settle");
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  } else await act(async () => settleQueries(client));
  return {
    container,
    requests,
    client,
    releaseFeatured,
    rerender: async () =>
      act(async () => root.render(withQueryClient(client, <BondingScreen hero={hero} />))),
  };
}

test("the featured launch follows percentage order; unchanged market refreshes reuse its details", async (t) => {
  const { container, requests, client } = await mount(t);
  assert.match(container.textContent, /Closest to graduation/);
  assert.match(container.textContent, /A published cover story/);
  const slide = container.querySelector('[data-list-row^="featured:"]');
  assert.ok(slide);
  assert.deepEqual(
    Array.from(slide.querySelectorAll("b.num"), (value) => [
      value.previousSibling?.textContent?.trim(),
      value.textContent,
    ]),
    [["FDV", "$0"], ["Holders", "0"]],
  );
  assert.match(container.textContent, /−1\.25%/);
  const lists = requests.filter((path) => path.includes("/discovery?"));
  assert.equal(lists.length, 2);
  assert.ok(
    lists.some(
      (path) =>
        path.includes("catalog=featured"),
    ),
  );
  assert.equal(
    requests.filter((path) => path.includes("/launch-details/")).length,
    1,
  );
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ["blast", "public", "bonding-catalog"],
    });
  });
  await act(async () => settleQueries(client));
  assert.equal(
    requests.filter((path) => path.includes("/launch-details/")).length,
    1,
  );
  const graduated = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Graduated",
  )!;
  await act(async () => graduated.click());
  await act(async () => settleQueries(client));
  assert.ok(
    requests.some(
      (path) =>
        path.includes("catalog=graduated") && path.includes("sort=newest"),
    ),
  );
});

test("a failed optional details read preserves the hero and the market list", async (t) => {
  const { container } = await mount(t, true);
  assert.match(container.textContent, /Closest to graduation/);
  assert.ok(container.querySelector('ol[aria-label="Bonding curves"]'));
  assert.doesNotMatch(
    container.textContent,
    /A published cover story|couldn’t load/,
  );
});

test("a stalled optional hero read cannot hold successful market rows behind loading", async (t) => {
  const { container, client, releaseFeatured } = await mount(t, false, true);
  assert.ok(container.querySelector('ol[aria-label="Bonding curves"]'));
  assert.match(container.textContent, /FDV \$0/);
  assert.doesNotMatch(
    container.textContent,
    /Loading bonding curves|A published cover story/,
  );
  await act(async () => {
    releaseFeatured();
    await settleQueries(client);
  });
  assert.match(container.textContent, /Closest to graduation/);
});

async function editSearch(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>(
    'input[type="search"]',
  )!;
  await act(async () => {
    setInputValue(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
}
test("paging, search and order start from independent selections", async (t) => {
  const { container, requests, client } = await mount(t);
  const initialSort = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Sort bonding curves"]',
  )!;
  await act(async () => {
    initialSort.value = "newest";
    initialSort.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => settleQueries(client));
  const next = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Next page"]',
  )!;
  assert.ok(next);
  await act(async () => next.click());
  await act(async () => settleQueries(client));
  assert.ok(requests.some((path) => path.includes("cursor=")));
  await editSearch(container, "pixel");
  await act(async () => settleQueries(client));
  assert.ok(requests.at(-1)?.includes("q=pixel"));
  assert.ok(!requests.at(-1)?.includes("cursor="));
  const sort = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Sort bonding curves"]',
  )!;
  await act(async () => {
    sort.value = "progress";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => settleQueries(client));
  assert.ok(requests.at(-1)?.includes("sort=progress"));
  assert.ok(!requests.at(-1)?.includes("cursor="));
  await editSearch(container, "no-such-coin");
  await act(async () => settleQueries(client));
  assert.match(container.textContent!, /No matching/);
  assert.equal(container.querySelector('select[aria-label="Sort bonding curves"]'), null);
  await editSearch(container, "");
  assert.ok(container.querySelector('select[aria-label="Sort bonding curves"]'), "a pending or loaded Live list keeps its sort");
});
test("My launches requires sign-in, scopes reads to linked wallets and clears rows on wallet/account changes", async (t) => {
  const { container, requests, client, rerender } = await mount(t);
  const mine = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "My launches",
  )!;
  await act(async () => mine.click());
  assert.match(container.textContent!, /Sign in to see/);
  assert.ok(!requests.some((p) => p.includes("/me/launches/discovery")));
  const a = `0x${"a1".repeat(32)}`,
    b = `0x${"b2".repeat(32)}`;
  state.signedIn = true;
  state.status = "ready";
  state.account = {
    account_id: "one",
    wallets: [{ address: a }, { address: b }],
  };
  await rerender();
  await act(async () => settleQueries(client));
  assert.ok(requests.some((p) => p.includes(`wallet=${a}`)));
  const wallet = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Launch wallet"]',
  )!;
  await act(async () => {
    wallet.value = b;
    wallet.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => settleQueries(client));
  assert.match(container.textContent!, /No launches for this wallet/);
  assert.ok(requests.at(-1)?.includes(b));
  state.signedIn = false;
  state.status = "signed_out";
  state.account = null;
  await rerender();
  assert.match(container.textContent!, /Sign in to see/);
});


test("an operator-picked banner keeps launch details and identifies the manual selection", async (t) => {
  const { container } = await mount(t, false, false, [`0x${"04".repeat(32)}`]);
  assert.match(container.textContent, /Featured curve · .* to graduation/);
  assert.match(container.textContent, /A published cover story/);
  assert.ok(container.querySelector('ol[aria-label="Bonding curves"]'));
});

test("multiple saved curves share the presale carousel with bonding labels and independent slides", async (t) => {
  const { container } = await mount(t, false, false, ["04", "03"].map(byte => `0x${byte.repeat(32)}`));
  const carousel = container.querySelector('[aria-roledescription="carousel"]')!;
  assert.equal(carousel.getAttribute("aria-label"), "Featured bonding curves");
  const slides = carousel.querySelectorAll(".slide:not([data-visual-copy])");
  assert.equal(slides.length, 2);
  assert.ok(slides[1].hasAttribute("inert"));
  assert.ok(container.querySelector('[aria-label="Next featured bonding curves"]'));
  assert.ok(container.querySelector('[aria-label="Pause featured bonding curves"]'));
});


test("the featured curve is compact without a cover and only appears on the Live tab", async (t) => {
  const { container } = await mount(t);
  const feature = container.querySelector('[aria-label="Selected bonding curves"] a')!;
  assert.ok(feature);
  assert.equal(feature.hasAttribute("data-has-cover"), false);
  const graduated = [...container.querySelectorAll("button")].find((button) => button.textContent === "Graduated")!;
  await act(async () => graduated.click());
  assert.equal(container.querySelector('[aria-label="Selected bonding curves"] a'), null);
  assert.equal(container.querySelector('select[aria-label="Sort bonding curves"]'), null);
  const mine = [...container.querySelectorAll("button")].find((button) => button.textContent === "My launches")!;
  await act(async () => mine.click());
  assert.equal(container.querySelector('[aria-label="Selected bonding curves"] a'), null);
});

/** What the page's server read hands the screen: the backend's featured answer, every slide's details. */
async function heroSeed(savedFeature: readonly string[], read: VerifiedReader = async () => new Set()): Promise<BondingHeroSeed> {
  const engine = discoveryFixtureEngine({ state: () => "serving", now: () => FIXTURE_TIMESTAMP_MS });
  const response = await handleDiscoveryRequest(
    new Request("https://blast.test/api/launchpad/discovery?catalog=featured"),
    engine,
    async () => savedFeature,
    read,
  );
  const answer = parseDiscoveryResponse(await response.json());
  const rows = answer.section.state === "available" ? answer.section.data.rows : [];
  const details = { tagline: "A server-read story", cover: { url: "https://cdn.test/cover.webp", width: 1536, height: 512 }, links: [] };
  return { answer, details: Object.fromEntries(rows.map((row) => [row.launchId, details])), nowMs: Date.now() };
}

test("a server-read hero is in the first paint, above the tabs, with its tagline and cover", async () => {
  const hero = await heroSeed(["04", "03"].map((byte) => `0x${byte.repeat(32)}`));
  const html = renderToString(withQueryClient(createTestQueryClient(), <BondingScreen hero={hero} />));
  assert.ok(html.indexOf('aria-label="Selected bonding curves"') >= 0);
  assert.ok(html.indexOf('aria-label="Selected bonding curves"') < html.indexOf("Curve stage"), "the hero sits above the tab bar");
  assert.equal(html.match(/A server-read story/g)?.length, 2, "every slide has its tagline");
  assert.equal(html.match(/data-has-cover/g)?.length, 2, "every slide reserves its cover");
  const bare = renderToString(withQueryClient(createTestQueryClient(), <BondingScreen />));
  assert.equal(bare.includes("Selected bonding curves"), false, "without the server read the browser reads the hero");
});

test("a server-read hero is not read again by the browser", async (t) => {
  const saved = [`0x${"04".repeat(32)}`];
  const { container, requests } = await mount(t, false, false, saved, await heroSeed(saved));
  assert.match(container.textContent, /Featured curve · .* to graduation/);
  assert.match(container.textContent, /A server-read story/);
  assert.ok(container.querySelector('ol[aria-label="Bonding curves"]'));
  assert.equal(requests.some((path) => path.includes("catalog=featured") || path.includes("/launch-details/")), false);
});

test("R3-23: a verified curve shows the mark after its name on the featured slide and in the list, and nowhere else", async (t) => {
  const marks = (root: ParentNode) => root.querySelectorAll('svg[aria-label="Known deployer"]').length;
  const saved = ["04", "03"].map((byte) => `0x${byte.repeat(32)}`);
  const first = async (coinTypes: readonly string[]) => new Set(coinTypes.slice(0, 1));
  const html = renderToString(withQueryClient(createTestQueryClient(), <BondingScreen hero={await heroSeed(saved, first)} />));
  assert.equal(html.match(/aria-label="Known deployer"/g)?.length, 1, "only the verified slide is marked");
  assert.match(html, /<b>(?:[^<]* )?<span class="markTail"><span>[^< ]+<\/span> <svg aria-label="Known deployer"/, "the mark follows the name's last word, wrapping with it");

  trusted = first;
  t.after(() => { trusted = async () => new Set(); });
  const { container } = await mount(t);
  const list = container.querySelector('ol[aria-label="Bonding curves"]')!;
  const cards = [...list.querySelectorAll("a")];
  assert.equal(marks(cards[0]!), 1);
  assert.equal(marks(cards[0]!.querySelector("b")!), 1, "the mark follows the name, inside the link's accessible name");
  assert.equal(cards.slice(1).reduce((sum, card) => sum + marks(card), 0), 0);
});
