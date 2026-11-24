import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { ShellActionsProvider } from "#web/components/blast-ui/shell-actions.tsx";
import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";
import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";
import { FIXTURE_NOW, fixtureDetail } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { SaleView } from "./SaleView";

const KSTL = fixtureDetail("kstl");
const classes = (html: string) => html.replace(/class="([^"]*)"/g, (_, names: string) => `class="${[...new Set(names.split(" "))].join(" ")}"`);
const page = (signedIn: boolean, detail = KSTL) => {
  const client = createTestQueryClient();
  const html = classes(renderToStaticMarkup(withQueryClient(client,
    <ShellActionsProvider><SocialViewerProvider signedIn={signedIn}>
      <SaleView detail={detail} nowMs={FIXTURE_NOW} viewerEntry={null} />
    </SocialViewerProvider></ShellActionsProvider>,
  )));
  client.clear();
  return html;
};

test("traded presales show a shortened address beside the creator", () => {
  const doc = JSDOM.fragment(page(false));
  const tag = doc.querySelector("[data-coin-identity] [data-coin-type-tag]");
  assert.match(tag?.previousElementSibling?.textContent ?? "", /^Created by/);
  assert.equal(tag?.querySelector("code")?.textContent, "0x7a3f…c91e");
  assert.ok(tag?.querySelector('button[aria-label$="Copy full coin address"]'));
});

for (const signedIn of [true, false]) {
  test(`a ${signedIn ? "signed-in reader" : "visitor"} has one trade bar (Sell beside Buy, the Mobile board) even without a market price`, () => {
    const html = page(signedIn, { ...KSTL, presale: { ...KSTL.presale, price_usd: null, multiple: null } });
    const bar = html.match(/<div class="m-commitbar onSale trading-entry">(.*?)<\/div>/)?.[1] ?? "";
    assert.deepEqual([...bar.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]), ["Sell", "Buy KSTL"]);
    assert.equal((html.match(/class="m-commitbar onSale trading-entry"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /data-side="buy"|data-side="sell"/);
  });
}

test("the trade bar follows the app's supported venues", () => {
  for (const venue of ["cetus", "bluefin", "aftermath"]) assert.match(page(false, { ...KSTL, presale: { ...KSTL.presale, venue } }), />Buy KSTL<\/button>/);
  assert.doesNotMatch(page(false, { ...KSTL, presale: { ...KSTL.presale, venue: "unknown" } }), />Buy KSTL<\/button>|trading-entry/);
});

test("R3-34-AC-6: the open bar names its target and commitment action; pending and ended bars retain their actions", () => {
  const html = (key: string) => classes(renderToStaticMarkup(
    <SocialViewerProvider callsign="kaimoreno" signedIn>
      <SaleView detail={fixtureDetail(key)} nowMs={FIXTURE_NOW} viewerEntry={null} />
    </SocialViewerProvider>,
  ));
  assert.match(html("mrdn"), /<div class="m-commitbar onSale"><span class="t"><b class="num">73.68% of target<\/b><span>Closes in 6h 12m<\/span><\/span><button class="btn btn-primary" disabled="" type="button">Commit USDC<\/button><\/div>/);
  const upcoming = html("sabl").match(/<div class="m-commitbar onSale">.*?<\/div>/)?.[0] ?? "";
  assert.match(upcoming, /Opens in 11d 0h/);
  assert.match(upcoming, /<time[^>]+>14 Oct ’26<\/time>/);
  assert.match(upcoming, /<button aria-pressed="false"[^>]*>.*?Notify me<\/button>/);
  for (const key of ["cblt", "hlcn"]) assert.doesNotMatch(html(key), /m-commitbar/, key);
});
