import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { SITE_ORIGIN } from "#web/lib/site.ts";
import { presaleShareRevision } from "@blast/core/modules/presale/share/revision.ts";
import { EMPTY_SALE_METADATA } from "@blast/core/modules/social/contracts/sales.ts";
import { fixtureDetail } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { SaleLinks } from "./SaleDetails.tsx";

test("a presale always offers an X compose link with a current card revision on its public URL", () => {
  const sale = fixtureDetail("mrdn").presale;
  for (const metadata of [null, { ...EMPTY_SALE_METADATA, x_handle: "meridianfx" }]) {
    const html = renderToStaticMarkup(<SaleLinks metadata={metadata} sale={sale} />);
    const document = new JSDOM(html).window.document;
    const share = [...document.querySelectorAll("a")].find((link) => link.textContent?.includes("Share on X"));
    assert.ok(share, "Share on X must be an actionable link, including when no X handle was supplied");
    const intent = new URL(share.href);
    assert.equal(intent.origin + intent.pathname, "https://x.com/intent/post");
    const shared = new URL(intent.searchParams.get("url")!);
    assert.equal(shared.origin + shared.pathname, `${SITE_ORIGIN}/presale/${sale.presale_id}`);
    assert.equal(shared.searchParams.get("share"), presaleShareRevision({ ...sale, metadata }));
    assert.equal(intent.searchParams.has("text"), false);
    assert.equal(share.target, "_blank");
    assert.ok(share.rel.includes("noopener"));
    assert.equal(document.querySelector('a[href*="x.com/search"]'), null);
    if (metadata?.x_handle) assert.ok(document.querySelector('a[href="https://x.com/meridianfx"]'));
  }
});
