import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, testEvent } from "../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
Object.assign(document, { oninput: null });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient } = await import("@tanstack/react-query");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { PresaleCard, PresalesList } = await import("./PresalesList");
const { fixtureList, fixtureViewer, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
const { EMPTY_SALE_METADATA } = await import("@blast/core/modules/social/contracts/sales.ts");
const { presaleListQuery } = await import("../social/queries.ts");

const catalogPresaleId = (index: number) => `0x${index.toString(16).padStart(64, "0")}`;

const cover = { url: "https://projects.example/cover.webp", width: 1536, height: 512 };

test("cards use summary metadata and fall back cleanly when a cover fails or changes", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const summary = fixtureList("live", "ending").presales[0]!;
  const sale = { ...summary, raised_atoms: (BigInt(summary.target_atoms) * 101n / 100n).toString(), fill_bps: 10100, metadata: { ...EMPTY_SALE_METADATA, tagline: "The creator's real project description", cover } };
  const render = (next = sale) => <PresaleCard now={FIXTURE_NOW} sale={next} viewer={null} />;
  await act(async () => root.render(render()));
  const banner = container.querySelector(".tile-cover")!;
  const palette = banner.getAttribute("data-cover-palette");
  assert.equal(container.querySelector(".tile-cover img")?.getAttribute("src"), cover.url);
  // Cards lead with the cover; the description belongs to the presale page and the featured hero.
  assert.doesNotMatch(container.textContent!, /The creator's real project description/);
  assert.match(container.textContent!, /101%/);
  assert.equal(container.querySelector("a")?.getAttribute("href"), `/presale/${sale.presale_id}`);
  await act(async () => container.querySelector(".tile-cover img")!.dispatchEvent(testEvent("error")));
  assert.ok(container.querySelector(".tile-cover"));
  assert.equal(container.querySelector(".tile-cover img"), null);
  assert.equal(container.querySelector(".presale-tile-no-cover"), null);
  assert.equal(container.querySelector(".tile-cover"), banner);
  assert.equal(banner.getAttribute("data-cover-palette"), palette);
  assert.ok(container.querySelector("article.presale-tile > a.tile-link"));
  await act(async () => root.render(render({ ...sale, metadata: { ...sale.metadata, cover: { ...cover, url: "https://projects.example/replacement.webp" } } })));
  assert.match(container.querySelector(".tile-cover img")!.getAttribute("src")!, /replacement/);
  const overflow = { ...sale, raised_atoms: (BigInt(sale.target_atoms) + 1n).toString() };
  await act(async () => root.render(render(overflow)));
  assert.match(container.textContent!, /Above target/);
  assert.doesNotMatch(container.textContent!, /Allocation is proportional|Unallocated payment/);
  await act(async () => root.render(render({ ...overflow, phase: "cancelled" })));
  assert.doesNotMatch(container.textContent!, /Commitments are fully refundable/);
  assert.doesNotMatch(container.textContent!, /Allocation is proportional/);
  const pending = fixtureList("upcoming", "opening").presales[0]!;
  await act(async () => root.render(<PresaleCard key={pending.presale_id} now={FIXTURE_NOW} sale={pending} viewer={null} />));
  assert.equal(container.querySelector('[role="progressbar"][aria-label="Funding target progress"]'), null);
  assert.match(container.textContent!, /Starts in/);
  assert.doesNotMatch(container.textContent!, /Committed \/ funding target/);
  assert.match(container.querySelector(".tile-amount")!.textContent!, /[\d,]+ USDC/);
  assert.match(container.textContent!, /interested/);
  assert.doesNotMatch(container.textContent!, /0 backers/);
});

test("a Live card shows new funding and marks an exact target crossing once", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });

  const sale = {
    ...fixtureList("live", "ending").presales[0]!,
    quote_symbol: "SUI",
    quote_decimals: 9,
    target_atoms: "1000000000000",
  };
  const update = (raised_atoms: string) => act(async () => root.render(
    <PresaleCard now={FIXTURE_NOW} sale={{ ...sale, raised_atoms }} viewer={null} />,
  ));
  const cue = () => container.querySelector('[role="status"]')?.textContent;

  await update("500000000000");
  assert.equal(cue(), "");
  await update("750000000000");
  assert.equal(cue(), "+250\u00a0SUI raised");
  assert.equal(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "75");
  await update("1000000000000");
  assert.equal(cue(), "Target reached");
  await update("990000000000");
  assert.equal(cue(), "");
  await update("1000000000000");
  assert.equal(cue(), "+10\u00a0SUI raised");
});

test("Cards default on the left; List / Cards keeps loaded pages, order, filters, focus and browser history", async (t) => {
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  window.history.replaceState(null, "", "/presale");
  const first = fixtureList("live", "pinned");
  const next = { ...first.presales[0]!, presale_id: catalogPresaleId(60), name: "Later project", metadata: { ...EMPTY_SALE_METADATA, cover } };
  let reads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { reads++; return Response.json({ ...first, presales: [next], next_cursor: null }); };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  const nowMs = FIXTURE_NOW;
  client.setQueryData(presaleListQuery({ status: "live", sort: "pinned" }).queryKey, first);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); globalThis.fetch = originalFetch; window.history.replaceState(null, "", "/presale"); });
  await act(async () => root.render(<QueryProvider client={client}><PresalesList initial={{ ...first, next_cursor: "page-2" }} nowMs={nowMs} sort="pinned" status="live" view="list" /></QueryProvider>));
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find((button) => (button.getAttribute("aria-label") ?? button.textContent) === label);
    assert.ok(found, label);
    return found;
  };
  assert.ok(container.querySelector(".presale-grid"));
  assert.equal(button("Cards").getAttribute("aria-pressed"), "true");
  assert.deepEqual([...container.querySelectorAll('.result-layout button')].map((element) => element.textContent), ["Cards", "List"]);
  // Two cards leave the grid short of a row of its 18, so it reads the next page without a click.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert.equal(reads, 1);
  const hrefs = () => [...container.querySelectorAll(".rows2 > a, .presale-grid > article > a")].map((link) => link.getAttribute("href"));
  const loaded = hrefs();
  assert.equal(loaded.length, first.presales.length + 1);
  await act(async () => { button("List").focus(); button("List").click(); });
  assert.equal(document.activeElement, button("List"));
  assert.equal(button("List").getAttribute("aria-pressed"), "true");
  assert.ok(container.querySelector(".rows2"));
  assert.deepEqual(hrefs(), loaded);
  assert.equal(reads, 1);
  assert.equal(window.location.search, "?layout=list");
  await act(async () => { button("Cards").focus(); button("Cards").click(); });
  assert.equal(document.activeElement, button("Cards"));
  assert.equal(button("Cards").getAttribute("aria-pressed"), "true");
  assert.deepEqual(hrefs(), loaded);
  assert.equal(reads, 1);
  assert.ok(container.querySelector(".presale-grid .tile-cover"));
  assert.equal(window.location.search, "");
  assert.ok(container.querySelector('[aria-label="Filters, Pinned first"]'));
  await act(async () => button("List").click());
  assert.deepEqual(hrefs(), loaded);
  assert.equal(reads, 1);
  assert.equal(window.location.search, "?layout=list");
  await act(async () => {
    window.history.replaceState(null, "", "/presale");
    window.dispatchEvent(testEvent("popstate"));
  });
  assert.equal(button("Cards").getAttribute("aria-pressed"), "true");
  assert.deepEqual(hrefs(), loaded, "browser history across layouts retains paginated projects");
  assert.equal(reads, 1);
  await act(async () => {
    window.history.replaceState(null, "", "/presale?layout=list");
    window.dispatchEvent(testEvent("popstate"));
  });
  assert.equal(button("List").getAttribute("aria-pressed"), "true");
  assert.deepEqual(hrefs(), loaded);
  assert.equal(reads, 1);
});

test("search filters loaded projects by ticker and address, announces empty results, and can clear", async (t) => {
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  window.history.replaceState(null, "", "/presale");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  const initial = fixtureList("live", "pinned");
  client.setQueryData(presaleListQuery({ status: "live", sort: "pinned" }).queryKey, initial);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><PresalesList initial={initial} nowMs={FIXTURE_NOW} status="live" sort="pinned" view="list" /></QueryProvider>));
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const fill = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(testEvent("input"));
  });
  for (const value of [initial.presales[0]!.symbol, initial.presales[0]!.presale_id]) {
    await fill(value);
    assert.equal(container.querySelectorAll(".presale-tile").length, 1);
  }
  await fill("No such project");
  assert.match(container.textContent!, /No matching presales/);
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Clear search")!.click());
  assert.equal(container.querySelectorAll(".presale-tile").length, initial.presales.length);
});

test("search continues through 53 presales without a false catalog-wide negative", async (t) => {
  window.history.replaceState(null, "", "/presale?status=ended");
  const seed = fixtureList("ended", "recent");
  const sales = Array.from({ length: 53 }, (_, index) => ({
    ...seed.presales[0]!,
    presale_id: catalogPresaleId(index + 1),
    symbol: index === 48 ? "ALON" : `TOKEN${index}`,
    name: index === 48 ? "Alon" : `Project ${index}`,
  }));
  const page = (start: number, end: number, next: string | null) => ({ ...seed, presales: sales.slice(start, end), next_cursor: next });
  const initial = page(0, 20, "page-2");
  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), window.location.href);
    requests.push(url);
    if (url.searchParams.get("sort") === "best") {
      const next = url.searchParams.get("cursor") === "best-next";
      return Response.json({ ...seed, presales: next ? [sales[0]] : [{ ...sales[48]!, presale_id: catalogPresaleId(61) }], next_cursor: next ? null : "best-next" });
    }
    return Response.json(url.searchParams.get("cursor") === "page-2" ? page(20, 40, "page-3") : page(40, 53, null));
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  client.setQueryData(presaleListQuery({ status: "ended", sort: "recent" }).queryKey, initial);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); globalThis.fetch = originalFetch; window.history.replaceState(null, "", "/presale"); });
  await act(async () => root.render(<QueryProvider client={client}><PresalesList initial={initial} nowMs={FIXTURE_NOW} status="ended" sort="recent" view="list" /></QueryProvider>));
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const fill = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(testEvent("input"));
  });
  const click = async (label: string) => act(async () => {
    const button = [...container.querySelectorAll("button")].find(button => (button.getAttribute("aria-label") ?? button.textContent) === label);
    assert.ok(button, label);
    button.click();
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  await fill("alon");
  assert.equal(container.querySelector(".card.empty .title")?.textContent, "No matches in loaded presales");
  assert.match(container.querySelector(".catalog-search-note")?.textContent ?? "", /0 matches in 20 loaded presales/);
  assert.equal(requests.length, 0, "search does not eagerly walk the catalog");
  await click("Show more");
  assert.equal(container.querySelector(".card.empty .title")?.textContent, "No matches in loaded presales");
  assert.match(container.querySelector(".catalog-search-note")?.textContent ?? "", /0 matches in 40 loaded presales/);
  await click("Show more");
  assert.equal(container.querySelectorAll(".presale-tile").length, 1);
  assert.equal(container.querySelector(".presale-tile a")?.getAttribute("href"), `/presale/${catalogPresaleId(49)}`);
  assert.match(container.querySelector(".catalog-search-note")?.textContent ?? "", /1 match in all 53 presales/);
  assert.deepEqual(requests.map(url => [url.searchParams.get("status"), url.searchParams.get("sort"), url.searchParams.get("cursor")]), [["ended", "recent", "page-2"], ["ended", "recent", "page-3"]]);
  await click("List");
  assert.equal(container.querySelectorAll(".rows2 > a").length, 1);
  await fill("not-a-project");
  assert.equal(container.querySelectorAll(".rows2 > a").length, 0);
  assert.equal(container.querySelector(".card.empty .title")?.textContent, "No matching presales");
  assert.match(container.querySelector(".catalog-search-note")?.textContent ?? "", /0 matches in all 53 presales/);
  await fill("alon");
  assert.equal(container.querySelectorAll(".rows2 > a").length, 1);
  assert.equal(requests.length, 2, "query and layout changes reuse the already searched catalog");
  await act(async () => {
    window.history.replaceState(null, "", "/presale?status=ended&sort=best&layout=list");
    window.dispatchEvent(testEvent("popstate"));
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  assert.equal(input.value, "alon");
  assert.equal(container.querySelector(".rows2 > a")?.getAttribute("href"), `/presale/${catalogPresaleId(61)}`, "changing sort discards previous-page results");
  assert.match(container.querySelector(".catalog-search-note")?.textContent ?? "", /1 match in 1 loaded presale\./);
  await click("Show more");
  assert.deepEqual(requests.slice(2).map(url => [url.searchParams.get("sort"), url.searchParams.get("cursor")]), [["best", null], ["best", "best-next"]]);
  assert.equal(container.querySelectorAll(".rows2 > a").length, 1, "the previous sort's cursor and matches cannot leak");
  assert.match(container.querySelector(".catalog-search-note")?.textContent ?? "", /1 match in all 2 presales/);
});

test("an elapsed lifecycle boundary refreshes the authoritative page and removes departed rows", async (t) => {
  window.history.replaceState(null, "", "/presale?status=upcoming");
  const page = fixtureList("upcoming", "opening");
  const initial = { ...page, presales: [{ ...page.presales[0]!, start_ms: FIXTURE_NOW - 1 }] };
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async () => { reads++; return Response.json({ ...page, presales: [], next_cursor: null }); };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  client.setQueryData(presaleListQuery({ status: "upcoming", sort: "opening" }).queryKey, initial);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); globalThis.fetch = originalFetch; window.history.replaceState(null, "", "/presale"); });
  await act(async () => {
    root.render(<QueryProvider client={client}><PresalesList initial={initial} nowMs={FIXTURE_NOW} status="upcoming" sort="opening" view="list" /></QueryProvider>);
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  assert.equal(reads, 1);
  assert.equal(container.querySelectorAll(".presale-tile").length, 0);
  assert.match(container.textContent!, /No upcoming presales/);
});

test("cards omit descriptions, and show only established contract tags", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const sale = fixtureList("live", "ending").presales[0]!;
  await act(async () => root.render(<PresaleCard now={FIXTURE_NOW} sale={{ ...sale, metadata: null, allowlisted: true, hard_cap: false }} viewer={null} />));
  assert.equal(container.querySelector(".tile-tagline"), null);
  assert.match(container.textContent!, /Allowlist/);
  assert.doesNotMatch(container.textContent!, /Can raise above target/);
  assert.equal(container.querySelector(".status"), null);
  await act(async () => root.render(<PresaleCard now={FIXTURE_NOW} sale={{ ...sale, hard_cap: null, allowlisted: false, metadata: { ...EMPTY_SALE_METADATA, tagline: "🚀".repeat(120) } }} viewer={null} />));
  assert.equal(container.querySelector(".tile-tagline"), null, "a long legacy description never reaches the card");
  assert.doesNotMatch(container.textContent!, /Allowlist|Can raise above target|Funding cap/);
});

test("card social proof reserves a separate footer and deduplicates eligible backers in stable order", async (t) => {
  const container = document.createElement("div"); container.setAttribute("data-blast-ui", ""); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const sale = fixtureList("live", "ending").presales[0]!;
  const entry = Object.values(fixtureViewer()).find(item => item.following.length >= 4)!;
  const following = entry.following.slice(0, 4).map((row, i) => ({ ...row, account: { ...row.account, avatar_url: i === 0 ? null : row.account.avatar_url, display_name: i === 0 ? "A very long full display name 🚀 ኔፋሪ" : row.account.display_name } }));
  const render = (rows: typeof following | null) => <PresaleCard now={FIXTURE_NOW} sale={sale} showStatus viewer={rows === null ? null : { [sale.presale_id]: { ...entry, following: rows } }} />;
  await act(async () => root.render(render(null)));
  const footer = container.querySelector(".tile-social");
  assert.ok(footer);
  assert.equal(footer.textContent, "");
  assert.ok(container.querySelector(".tile-tags .status"), "phase status belongs below countdown, outside identity");
  assert.equal(container.querySelector(".tile-identity .status"), null);
  await act(async () => root.render(render([...following].reverse().concat(following[0]))));
  assert.equal(container.querySelector(".tile-social"), footer, "loading social data reuses the reserved footer");
  assert.equal(footer.textContent, "+1Backed this.");
  assert.equal(container.querySelector("a button"), null, "social controls are siblings of the link");
  const buttons = [...footer.querySelectorAll("button")];
  assert.equal(buttons.length, 4);
  const names = () => [...footer.querySelectorAll("button")].map(button => button.getAttribute("aria-label"));
  const originalOrder = names();
  const expected = [...following].sort((a, b) => a.account.callsign < b.account.callsign ? -1 : 1);
  assert.deepEqual(originalOrder.slice(0, 3), expected.slice(0, 3).map(row => `${row.account.display_name ?? row.account.callsign} backed this.`));
  assert.equal(originalOrder[3], "Show 1 more backer you follow");
  assert.ok(footer.querySelector('[data-avatar="generated"]'), "missing photos use the existing account fallback");
  for (const image of footer.querySelectorAll("img")) {
    assert.equal(image.getAttribute("width"), "24");
    assert.notEqual(image.getAttribute("src"), sale.icon_url);
  }
  await act(async () => root.render(render(following)));
  assert.deepEqual(names(), originalOrder, "API reordering never rearranges the avatars");
  await act(async () => root.render(render([])));
  assert.equal(footer.textContent, "");
  assert.equal(container.querySelector(".tile-social"), footer);
  assert.doesNotMatch(container.textContent!, /No friends backed/);
});

/** The Presales board's card reads "X COIN of Y" beside an 18px mark; a list row keeps "X of Y COIN" beside a 16px one. */
function amountWords(card: boolean, raised: string, symbol: string) {
  return card
    ? { text: `${raised} ${symbol} of 20,000`, bold: `${raised} ${symbol}`, mark: "18" }
    : { text: `${raised} of 20,000 ${symbol}`, bold: raised, mark: "16" };
}

test("fundraising uses trusted currency identity, one visible ticker and a complete link description", async (t) => {
  const { CORE_COINS } = await import("@blast/core/modules/social/portfolio/core-coins.ts");
  const { PresaleRow } = await import("./PresalesList");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const base = fixtureList("live", "ending").presales[0]!;
  for (const Component of [PresaleCard, PresaleRow]) {
    for (const currency of ["USDC", "SUI", "WAL"].map((symbol) => CORE_COINS.find((coin) => coin.symbol === symbol)!)) {
      for (const raised of [0n, 10_000n, 20_000n, 25_000n]) {
        const decimals = "decimals" in currency ? currency.decimals : 9;
        const sale = { ...base, quote_type: currency.coinType, quote_symbol: currency.symbol, quote_decimals: decimals, raised_atoms: (raised * 10n ** BigInt(decimals)).toString(), target_atoms: (20_000n * 10n ** BigInt(decimals)).toString() };
        await act(async () => root.render(<Component key={`${currency.coinType}-${raised}`} now={FIXTURE_NOW} sale={sale} viewer={null} />));
        const amounts = container.querySelector(".catalog-amount")!;
        const expected = amountWords(Component === PresaleCard, raised.toLocaleString("en-US"), currency.symbol);
        assert.equal(amounts.textContent, expected.text);
        assert.equal(amounts.querySelector("b")?.textContent, expected.bold);
        assert.equal(amounts.getAttribute("aria-hidden"), "true");
        if (currency.symbol === "SUI" || currency.symbol === "USDC") {
          const artwork = amounts.querySelector("svg");
          assert.equal(artwork?.querySelector("image")?.getAttribute("href"), `/blast-ui/coins/${currency.symbol.toLowerCase()}.svg`);
          assert.equal(artwork?.getAttribute("width"), expected.mark);
        } else {
          const artwork = amounts.querySelector("img");
          assert.equal(artwork?.getAttribute("src"), currency.logoUrl);
          assert.equal(artwork?.getAttribute("width"), expected.mark);
        }
        const link = container.querySelector("a")!;
        const description = document.getElementById(link.getAttribute("aria-describedby")!)!;
        assert.equal(description.textContent, `${raised.toLocaleString("en-US")} ${currency.symbol} raised of a 20,000 ${currency.symbol} target, ${Number(raised) / 200} percent funded.`);
        assert.ok(description.hidden);
      }
    }
  }
  const image = container.querySelector(".catalog-amount img")!;
  const reserved = image.parentElement;
  await act(async () => image.dispatchEvent(testEvent("error")));
  assert.equal(container.querySelector(".catalog-amount img"), null);
  assert.equal(container.querySelector(".catalog-amount svg[data-generated]")?.parentElement, reserved);
  assert.match(container.querySelector(".catalog-amount")!.textContent!, /of [\d,]+ WAL$/);
  await act(async () => root.render(<PresaleCard now={FIXTURE_NOW} sale={{ ...base, quote_type: "0x42::test::TEST", quote_symbol: "USDC" }} viewer={null} />));
  assert.equal(container.querySelector(".catalog-amount img"), null, "an untrusted type with a familiar ticker must use the fallback");
  assert.ok(container.querySelector(".catalog-amount svg[data-generated]"));
});
