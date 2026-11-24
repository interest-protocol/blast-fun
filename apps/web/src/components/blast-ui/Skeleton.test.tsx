import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PendingStatus, SkeletonBox, SkeletonLine, SkeletonRegion, SkeletonRows, SkeletonText } from "./Skeleton";

test("a skeleton region is a busy status named for its operation; its shapes are hidden from assistive technology", () => {
  const html = renderToStaticMarkup(<SkeletonRegion className="list" label="Loading coins"><SkeletonBox className="tile" round /><SkeletonText>Coin name</SkeletonText></SkeletonRegion>);
  assert.match(html, /^<div aria-busy="true" aria-label="Loading coins" class="list" role="status">/);
  assert.match(html, /<span aria-hidden="true" class="box round tile"><\/span>/);
  assert.match(html, /<span aria-hidden="true" class="text">Coin name<\/span>/);
  assert.match(html, /<span class="sr-only">Loading coins<\/span><\/div>$/);
  assert.match(renderToStaticMarkup(<SkeletonRegion inline label="Reading"><SkeletonText>0.00 SUI</SkeletonText></SkeletonRegion>), /^<span aria-busy="true"/);
});

test("skeleton rows repeat one row in the list's own classes, under one name or none", () => {
  const named = renderToStaticMarkup(<SkeletonRows className="list" count={3} label="Loading presales" rowClassName="row"><SkeletonBox /></SkeletonRows>);
  assert.equal(named.match(/<div aria-hidden="true" class="row">/g)?.length, 3);
  assert.match(named, /role="status"/);
  const nested = renderToStaticMarkup(<SkeletonRows className="list" count={2} rowClassName="row"><SkeletonBox /></SkeletonRows>);
  assert.equal(nested.includes("role="), false, "inside a region that already names the read, the rows add no second status");
});

test("a pending line reads exactly its operation's name; a pending status draws nothing", () => {
  assert.equal(renderToStaticMarkup(<SkeletonLine label="Checking your sign-in…" />), '<span aria-busy="true" aria-label="Checking your sign-in…" class="text" role="status">Checking your sign-in…</span>');
  assert.equal(renderToStaticMarkup(<SkeletonLine label="Finding coins" status={false} />), '<span class="text">Finding coins</span>');
  assert.equal(renderToStaticMarkup(<PendingStatus label="Loading activity page 2" />), '<span aria-busy="true" aria-label="Loading activity page 2" class="sr-only" role="status">Loading activity page 2</span>');
});
