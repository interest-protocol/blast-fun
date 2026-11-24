import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cssInDesignPx } from "#web/test/css-design-px.ts";

import { DexIdentity } from "./DexIdentity";

test("DEX identity uses local decorative logos and keeps the data's readable name", () => {
  for (const venue of ["bluefin", "cetus", "aftermath"]) {
    const html = renderToStaticMarkup(<DexIdentity venue={venue.toUpperCase()} />);
    assert.match(html, /alt="" aria-hidden="true"/);
    assert.match(html, /height="16"/);
    assert.match(html, /width="16"/);
    assert.match(html, new RegExp(`>${venue.charAt(0).toUpperCase() + venue.slice(1)}<`));
    assert.ok(existsSync(new URL(`../../../public/blast-ui/dex/${venue}.svg`, import.meta.url)));
  }
});

test("unknown and long venue names remain text without a guessed logo", () => {
  for (const venue of ["Other Exchange with a very long name", "constructor", "__proto__", ""]) {
    const html = renderToStaticMarkup(<DexIdentity venue={venue} />);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /class="identity"/);
  }
  const html = renderToStaticMarkup(<DexIdentity venue="<Unknown & exchange>" />);
  assert.match(html, /&lt;Unknown &amp; exchange&gt;/);
});

test("the mark takes the Create boards' 18, 20 and 24px sides and keeps 16 by default", () => {
  assert.doesNotMatch(renderToStaticMarkup(<DexIdentity venue="cetus" />), /data-size/);
  for (const size of [18, 20, 24] as const) {
    const html = renderToStaticMarkup(<DexIdentity iconOnly size={size} venue="cetus" />);
    assert.match(html, new RegExp(`data-size="${size}"`));
    assert.match(html, new RegExp(`height="${size}"`));
    assert.match(html, new RegExp(`width="${size}"`));
    assert.match(html, /class="sr-only">Cetus</);
  }
  const css = cssInDesignPx(readFileSync(new URL("./DexIdentity.module.css", import.meta.url), "utf8"));
  for (const size of [18, 20, 24]) assert.match(css, new RegExp(`\\.logo\\[data-size="${size}"\\] \\{ width: ${size}px; height: ${size}px; \\}`));
});
