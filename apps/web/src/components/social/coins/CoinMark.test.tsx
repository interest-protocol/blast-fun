import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { readFileSync } from "#web/test/css-design-px.ts";

import { PresaleMark } from "../post/PostMedia";
import { installTestDom, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import { CORE_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { coinDisplay } from "./coin-display";
import { ArtworkMark } from "#web/components/blast-ui/ArtworkMark.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { coinArtworkIdentity } from "#web/components/blast-ui/coin-artwork-identity.ts";
import { TSUI } from "../../../../test/fixtures/social/commit/alon.ts";

const coin = { key: "sale-a", iconUrl: null, round: false };
const colors = (html: string) => [...html.matchAll(/stop-color="([^"]+)"/g)].map((match) => match[1]);

test("Test SUI has a deliberate monogram distinct from SUI when its logo is missing", () => {
  const html = renderToStaticMarkup(<CoinMark coin={TSUI} size={28} />);
  assert.match(html, /data-coin-monogram="">T</);
  assert.doesNotMatch(html, /data-generated|coins\/sui/);
});

test("missing and unusable coin images use the same stable colors as the feed at every size", () => {
  const expected = colors(renderToStaticMarkup(<PresaleMark presaleId={coin.key} src={null} />));
  assert.equal(expected.length, 2);
  for (const size of [18, 34, 40, 44, 55] as const) {
    for (const iconUrl of [null, "", "http://example.com/coin.png", "javascript:alert(1)"]) {
      const html = renderToStaticMarkup(<CoinMark coin={{ ...coin, iconUrl }} size={size} />);
      assert.match(html, /data-generated=""/);
      assert.match(html, /aria-hidden="true"/);
      assert.doesNotMatch(html, /<img/);
      assert.deepEqual(colors(html), expected);
    }
  }
  assert.notDeepEqual(colors(renderToStaticMarkup(<CoinMark coin={{ ...coin, key: "sale-b" }} />)), expected);
});

test("uploaded images and native coin logos keep their existing rendering", () => {
  for (const iconUrl of ["https://example.com/coin.png", "data:image/png;base64,aGVsbG8="]) {
    const html = renderToStaticMarkup(<CoinMark coin={{ ...coin, iconUrl }} />);
    assert.ok(html.includes(`src="${iconUrl}"`));
    assert.doesNotMatch(html, /data-generated/);
  }
  for (const key of ["sui", "usdc"]) {
    const html = renderToStaticMarkup(<CoinMark coin={{ ...coin, key, round: true }} />);
    assert.ok(html.includes(`href="/blast-ui/coins/${key}.svg"`));
    assert.doesNotMatch(html, /data-generated/);
  }
});

test("a broken image becomes colorful and a replacement URL can load", async () => {
  const { document } = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CoinMark coin={{ ...coin, iconUrl: "https://example.com/broken.png" }} />));
    const image = container.querySelector("img");
    assert.ok(image);
    await act(async () => image.dispatchEvent(testEvent("error")));
    assert.ok(container.querySelector("svg[data-generated]"));
    assert.equal(container.querySelector("img"), null);
    await act(async () => root.render(<CoinMark coin={{ ...coin, iconUrl: "https://example.com/replacement.png" }} />));
    assert.equal(container.querySelector("img")?.getAttribute("src"), "https://example.com/replacement.png");
    assert.equal(container.querySelector("svg[data-generated]"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});


test("canonical coins use exact-identity logos when metadata is empty; copied tickers do not", () => {
  for (const canonical of CORE_COINS) {
    const html = renderToStaticMarkup(<CoinMark coin={{ ...coin, key: canonical.coinType, symbol: canonical.symbol }} />);
    assert.ok(html.includes(canonical.symbol === "SUI" || canonical.symbol === "USDC" ? `href="/blast-ui/coins/${canonical.symbol.toLowerCase()}.svg"` : `src="${canonical.logoUrl}"`), canonical.symbol);
    assert.doesNotMatch(html, /data-generated/);
  }
  const spoof = renderToStaticMarkup(<CoinMark coin={{ ...coin, key: "0x9::deep::DEEP", symbol: "DEEP" }} />);
  assert.match(spoof, /data-generated/);
  assert.doesNotMatch(spoof, /statics.noodles.fi/);
});

test("broken metadata retries the canonical logo once, then falls back without a retry loop", async () => {
  const { document } = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const deep = CORE_COINS.find(coin => coin.symbol === "DEEP")!;
  const view = { ...coin, key: deep.coinType, iconUrl: "https://example.com/deep.svg" };
  try {
    await act(async () => root.render(<CoinMark coin={view} />));
    assert.equal(container.querySelector("img")?.getAttribute("src"), view.iconUrl);
    await act(async () => container.querySelector("img")!.dispatchEvent(testEvent("error")));
    assert.equal(container.querySelector("img")?.getAttribute("src"), deep.logoUrl);
    await act(async () => container.querySelector("img")!.dispatchEvent(testEvent("error")));
    assert.equal(container.querySelector("img"), null);
    assert.ok(container.querySelector("svg[data-generated]"));
    await act(async () => root.render(<CoinMark coin={{ ...view, iconUrl: "https://example.com/replacement.svg" }} />));
    assert.equal(container.querySelector("img")?.getAttribute("src"), "https://example.com/replacement.svg");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("site-relative metadata logos resolve identically in tabs and headers", () => {
  const html = renderToStaticMarkup(<CoinMark coin={{ key: "relative", iconUrl: "/blast-ui/coins/sui.svg", round: false }} />);
  assert.match(html, /src="\/blast-ui\/coins\/sui.svg"/);
});


test("a URL failure is shared by the tab and header, including later mounts", async () => {
  const { document } = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const shared = { ...coin, iconUrl: "https://example.com/shared-failure.png" };
  try {
    await act(async () => root.render(<><CoinMark coin={shared} size={18} /><CoinMark coin={shared} size={40} /></>));
    assert.equal(container.querySelectorAll("img").length, 2);
    await act(async () => container.querySelector("img")!.dispatchEvent(testEvent("error")));
    assert.equal(container.querySelectorAll("img").length, 0);
    assert.equal(container.querySelectorAll("svg[data-generated]").length, 2);
    await act(async () => root.render(<CoinMark coin={shared} size={28} />));
    assert.equal(container.querySelector("img"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});


test("full coin identity normalizes equivalent types and separates networks across feed and wallet marks", () => {
  const short = "0x9::coin::COIN";
  const long = `0x${"9".padStart(64, "0")}::coin::COIN`;
  assert.equal(coinArtworkIdentity(short, "sale-a"), coinArtworkIdentity(long, "sale-b"));
  assert.notEqual(coinArtworkIdentity(short, "sale-a"), coinArtworkIdentity(short, "sale-a", "testnet"));
  const feed = renderToStaticMarkup(<PresaleMark presaleId="sale-a" coinType={short} src={null} />);
  const wallet = renderToStaticMarkup(<CoinMark coin={{ ...coin, key: long, coinType: long }} />);
  assert.deepEqual(colors(feed), colors(wallet));
  const spoof = renderToStaticMarkup(<CoinMark coin={{ ...coin, key: short, symbol: "TSUI" }} />);
  assert.match(spoof, /data-generated/);
  assert.doesNotMatch(spoof, /monogram/);
});


test("display aliases follow full type and network, never a spoofed symbol", () => {
  assert.deepEqual(coinDisplay(TSUI.coinType, "TEST_SUI", "TEST_SUI"), { symbol: "TSUI", name: "Test SUI" });
  assert.deepEqual(coinDisplay("0x9::copy::COPY", "TEST_SUI", "Copy"), { symbol: "TEST_SUI", name: "Copy" });
  assert.deepEqual(coinDisplay(TSUI.coinType, "TEST_SUI", "Other network", "testnet"), { symbol: "TEST_SUI", name: "Other network" });
});

test("40 px coin marks preserve the owner's round core coins and rounded-square presale artwork", () => {
  const style = readFileSync(new URL("../../blast-ui/blast-ui.css", import.meta.url), "utf8");
  const html = renderToStaticMarkup(
    <><ArtworkMark src={null} fallbackId="sale-1" /><CoinMark coin={coin} size={40} /><CoinMark coin={{ key: "sui", iconUrl: null }} size={40} /><CoinMark coin={{ key: "usdc", iconUrl: null }} size={40} /></>,
  );
  const dom = new JSDOM(`<style>${style}</style><div data-blast-ui>${html}</div>`);
  try {
    const marks = [...dom.window.document.querySelectorAll("[data-coin-mark], [data-artwork-size]")];
    assert.equal(marks.length, 4);
    const dimensions = marks.map((mark) => {
      const { width, height, borderRadius } = dom.window.getComputedStyle(mark);
      return [width, height, borderRadius];
    });
    assert.deepEqual(dimensions, [["40px", "40px", "12px"], ["40px", "40px", "12px"], ["40px", "40px", "999px"], ["40px", "40px", "999px"]]);
  } finally {
    dom.window.close();
  }
});
