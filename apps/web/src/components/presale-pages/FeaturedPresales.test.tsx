import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_SALE_METADATA } from "@blast/core/web/contracts/sales.ts";
import { installTestDom, testEvent } from "../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient } = await import("@tanstack/react-query");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { settleQueries } = await import("#web/lib/query/test-client.ts");
const { featuredPresalesQuery, presaleListQuery } = await import("../social/queries.ts");
const { FeaturedPresales } = await import("./FeaturedPresales");
const { FeaturedArtwork } = await import("./FeaturedArtwork");
const { FeaturedCarousel } = await import("./FeaturedCarousel");
const { PresalesList } = await import("./PresalesList");
const { SocialViewerProvider } = await import("#web/components/social/SignInGate.tsx");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { fixtureList, fixtureViewer, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
const live = fixtureList("live", "ending").presales;

test("carousel position follows scrolling and disappears for a single presale", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = async (secondSlide: boolean) => act(async () => root.render(<FeaturedCarousel><div>First presale</div>{secondSlide ? <div>Second presale</div> : null}</FeaturedCarousel>));
  await render(true);
  const track = container.querySelector<HTMLElement>('[aria-roledescription="carousel"]')!;
  Object.defineProperties(track, { clientWidth: { value: 300 }, scrollWidth: { value: 1236, configurable: true } });
  track.scrollLeft = 312;
  const progress = () => container.querySelector('.position');
  await act(async () => track.dispatchEvent(testEvent("scroll")));
  assert.equal(progress()?.getAttribute("aria-label"), "Presale 1 of 2");
  assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="Previous featured presales"]')?.disabled, false);
  await act(async () => { track.scrollLeft = 624; track.dispatchEvent(testEvent("scroll")); });
  assert.equal(progress()?.textContent, "2 / 2");
  assert.equal(progress()?.getAttribute("aria-label"), "Presale 2 of 2");
  assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="Next featured presales"]')?.disabled, false);
  track.scrollLeft = 0;
  Object.defineProperty(track, "scrollWidth", { value: 300 });
  await render(false);
  assert.equal(progress(), null);
  assert.equal(container.querySelector('[class*="arrows"]')?.hasAttribute("hidden"), true);
});

test("launches entering and leaving ahead of the focused card keep it selected", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const firstPresale = <a href="#first" key="first">First presale</a>;
  const secondPresale = <a href="#second" key="second">Second presale</a>;
  const render = (...cards: (typeof firstPresale)[]) => act(async () => root.render(
    <FeaturedCarousel kind="launches">{cards}</FeaturedCarousel>,
  ));
  await render(firstPresale, secondPresale);
  const track = container.querySelector<HTMLElement>('[aria-roledescription="carousel"]')!;
  Object.defineProperties(track, { clientWidth: { value: 300 }, scrollWidth: { value: 1236, configurable: true } });
  track.scrollLeft = 312;
  t.mock.method(track, "scrollTo", (options: ScrollToOptions) => {
    track.scrollLeft = options.left ?? 0;
  });
  const first = track.querySelector<HTMLAnchorElement>(".slide:not([inert]) a")!;
  await act(async () => first.focus());
  assert.ok(document.activeElement === first);

  Object.defineProperty(track, "scrollWidth", { value: 1548 });
  await render(<a href="#curve" key="curve">Curve</a>, firstPresale, secondPresale);

  assert.equal(track.querySelector(".slide:not([inert]) a")?.getAttribute("href"), "#first");
  assert.ok(document.activeElement === first);
  assert.equal(track.scrollLeft, 624);
  assert.equal(container.querySelector(".position")?.getAttribute("aria-label"), "Launch 2 of 3");

  await render(firstPresale, secondPresale, <a href="#next" key="next">Next curve</a>);

  assert.equal(track.querySelector(".slide:not([inert]) a")?.getAttribute("href"), "#first");
  assert.ok(document.activeElement === first);
  assert.equal(track.scrollLeft, 312);
  assert.equal(container.querySelector(".position")?.getAttribute("aria-label"), "Launch 1 of 3");
});

test("a completed carousel fill advances and wraps; pause, focus and pointer-down prevent rotation", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<FeaturedCarousel><a href="#first">First</a><a href="#second">Second</a></FeaturedCarousel>));
  const track = container.querySelector<HTMLElement>('[aria-roledescription="carousel"]')!;
  Object.defineProperties(track, { clientWidth: { value: 300 }, scrollWidth: { value: 1236 } });
  track.scrollLeft = 312;
  const moves: number[] = [];
  t.mock.method(track, "scrollTo", (options: ScrollToOptions) => {
    if (options.behavior === "smooth") moves.push((options.left ?? 0) - track.scrollLeft);
    track.scrollLeft = options.left ?? 0;
    track.dispatchEvent(testEvent("scroll"));
  });
  // jsdom lacks AnimationEvent, so React registers its WebKit event fallback.
  const complete = async () => act(async () => container.querySelector('.timer')!.dispatchEvent(testEvent("webkitAnimationEnd", { animationName: "carousel-fill" })));
  const click = async (label: string) => act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label} featured presales"]`)!.click());
  await complete();
  assert.equal(moves[0], 312);
  assert.equal(container.querySelector('.position')?.getAttribute("aria-label"), "Presale 2 of 2");
  await complete();
  assert.equal(moves[1], 312, "autoplay keeps moving forward at the wrap");
  assert.equal(container.querySelector('.position')?.getAttribute("aria-label"), "Presale 1 of 2");
  assert.equal(track.scrollLeft, 312, "the real first card takes over from its copy");
  await click("Pause"); await complete();
  assert.equal(moves.length, 2);
  await click("Play");
  await act(async () => track.querySelector<HTMLAnchorElement>(".slide:not([inert]) a")!.focus());
  await complete(); assert.equal(moves.length, 2);
  await click("Play");
  await act(async () => track.querySelector(".slide:not([inert]) a")!.dispatchEvent(testEvent("pointerdown", { pointerType: "touch" })));
  await complete(); assert.equal(moves.length, 2);
  await click("Play");
  const dialog = document.createElement("dialog"); dialog.setAttribute("open", ""); document.body.append(dialog);
  await complete(); assert.equal(moves.length, 2);
  dialog.remove();
  const pending = document.createElement("div"); pending.dataset.kind = "commit";
  pending.innerHTML = '<button aria-busy="true">Confirm in your wallet</button>'; track.append(pending);
  await complete(); assert.equal(moves.length, 2, "a pending purchase cannot auto-rotate");
  await act(async () => { pending.remove(); });
  await complete(); assert.equal(moves.length, 2, "completion requires explicit Play after a pending purchase");
  await click("Play");
  await complete(); assert.equal(moves.length, 3);
});

test("reduced motion starts with manual navigation and allows explicit playback", async (t) => {
  window.reducedMotion = true;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); window.reducedMotion = false; container.remove(); });
  await act(async () => root.render(<FeaturedCarousel><div>First</div><div>Second</div></FeaturedCarousel>));
  assert.ok(container.querySelector('[aria-label="Play featured presales"]'));
  assert.ok(container.querySelector('[data-static="true"]'));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Play featured presales"]')!.click());
  assert.ok(container.querySelector('[aria-label="Pause featured presales"]'));
  assert.equal(container.querySelector('[data-paused]'), null);
});

test("visibility and open purchase details freeze the slide clock, and navigation resets it", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
  t.after(async () => {
    await act(async () => root.unmount()); container.remove();
    if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
    else Reflect.deleteProperty(document, "hidden");
  });
  await act(async () => root.render(<FeaturedCarousel><div data-kind="commit"><details><summary>Allocation details</summary>Breakdown</details></div><p>Second</p></FeaturedCarousel>));
  const track = container.querySelector<HTMLElement>('[aria-roledescription="carousel"]')!;
  Object.defineProperties(track, { clientWidth: { value: 300 }, scrollWidth: { value: 1236 } });
  track.scrollLeft = 312;
  const moves: ScrollToOptions[] = [];
  t.mock.method(track, "scrollTo", (options: ScrollToOptions) => {
    if (options.behavior === "smooth") moves.push(options);
    track.scrollLeft = options.left ?? 0;
    track.dispatchEvent(testEvent("scroll"));
  });
  const complete = async () => act(async () => container.querySelector('.timer')!.dispatchEvent(testEvent("webkitAnimationEnd", { animationName: "carousel-fill" })));
  const details = container.querySelector("details")!;
  await act(async () => { details.open = true; });
  assert.ok(container.querySelector("[data-paused]"));
  assert.equal(container.querySelector(".playbackStatus")?.textContent, "Paused");
  await complete(); assert.equal(moves.length, 0);
  await act(async () => { details.open = false; });
  assert.equal(container.querySelector("[data-paused]"), null);
  const clock = container.querySelector(".timer");
  await act(async () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(testEvent("visibilitychange"));
  });
  await complete(); assert.equal(moves.length, 0);
  assert.ok(container.querySelector("[data-paused]"));
  await act(async () => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(testEvent("visibilitychange"));
  });
  assert.equal(container.querySelector(".timer"), clock, "visibility preserves the remaining time");
  await complete(); assert.equal(moves.length, 1);
  assert.notEqual(container.querySelector(".timer"), clock, "each navigation starts a fresh interval");
});

test("missing, loading and failed covers keep a decorative slot separate from the identity, and a replacement can load", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const cover = { url: "https://cdn.blast.fun/covers/first.webp", width: 1536, height: 512 };
  const render = async (image: typeof cover | null) => act(async () => root.render(<FeaturedArtwork cover={image}><span>Project logo</span></FeaturedArtwork>));
  await render(null);
  const stage = container.firstElementChild!;
  const slot = stage.firstElementChild!;
  const identity = stage.lastElementChild!;
  const assertStructure = () => {
    assert.equal(stage.firstElementChild, slot);
    assert.equal(slot.getAttribute("aria-hidden"), "true");
    assert.equal(stage.lastElementChild, identity);
    assert.match(identity.textContent!, /Project logo/);
  };
  assertStructure();
  await render(cover);
  assertStructure();
  assert.equal(container.querySelector("img")?.getAttribute("src"), cover.url);
  await act(async () => container.querySelector("img")!.dispatchEvent(testEvent("error")));
  assert.equal(container.querySelector("img"), null);
  assert.match(container.textContent, /Project logo/);
  assert.equal(container.querySelector("[data-cover]"), null);
  assertStructure();
  await render({ ...cover, url: "https://cdn.blast.fun/covers/replacement.webp" });
  assert.ok(container.querySelector("img"));
  assertStructure();
  await render(null);
  assert.equal(container.querySelector("img"), null);
  assert.match(container.textContent, /Project logo/);
  assertStructure();
});

test("featured presales lead with the cover and read the raise in its coin, with no purchase UI", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><FeaturedPresales now={FIXTURE_NOW} sales={live} /></QueryProvider>));
  const links = [...container.querySelectorAll(".slide:not([data-visual-copy]) a:not([aria-hidden])")];
  assert.deepEqual(links.map(link => link.getAttribute("href")), live.map(sale => `/presale/${sale.presale_id}`));
  assert.deepEqual(links.map(link => link.querySelector("b")?.textContent), live.map(sale => sale.name));
  // Named by the title and described by the raise, time and backers, so the slide's facts still reach screen readers.
  assert.ok(links.every(link => !link.hasAttribute("aria-label")), "no label hides the slide's content");
  assert.deepEqual(links.map(link => document.getElementById(link.getAttribute("aria-labelledby")!)?.textContent), live.map(sale => sale.verified_team ? `${sale.name}Known deployer` : sale.name));
  const descriptions = links.map(link => link.getAttribute("aria-describedby")!.split(" ").map(id => document.getElementById(id)?.textContent).join(" "));
  assert.ok(descriptions.every(description => /raised of a .* target, .* funded\. Ends in .*\. [\d,]+ backers?\./.test(description)), descriptions.join("\n"));
  assert.ok(links.every(link => link.querySelector(".heroCover")), "each slide leads with its cover slot");
  for (const [index, sale] of live.entries()) {
    const funding = links[index]!.querySelector(".funding")!;
    assert.ok(funding.querySelector("img, svg, [aria-hidden]"), "the coin's mark sits beside the raise");
    const words = [...funding.children].filter(child => !child.hasAttribute("aria-hidden")).map(child => child.textContent).join(" ");
    assert.match(words, new RegExp(`^[<\\d,.]+ ${sale.quote_symbol} of [\\d,.]+ ${sale.quote_symbol}$`), "the Presales board: X COIN of Y COIN");
  }
  assert.doesNotMatch(container.textContent!, /Raised in/, "the amount already identifies the raise coin");
  assert.doesNotMatch(container.textContent!, /Featured|\$/);
  assert.equal(container.querySelector("input, select, form, [data-kind=commit]"), null);
  assert.doesNotMatch(container.textContent!, /Buy allocation|Allocation is proportional|Estimated allocation|Locked until close/);
});

test("the featured carousel renders every sale, caps each fill, and offers playback for several", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const sales = Array.from({ length: 12 }, (_, index) => ({ ...live[index % live.length], presale_id: `sale-${index}`, raised_atoms: index === 0 ? (BigInt(live[0].target_atoms) * 2n).toString() : "0" }));
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><FeaturedPresales now={FIXTURE_NOW} sales={sales} /></QueryProvider>));
  const links = [...container.querySelectorAll(".slide:not([data-visual-copy]) a")];
  assert.equal(links.length, sales.length);
  assert.deepEqual(links.map(link => link.getAttribute("href")), sales.map(sale => `/presale/${sale.presale_id}`));
  assert.equal(links[0].querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "100");
  assert.match(document.getElementById(links[0].getAttribute("aria-describedby")!)!.textContent!, /200 percent funded/);
  assert.equal(links[1].querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "0");
  assert.equal(container.querySelectorAll('[aria-roledescription="carousel"]').length, 1);
  assert.equal(container.querySelectorAll(".segment").length, sales.length, "one segment per slide");
  assert.equal(container.querySelectorAll('.slide:not([inert])').length, 1, "one slide is presented at a time");
  assert.equal(container.querySelectorAll('[data-visual-copy][inert][aria-hidden="true"]').length, 2, "the wrap copies are visual only");
  assert.ok(container.querySelector('[aria-label="Pause featured presales"]'));
  assert.equal(container.querySelector('.position')?.getAttribute("aria-label"), "Presale 1 of 12");
});

test("one featured sale is a static hero; hiding the row unmounts it", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const render = async (sales: typeof live) => act(async () => root.render(<QueryProvider client={client}><FeaturedPresales now={FIXTURE_NOW} sales={sales} /></QueryProvider>));
  const sale = live[0]!;
  const tagline = "Build a crew, explore the world together, and bring the treasures you find back to your home village.";
  await render([{ ...sale, metadata: { ...EMPTY_SALE_METADATA, tagline } }]);
  assert.equal(container.querySelector("a")?.textContent?.includes(tagline), false, "the full description stays on the sale page");
  assert.equal(container.querySelector("a")?.getAttribute("href"), `/presale/${sale.presale_id}`);
  assert.equal(container.querySelectorAll("a").length, 1);
  assert.equal(container.querySelector(".timer, .segment, .position"), null, "no rotation or position for one sale");
  assert.equal(container.querySelector('[class*="arrows"]')?.hasAttribute("hidden"), true);
  await render([]);
  assert.equal(container.querySelector("section"), null);
});

test("zero, one and asynchronously loaded presales keep stable keyed tiles", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const initial = { ...fixtureList("live", "ending"), presales: [live[0]!], next_cursor: null };
  client.setQueryData(presaleListQuery({ status: "live", sort: "ending" }).queryKey, initial);
  await act(async () => root.render(<QueryProvider client={client}><PresalesList initial={initial} featured={[]} layout="list" nowMs={FIXTURE_NOW} initialPinSeed="page-a" status="live" sort="ending" view="list" /></QueryProvider>));
  const hero = () => container.querySelector('[aria-label="Selected presales"]');
  assert.equal(hero(), null);
  await act(async () => { client.setQueryData(featuredPresalesQuery().queryKey, [live[0]]); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.equal(hero()?.querySelectorAll("a").length, 1);
  assert.equal(hero()?.querySelector('[class*="arrows"]')?.hasAttribute("hidden"), true, "one sale has no navigation");
  const first = hero()?.querySelector("a");
  await act(async () => { client.setQueryData(featuredPresalesQuery().queryKey, [...live].reverse()); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.equal(hero()?.querySelectorAll("a:not([data-visual-copy] *)").length, live.length);
  assert.equal(hero()?.querySelector("a:not([data-visual-copy] *)"), first);
  assert.deepEqual([...container.querySelectorAll("[data-list-row]")].map(row => row.getAttribute("data-list-row")), [live[0]!.presale_id]);
});

test("Pinned first gives a later-page pin the same chance to lead the catalog as the carousel", async (t) => {
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const [first, second] = live;
  const upcoming = fixtureList("upcoming", "opening").presales[0]!;
  const otherUpcoming = { ...upcoming, presale_id: `0x${"2".repeat(64)}` };
  const pins = [...live, upcoming];
  const unpinned = { ...first!, presale_id: `0x${"1".repeat(64)}` };
  const initial = { ...fixtureList("live", "pinned"), presales: [first!], next_cursor: "page-2" };
  const next = { ...initial, presales: [{ ...second!, name: "Updated presale name" }, unpinned, otherUpcoming], next_cursor: null };
  client.setQueryData(presaleListQuery({ status: "live", sort: "pinned" }).queryKey, initial);
  client.setQueryData(presaleListQuery({ status: "live", sort: "pinned", cursor: "page-2" }).queryKey, next);
  const entry = Object.values(fixtureViewer()).find(item => item.following.length >= 2)!;
  client.setQueryData(queryKeys.me.presaleViewer([first!.presale_id]), { presales: {} });
  client.setQueryData(queryKeys.me.presaleViewer([first!.presale_id, second!.presale_id, unpinned.presale_id, otherUpcoming.presale_id]), { presales: {} });
  client.setQueryData(queryKeys.me.presaleViewer(pins.map(sale => sale.presale_id)), { presales: { [second!.presale_id]: { ...entry, following: entry.following.slice(0, 2) } } });
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider callsign="kaimoreno" signedIn><PresalesList initial={initial} featured={pins} layout="list" nowMs={FIXTURE_NOW} initialPinSeed="page-b" status="live" sort="pinned" view="list" /></SocialViewerProvider></QueryProvider>));
  const selected = container.querySelector('[aria-label="Selected presales"]');
  const catalogIds = () => [...container.querySelectorAll("[data-list-row]")].map(row => row.getAttribute("data-list-row"));
  const pinIds = [second!.presale_id, first!.presale_id];
  assert.ok(selected);
  const featuredLinks = [...selected.querySelectorAll("a:not([data-visual-copy] *)")].map(link => link.getAttribute("href"));
  assert.deepEqual(featuredLinks, pinIds.map(id => `/presale/${id}`));
  assert.deepEqual(catalogIds(), pinIds);
  assert.match(container.querySelector("[data-list-row]")?.textContent ?? "", /2 people you follow backed/);
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Show more")!.click());
  await act(async () => settleQueries(client));
  assert.deepEqual(catalogIds(), [...pinIds, unpinned.presale_id]);
  assert.match(container.querySelector("[data-list-row]")?.textContent ?? "", /Updated presale name/);
});

test("the Ended tab omits the live promotion", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  const initial = { ...fixtureList("ended", "recent"), next_cursor: null };
  client.setQueryData(presaleListQuery({status:"ended", sort:"recent"}).queryKey, initial);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><PresalesList initial={initial} featured={live} nowMs={FIXTURE_NOW} status="ended" sort="recent" view="list" /></QueryProvider>));
  const selected = container.querySelector('[aria-label="Selected presales"]');
  assert.equal(selected, null);
  assert.ok(container.querySelector("[data-list-row]"));
});

test("a signed-in viewer keeps the hero's followed backers when the live list lacks the featured sale", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  const initial = { ...fixtureList("live", "ending"), presales: live.slice(1), next_cursor: null };
  const sale = live[0]!;
  const entry = Object.values(fixtureViewer()).find((item) => item.following.length >= 2)!;
  client.setQueryData(presaleListQuery({status:"live", sort:"ending"}).queryKey, initial);
  client.setQueryData(queryKeys.me.presaleViewer(initial.presales.map((row) => row.presale_id)), { presales: {} });
  client.setQueryData(queryKeys.me.presaleViewer([sale.presale_id]), { presales: { [sale.presale_id]: { ...entry, following: entry.following.slice(0, 2) } } });
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider callsign="kaimoreno" signedIn><PresalesList initial={initial} featured={[sale]} nowMs={FIXTURE_NOW} status="live" sort="ending" view="list" /></SocialViewerProvider></QueryProvider>));
  assert.ok(!initial.presales.some((row) => row.presale_id === sale.presale_id), "the featured sale is not in the Live list");
  assert.match(container.querySelector('[aria-label="Selected presales"]')?.textContent ?? "", /and 1 person you follow are in/);
});
