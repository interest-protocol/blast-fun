import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";
import { EMPTY_SALE_METADATA, SALE_METADATA_FIELDS, type SocialSaleMetadata } from "@blast/core/modules/social/contracts/sales.ts";

import { FIXTURE_NOW, fixtureDetail } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import {
  EDIT_DETAILS_FIELDS,
  coverTooLarge,
  editFieldMessage,
  editInputValue,
  editRequestOf,
  editValuesOf,
  fetchSaleDetails,
  removeSaleCover,
  saleDetailsRefusal,
  saveSaleDetails,
  uploadSaleCover,
} from "./sale-details";
import { CoverButton, EditDetailsSheet, SaleLinks, type SaleDetailsState } from "./SaleDetails";
import { SaleView } from "./SaleView";
import { presaleXIntent } from "#web/modules/presale/share/metadata.ts";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

/** R3-28: the sale page's cover, tagline and links, and the creator's Edit details sheet. */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const FULL: SocialSaleMetadata = {
  tagline: "Onchain FX for stablecoins on Sui",
  site: "https://www.meridian.finance/",
  x_handle: "meridianfx",
  telegram: "meridianfx",
  docs_url: "https://docs.meridian.finance/intro",
  audit_url: "https://audits.example/meridian.pdf",
  cover: { url: "https://blob.example/sale-covers/m.webp", width: 1_536, height: 512 },
  launch_at_ms: null,
};

function sale(metadata: SocialSaleMetadata | null, phase?: "cancelled") {
  const detail = fixtureDetail("mrdn");
  return { ...detail, presale: { ...detail.presale, metadata, ...(phase ? { phase } : {}) } };
}

const render = (metadata: SocialSaleMetadata | null, phase?: "cancelled") =>
  renderToStaticMarkup(<SaleView detail={sale(metadata, phase)} nowMs={FIXTURE_NOW} viewerEntry={null} />);

test("R3-28-AC-1: a cover renders across the head at 3:1, on the server, with its stored size; the tagline is the About card's", () => {
  const html = render(FULL);
  const cover = html.match(/<div class="[^"]*sale-cover[^"]*"[^>]*>(.*?)<\/div>/)?.[1] ?? "";
  assert.match(cover, /<img alt="" decoding="async" fetchPriority="high" height="512" loading="eager" referrerPolicy="no-referrer" src="https:\/\/blob\.example\/sale-covers\/m\.webp" width="1536"\/>/);
  assert.match(text(html), /About Onchain FX for stablecoins on Sui/);
  assert.match(html, /<p class="[^"]*sale-tag[^"]*">Onchain FX for stablecoins on Sui<\/p>/);
  const plain = render(null);
  assert.ok(!/<img alt="" decoding="async" fetchPriority|sale-tag/.test(plain), "no cover image and no About card without details");
  assert.match(plain, /class="[^"]*sale-cover-art[^"]*" data-cover-palette="[1-4]"/, "the sale's palette holds the cover's place");
  // The tagline is plain text, never linked or parsed as markup.
  assert.ok(render({ ...EMPTY_SALE_METADATA, tagline: "<b>bold</b> claims" }).includes("&lt;b&gt;bold&lt;/b&gt; claims"));
});

test("the sale header shows a matching name and ticker once, with its stage, creator, watchlist and links menu", () => {
  const detail = sale({ ...EMPTY_SALE_METADATA, tagline: "sat" });
  const html = renderToStaticMarkup(<SaleView detail={{ ...detail, presale: { ...detail.presale, name: "sat", symbol: "SAT" } }} nowMs={FIXTURE_NOW} viewerEntry={null} watch={{ on: true, toggle: () => undefined }} />);
  const document = new JSDOM(html).window.document;
  const header = document.querySelector(".sale-head")!;
  assert.equal(document.querySelectorAll("h1").length, 1);
  assert.equal(header.querySelector("h1")?.textContent?.trim(), "$SAT");
  assert.equal(header.querySelector(".sale-status")?.textContent, "Live");
  assert.equal(document.querySelector(".sale-about p")?.textContent, "sat");
  assert.ok(header.compareDocumentPosition(document.querySelector(".sale-raise")!) & 4, "the head comes before the main card");
  assert.ok(header.querySelector('.sale-actions button[aria-label="Presale links"][aria-haspopup="menu"]'));
  assert.equal(header.querySelector('.sale-actions button[aria-label="On your watchlist"]')?.getAttribute("aria-pressed"), "true");
  assert.ok(header.querySelector(".sale-actions .follow"));
  assert.ok(header.querySelector('.sale-creator a[href="/@lucaromano"]'));
  assert.equal(document.querySelector("[data-sale-page]")?.getAttribute("data-shell-aside"), "wide", "the page asks the shell for the boards' 380px column");
});

test("the presale header copies each full address when its shortened byline is pressed", async (t) => {
  const detail = fixtureDetail("mrdn");
  assert.ok(detail.creator?.wallet);
  const tag = "0xa4b26f48bfc80014053b91f3d41bf115b1b2f20c1bcc07f4913c6d0bd4a433fc::meridian::MRDN";
  const { document, window } = installTestDom();
  const { createRoot } = await import("react-dom/client");
  const copies: string[] = [];
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (value: string) => { copies.push(value); } }, configurable: true });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<SaleView detail={{ ...detail, presale: { ...detail.presale, sale_token: tag } }} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  const address = container.querySelector(".sale-head .sale-meta [data-coin-type-tag]");
  const coinButton = address?.querySelector('button[aria-label="Address 0xa4b2…33fc. Copy full coin address"]');
  const creatorButton = address?.previousElementSibling?.querySelector('button[aria-label="Created by Luca Romano. Copy creator wallet address"]');
  assert.ok(coinButton?.querySelector("span code"));
  assert.ok(creatorButton);
  assert.equal(coinButton?.textContent, "Address 0xa4b2…33fc");
  assert.equal(creatorButton.textContent, "Created by Luca Romano");
  await act(async () => coinButton.querySelector<HTMLElement>("code")!.click());
  await act(async () => creatorButton.querySelector<HTMLElement>(":scope > span:last-child")!.click());
  assert.deepEqual(copies, [tag, detail.creator.wallet]);
  assert.ok(coinButton.hasAttribute("data-copied") && creatorButton.hasAttribute("data-copied"));
});

test("the head preserves every sale phase, missing descriptions, long content and preformatted tickers", () => {
  const detail = sale(null);
  for (const [phase, label] of [["pending", "Upcoming"], ["open", "Live"], ["closed", "Closed"], ["funded", "Funded"], ["cancelled", "Cancelled"]] as const) {
    const html = renderToStaticMarkup(<SaleView detail={{ ...detail, presale: { ...detail.presale, phase, symbol: "$MRDN" } }} nowMs={FIXTURE_NOW} viewerEntry={null} />);
    const header = new JSDOM(html).window.document.querySelector(".sale-head")!;
    assert.equal(header.querySelector(".sale-status")?.textContent, label);
    assert.equal(header.querySelector(".sale-ticker")?.textContent, "$MRDN");
    assert.doesNotMatch(header.textContent!, /Oversubscription|Oversubscribed/);
    assert.ok(header.querySelector('.sale-cover > [data-artwork-size="84"]'), "the coin mark sits over the cover");
    assert.ok(header.querySelector(".sale-creator"), "creator attribution remains in the identity");
    assert.equal(header.querySelector(".follow") !== null, phase !== "pending");
    assert.doesNotMatch(header.textContent!, /LP locked/, "a sale that has not launched has no pool to lock");
  }
  // Graduated launches share the coin identity and keep presale trust details below activity.
  const trading = new JSDOM(renderToStaticMarkup(<SaleView detail={{ ...detail, presale: { ...detail.presale, phase: "trading", symbol: "$MRDN" } }} nowMs={FIXTURE_NOW} viewerEntry={null} />)).window.document;
  const identity = trading.querySelector("[data-coin-identity]")!;
  assert.match(identity.querySelector("h1")!.textContent!, /\$MRDN/);
  assert.match(identity.textContent!, /Graduated/);
  assert.ok(identity.querySelector('[aria-label$="Copy full coin address"]'));
  assert.match(trading.querySelector(".sale-body .sale-pills")!.textContent!, /LP locked/);
  const tagline = "A long supplied description with unbroken text " + "x".repeat(120);
  const document = new JSDOM(render({ ...EMPTY_SALE_METADATA, tagline })).window.document;
  assert.equal(document.querySelector(".sale-about p")?.textContent, tagline);
});

test("the identity closes an elapsed open sale using the existing lifecycle deadline", () => {
  const detail = sale(null);
  const html = renderToStaticMarkup(<SaleView detail={{ ...detail, presale: { ...detail.presale, phase: "open", end_ms: FIXTURE_NOW - 1 } }} nowMs={FIXTURE_NOW} viewerEntry={null} />);
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector(".sale-head .sale-status")?.textContent, "Closed");
  const closed = document.querySelector('[data-notice="closed"]');
  assert.equal(closed?.textContent, "Closed 3 Oct ’26");
  assert.equal(closed?.querySelector("time")?.dateTime, "2026-10-03T17:59:59.999Z");
  assert.equal(closed?.querySelector("button")?.getAttribute("aria-label"), "Inspect full presale closing time: 2026-10-03 17:59:59.999 UTC");
  assert.equal(document.querySelector('[data-notice="settlement"]')?.textContent, "The result settles on chain shortly.");
});

test("R3-28-AC-2: the About card's chips are the stored links and the header keeps the links menu", () => {
  const html = render(FULL);
  const document = new JSDOM(html).window.document;
  const links = [...document.querySelectorAll('.sale-about a[target="_blank"]')];
  const anchors = links.map((link) => [link.getAttribute("href"), link.getAttribute("rel")]);
  assert.deepEqual(anchors, [
    ["https://www.meridian.finance/", "nofollow noopener"],
    ["https://x.com/meridianfx", "nofollow noopener"],
    ["https://t.me/meridianfx", "nofollow noopener"],
    ["https://docs.meridian.finance/intro", "nofollow noopener"],
    ["https://audits.example/meridian.pdf", "nofollow noopener"],
  ]);
  assert.deepEqual(links.map((link) => link.textContent), ["Website", "X", "Telegram", "Docs", "Audit report"]);
  assert.ok(document.querySelector('.sale-actions button[aria-label="Presale links"][aria-haspopup="menu"]'));
  // An audit link is never an Audited pill: only R3-23's operator-set flag is (OA-25 Q8).
  const unaudited = sale(FULL);
  const plain = renderToStaticMarkup(<SaleView detail={{ ...unaudited, presale: { ...unaudited.presale, audited: false } }} nowMs={FIXTURE_NOW} viewerEntry={null} />);
  assert.match(plain, /audits\.example\/meridian\.pdf/);
  assert.ok(!text(plain).includes("Audited"));
  // The links menu is available even when the About card has no content.
  const none = new JSDOM(render(null)).window.document;
  assert.equal(none.querySelector(".sale-about"), null);
  assert.ok(none.querySelector('.sale-actions button[aria-label="Presale links"][aria-haspopup="menu"]'));
  // Elsewhere SaleLinks keeps the share action beside exactly the stored links.
  const some = renderToStaticMarkup(<SaleLinks metadata={{ ...EMPTY_SALE_METADATA, telegram: "meridianfx" }} sale={sale(null).presale} />);
  assert.deepEqual([...some.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1]), [presaleXIntent(sale(null).presale), "https://t.me/meridianfx"]);
});

test("R3-28-AC-3 / AC-6: a visitor's and a cancelled sale's page offer no editing: no Edit details, no cover button", () => {
  for (const html of [render(FULL), render(FULL, "cancelled")]) {
    assert.ok(!text(html).includes("Edit details"));
    assert.ok(!html.includes("Change cover"));
    assert.doesNotMatch(html, /<dialog|role="dialog"/);
  }
  const signedIn = renderToStaticMarkup(
    <SocialViewerProvider callsign="kaimoreno" signedIn>
      <SaleView detail={sale(FULL)} nowMs={FIXTURE_NOW} viewerEntry={null} />
    </SocialViewerProvider>,
  );
  // On the server even a signed-in reader gets the shared HTML: whether they may edit is asked in the browser.
  assert.ok(!text(signedIn).includes("Edit details"));
});

const details = (metadata: SocialSaleMetadata | null): SaleDetailsState => ({
  metadata,
  editable: true,
  api: { getAccessToken: async () => null },
  adopt: () => undefined,
});

test("R3-28-AC-4: the cover control is a button named Change cover, reachable by keyboard", () => {
  const html = renderToStaticMarkup(<CoverButton details={details(FULL)} sale={sale(FULL).presale} />);
  assert.match(html, /<button aria-label="Change cover" [^>]*type="button"[^>]*><svg aria-hidden="true"/);
  assert.match(html, /<button aria-label="Change cover" [^>]*data-ui-variant="secondary"/);
  assert.ok(!/tabindex="-1"[^>]*aria-label="Change cover"/.test(html));
  assert.match(html, /<input accept="image\/png,image\/jpeg,image\/webp"[^>]*tabindex="-1" type="file"\/>/);
});

test("R3-28: the sheet retains its name, cover row, six fields and Save; no term anywhere", () => {
  const html = renderToStaticMarkup(<EditDetailsSheet details={details(FULL)} onClose={() => undefined} open sale={sale(FULL).presale} />);
  const words = text(html);
  assert.match(html, /<dialog[^>]*open=""/);
  assert.match(words, /Edit Meridian's details/);
  assert.match(words, /Edit details/);
  assert.match(words, /Replace cover/);
  assert.match(words, /One line about it 33\/120 Website X @ Telegram t\.me\/ Docs Audit report Save/);
  assert.match(html, /placeholder="What it does, in a line"/);
  assert.match(html, /value="www\.meridian\.finance\/"/);
  assert.match(words, /33\/120/);
  assert.match(words, /Save/);
  for (const term of ["Target", "Wallet cap", "Minimum", "Vesting", "Raise in", "Venue", "Supply"]) assert.ok(!words.includes(term), term);
  const empty = text(renderToStaticMarkup(<EditDetailsSheet details={details(null)} onClose={() => undefined} open sale={sale(null).presale} />));
  assert.match(empty, /Add a cover/);
});

test("R3-28-AC-8: every input of the sheet is a metadata column, by name", () => {
  assert.deepEqual(EDIT_DETAILS_FIELDS.map((field) => field.key), [...SALE_METADATA_FIELDS]);
  assert.deepEqual(Object.keys(editRequestOf(editValuesOf(FULL))).sort(), [...SALE_METADATA_FIELDS].sort());
  assert.deepEqual(EDIT_DETAILS_FIELDS.map((field) => [field.label, field.placeholder, field.pre ?? ""]), [
    ["One line about it", "What it does, in a line", ""],
    ["Website", "meridian.finance", ""],
    ["X", "meridianfx", "@"],
    ["Telegram", "meridianfx", "t.me/"],
    ["Docs", "docs.meridian.finance", ""],
    ["Audit report", "Link to the PDF or page", ""],
  ]);
});

test("R3-28-AC-5: each inline error is the gate's wording; a pasted X or Telegram link becomes the handle", () => {
  assert.equal(editFieldMessage("site", "not a site"), "That isn't a web address");
  assert.equal(editFieldMessage("docs_url", "ftp://docs.example"), "That isn't a web address");
  assert.equal(editFieldMessage("audit_url", "https://user@audits.example"), "That isn't a web address");
  assert.equal(editFieldMessage("x_handle", "a".repeat(16)), "Up to 15 letters, digits or _");
  assert.equal(editFieldMessage("telegram", "abcd"), "5 to 32 letters, digits or _");
  for (const [key, value] of [["site", ""], ["site", "meridian.finance"], ["x_handle", "meridianfx"], ["telegram", "meridianfx"], ["tagline", "Fine"]] as const) {
    assert.equal(editFieldMessage(key, value), "", `${key} ${value}`);
  }
  assert.equal(editFieldMessage("tagline", "🚀".repeat(120)), "");
  assert.equal(editFieldMessage("tagline", "a".repeat(121)), "Keep it to 120 characters");
  assert.equal(editInputValue("x_handle", "https://x.com/@meridianfx"), "meridianfx");
  assert.equal(editInputValue("telegram", "t.me/meridianfx"), "meridianfx");
  assert.equal(editInputValue("site", "https://meridian.finance"), "https://meridian.finance");
  assert.equal(coverTooLarge(new Blob([new Uint8Array(4_000_001)])), true);
  assert.equal(coverTooLarge(new Blob([new Uint8Array(4_000_000)])), false);
  assert.equal(saleDetailsRefusal({ status: "refused", code: "body_too_large", retryAfterSeconds: null }), "Use an image under 4 MB Code: body_too_large.");
  assert.equal(saleDetailsRefusal({ status: "error" }), "That didn't save. Nothing changed; try again in a moment. Code: request_failed.");
});

test("R3-28 (OA-16): every call goes through callSocialApi: a wallet session sends its cookie only, a cover goes as multipart", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const id = `0x${"ab".repeat(32)}`;
  const answer = { presale_id: id, metadata: FULL, editable: true };
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(answer);
  }) as typeof globalThis.fetch;
  const options = { getAccessToken: async () => null, fetch };
  assert.equal((await fetchSaleDetails(options, id)).status, "ok");
  assert.equal((await saveSaleDetails(options, id, { tagline: "x" })).status, "ok");
  assert.equal((await uploadSaleCover(options, id, new Blob([new Uint8Array([1])], { type: "image/png" }))).status, "ok");
  assert.deepEqual(await removeSaleCover(options, id), { status: "ok", body: null, httpStatus: 204 });
  assert.deepEqual(calls.map((call) => [call.init.method, call.url]), [
    ["GET", `/api/social/sales/${id}/metadata`],
    ["PUT", `/api/social/sales/${id}/metadata`],
    ["POST", `/api/social/sales/${id}/cover`],
    ["DELETE", `/api/social/sales/${id}/cover`],
  ]);
  for (const call of calls) {
    assert.equal(call.init.credentials, "same-origin");
    assert.equal((call.init.headers as Record<string, string>).authorization, undefined);
  }
  const upload = calls[2]!.init;
  assert.ok(upload.body instanceof FormData);
  assert.ok((upload.body as FormData).get("cover") instanceof Blob);
  assert.equal((upload.headers as Record<string, string>)["content-type"], undefined, "the browser sets the multipart boundary");
  const withToken = { getAccessToken: async () => "token", fetch };
  await saveSaleDetails(withToken, id, {});
  assert.equal((calls.at(-1)!.init.headers as Record<string, string>).authorization, "Bearer token");
});

test("R3-28-AC-6: a cancelled sale's main card keeps what was committed, with no launch venue, and says refunds are open", () => {
  const document = new JSDOM(render(null, "cancelled")).window.document;
  const raise = document.querySelector(".sale-raise")!;
  assert.match(raise.querySelector(".sale-raised")!.textContent!, /^[\d,]+ USDC of [\d,]+ USDC$/);
  assert.deepEqual([...raise.querySelectorAll(".sale-tiles > span > span")].map((label) => label.textContent), ["Total supply", "Ended", "Backers"]);
  assert.equal(document.querySelector(".sale-notice")?.textContent, "The target was missed. Everyone can claim a full refund.");
  const live = new JSDOM(render(null)).window.document;
  assert.deepEqual([...live.querySelectorAll(".sale-raise .sale-tiles > span > span")].map((label) => label.textContent), ["Total supply", "Ends in", "Backers", "Launches on"]);
});
