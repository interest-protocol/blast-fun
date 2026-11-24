import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MetadataIcon } from "./MetadataIcon";

test("a valid metadata icon renders as the creator's image without leaking the page URL", () => {
  const html = renderToStaticMarkup(
    <MetadataIcon src="https://arweave.net/Qm4x8vT3/helmet.png" identity="0x9a::helmet::HELMET" />,
  );
  assert.match(html, /<img[^>]+src="https:\/\/arweave\.net\/Qm4x8vT3\/helmet\.png"/);
  assert.match(html, /alt=""/);
  assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
});

test("a missing or invalid icon renders the neutral generated fallback, never an official mark", () => {
  for (const src of [null, "https://example.com/icon.png", "http://arweave.net/x.png"]) {
    const html = renderToStaticMarkup(<MetadataIcon src={src} identity="0x9a::helmet::HELMET" />);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /data-fallback="generated"/);
    assert.match(html, /<rect /);
    assert.doesNotMatch(html, /sui|blast|icon\.svg|logo/i);
  }
});

test("a labeled icon is named for assistive technology; an unlabeled one is decorative", () => {
  const labeled = renderToStaticMarkup(<MetadataIcon src={null} identity="x" label="HELMET icon" />);
  assert.match(labeled, /role="img"/);
  assert.match(labeled, /aria-label="HELMET icon"/);
  const decorative = renderToStaticMarkup(<MetadataIcon src={null} identity="x" />);
  assert.match(decorative, /aria-hidden="true"/);
  const image = renderToStaticMarkup(
    <MetadataIcon src="https://arweave.net/a.png" identity="x" label="HELMET icon" />,
  );
  assert.match(image, /alt="HELMET icon"/);
});
