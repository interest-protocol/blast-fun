import assert from "node:assert/strict";
import test from "node:test";
import { PROFILE_PNL } from "../../../../test/fixtures/social/profile/pnl-fixtures.ts";
import { canCreatePnlCard } from "./pnl-model.ts";
import { PNL_CARD_TEMPLATES, pnlCardDescription, pnlCardPng, pnlCardSvg, pnlCardTemplates } from "./pnl-card.ts";

const card = { callsign: "nova", figures: PROFILE_PNL.totals };

test("social PnL cards show the headline result without calculation details", () => {
  const svg = pnlCardSvg(card);
  for (const text of ["ACCOUNT PnL", "PnL SINCE LAUNCH", "−$170.00", "THIS IS FINE.", "@nova", "blast.fun/?ref=nova"]) assert.ok(svg.includes(text), text);
  assert.ok(svg.includes('width="1200" height="675"'));
  assert.ok(svg.includes('fill="#FFFFFF"'));
  assert.ok(svg.includes('fill="#FF4C98"'));
  for (const detail of ["REALIZED", "UNREALIZED", "Snapshot", "Gas excluded", "Transfers", "wallet", "−$130.00", "−$40.00"]) assert.ok(!svg.includes(detail), detail);
});

test("coin cards include closed losses and open gains, without substituting unknown PnL for zero", () => {
  for (const asset of PROFILE_PNL.assets) {
    const expected = asset.total_usd === "80.00"
      ? { sticker: "/social/pnl-gain-meme.webp", amount: "+$80.00", color: "#117A43", caption: "MONEY PRINTER GO BRRR." }
      : { sticker: "/social/pnl-loss-meme.webp", amount: "−$250.00", color: "#D32F45", caption: "THIS IS FINE." };
    const svg = pnlCardSvg({ ...card, figures: asset, asset });
    assert.ok(svg.includes(`$${asset.symbol}`));
    assert.ok(svg.includes(`href="${expected.sticker}"`));
    assert.ok(svg.includes(asset.tracked_balance === "0" ? "PnL SINCE LAUNCH · CLOSED" : "PnL SINCE LAUNCH"));
    assert.ok(svg.includes(`fill="${expected.color}">${expected.amount}</text>`), "green gains and red losses retain explicit signs");
    assert.ok(svg.includes(expected.caption));
    assert.ok(pnlCardDescription({ ...card, figures: asset, asset }).includes(expected.amount));
  }
  const zero = { realized_usd: "0.00", unrealized_usd: "0.00", total_usd: "0.00" };
  assert.ok(pnlCardSvg({ ...card, figures: zero }).includes("EVEN STEVEN."));
  for (const total_usd of [null, "NaN"]) {
    const figures = { ...zero, total_usd };
    assert.equal(canCreatePnlCard(figures), false);
    assert.throws(() => pnlCardSvg({ ...card, figures }), /incomplete/);
  }
  assert.equal(canCreatePnlCard({ ...zero, realized_usd: null }), false);
});

test("card labels escape SVG markup and large exact amounts fit within the card", () => {
  const svg = pnlCardSvg({ ...card, callsign: '<script>alert("x")</script>&', figures: { ...card.figures, total_usd: "9007199254740993.12" } });
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes('&lt;script&gt;alert("x")&lt;/script&gt;&amp;'));
  assert.ok(svg.includes("+$9,007,199,254,740,993.12"));
  assert.ok(svg.includes('textLength="580"'));
});

test("meme captions and embedded artwork preserve PnL", async () => {
  const image = "data:image/png;base64,aGVsbG8=";
  const svg = pnlCardSvg(card, { meme: "diamond", image });
  assert.ok(svg.includes("DIAMOND HANDS."));
  assert.ok(svg.includes("−$170.00"));
  assert.ok(svg.includes(`href="${image}"`));
  assert.ok(!svg.includes("/social/pnl-loss-meme.webp"), "custom artwork replaces the automatic loss sticker");
  assert.ok(pnlCardSvg(card).includes('/social/pnl-loss-meme.webp'), "removing custom artwork restores the default");
  assert.ok(svg.includes('x="0" y="0" width="1200" height="675" preserveAspectRatio="xMidYMid slice"'), "artwork fills the whole background");
  assert.ok(svg.indexOf("<image ") < svg.indexOf("@nova"), "the result and identity render above the image");
  assert.ok(svg.includes('fill="url(#readability)"'), "keep text legible over custom photos");
  for (const image of ['https://outside.test/meme.png', 'data:image/svg+xml,<svg/>', 'data:image/png;base64,x" onload="alert(1)']) {
    assert.throws(() => pnlCardSvg(card, { meme: "fine", image }), /prepared card image/);
  }
});


test("coin identity survives export, including closed positions and unavailable icons", async (t) => {
  const asset = PROFILE_PNL.assets[1];
  const coinCard = { ...card, figures: asset, asset };
  const icon = "data:image/png;base64,aWNvbg==";
  const svg = pnlCardSvg(coinCard, { meme: "auto", coinIcon: icon });
  assert.ok(svg.includes(`href="${icon}"`));
  assert.ok(svg.includes('clip-path="url(#coin-icon)"'));
  assert.ok(svg.includes("PnL SINCE LAUNCH · CLOSED"));
  assert.ok(!pnlCardSvg(card).includes('clip-path="url(#coin-icon)"'), "account cards have no coin identity");
  assert.match(pnlCardSvg(coinCard), /text-anchor="middle"[^>]*>L<\/text>/, "missing icons use the coin initial");
  assert.throws(() => pnlCardSvg(coinCard, { meme: "auto", coinIcon: 'https://outside.test/icon.png' }), /prepared card image/);

  const oldImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const decoded: string[] = [];
  let blocked = false;
  Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
    src = ""; crossOrigin = ""; naturalWidth = 64; naturalHeight = 64;
    async decode() {
      decoded.push(this.src);
      if (this.src.startsWith("https://")) {
        assert.equal(this.crossOrigin, "anonymous");
        if (blocked) throw new Error("CORS blocked");
      }
    }
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({
    getContext: () => ({ drawImage() {} }), toDataURL: () => icon,
    toBlob: (done: BlobCallback) => done(new Blob(["png"], { type: "image/png" })),
  }) } });
  t.after(() => {
    if (oldImage) Object.defineProperty(globalThis, "Image", oldImage); else Reflect.deleteProperty(globalThis, "Image");
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document");
  });
  const remote = { ...coinCard, asset: { ...asset, icon_url: "https://coins.test/lumn.png" } };
  assert.equal((await pnlCardPng(remote)).type, "image/png");
  const exported = () => decodeURIComponent(decoded.at(-1)!.split(",").slice(1).join(","));
  assert.ok(exported().includes(`href="${icon}" x="64"`), "remote icon is embedded in the exported artwork");
  assert.ok(!exported().includes("https://coins.test"), "the export has no dependency on a remote icon");
  blocked = true;
  assert.equal((await pnlCardPng(remote)).type, "image/png");
  assert.match(exported(), /text-anchor="middle"[^>]*>L<\/text>/, "an unavailable icon does not prevent sharing a closed loss");
  await pnlCardPng(coinCard, { meme: "auto", template: "death", image: icon });
  assert.ok(exported().includes("sayin it since $MELANIA"), "custom artwork preserves the selected Death caption");
  assert.ok(exported().includes('fill="#D32F45">−$250.00'), "custom artwork retains readable loss text");
});


test("the Death meme pairs its own background with the last-time caption and preserves embedded artwork", () => {
  const asset = PROFILE_PNL.assets[1];
  const closed = { ...card, figures: asset, asset };
  const death = pnlCardSvg(closed, { meme: "last" });
  for (const value of ["/social/pnl-death-meme.webp", "This is the last time.", "sayin it since $MELANIA", "−$250.00", "$LUMN", "PnL SINCE LAUNCH · CLOSED"]) assert.ok(death.includes(value), value);
  assert.ok(!death.includes("THIS IS FINE."));
  const custom = "data:image/png;base64,aGVsbG8=";
  const personalized = pnlCardSvg(closed, { meme: "last", image: custom });
  assert.ok(personalized.includes(`href="${custom}"`));
  assert.ok(!personalized.includes("/social/pnl-death-meme.webp"));
  assert.ok(personalized.includes("sayin it since $MELANIA"));
  assert.ok(!pnlCardSvg(closed).includes("sayin it since $MELANIA"), "other versions keep their own captions");
});

test("handoff styles retain live PnL, coin identity and closed losses without sample returns", () => {
  const asset = PROFILE_PNL.assets[1];
  const closed = { ...card, figures: asset, asset };
  assert.equal(PNL_CARD_TEMPLATES.length, 9);
  for (const template of PNL_CARD_TEMPLATES.slice(0, 6)) {
    const svg = pnlCardSvg(closed, { meme: "auto", template: template.value });
    assert.ok(svg.includes(`href="${template.artwork}"`), template.label);
    for (const value of ["−$250.00", "$LUMN", "PnL SINCE LAUNCH · CLOSED", "@nova"]) assert.ok(svg.includes(value), `${template.label}: ${value}`);
    for (const sample of ["128.4%", "1,284.00", "ORBIT", "mikecantmiss", "ENTRY", "EXIT", "INVESTED", "HELD"]) assert.ok(!svg.includes(sample), sample);
    assert.ok(svg.includes(`fill="${template.ink.down}">−$250.00`));
    assert.ok(!svg.includes('fill="url(#readability)"'), "preserve handoff background colors");
  }
});

for (const scenario of [
  { total: "1284.00", amount: "+$1,284.00", tone: "up", count: 7 },
  { total: "-1284.00", amount: "−$1,284.00", tone: "down", count: 8 },
  { total: "0.00", amount: "$0.00", tone: "paper", count: 6 },
] as const) {
  test(`eligible designs preserve exact figures for ${scenario.amount}`, async () => {
    const current = { ...card, figures: { realized_usd: scenario.total, unrealized_usd: "0.00", total_usd: scenario.total } };
    const before = structuredClone(current);
    const templates = pnlCardTemplates(current);
    assert.equal(templates.length, scenario.count);
    for (const template of PNL_CARD_TEMPLATES) {
      const style = { meme: "auto", template: template.value } as const;
      if (!templates.includes(template)) {
        assert.throws(() => pnlCardSvg(current, style), /design is unavailable/);
        await assert.rejects(pnlCardPng(current, style), /design is unavailable/);
        continue;
      }
      const svg = pnlCardSvg(current, style);
      for (const value of [scenario.amount, "@nova", "ACCOUNT PnL", "PnL SINCE LAUNCH", "blast.fun/?ref=nova", template.artwork]) assert.ok(svg.includes(value), `${template.label}: ${value}`);
      const result = svg.match(/<text\b[^>]*>[^<]*<\/text>/g)?.find((element) => element.endsWith(`>${scenario.amount}</text>`));
      assert.ok(result?.includes(`fill="${template.ink[scenario.tone]}"`));
    }
    assert.deepEqual(current, before);
  });
}

test("all eligible designs preserve coin identity and closed losses", () => {
  const closed = PROFILE_PNL.assets[1];
  const closedCard = { ...card, asset: closed, figures: closed };
  for (const template of pnlCardTemplates(closedCard)) {
    const svg = pnlCardSvg(closedCard, { meme: "auto", template: template.value });
    for (const value of ["−$250.00", "$LUMN", "PnL SINCE LAUNCH · CLOSED", "blast.fun/?ref=nova"]) assert.ok(svg.includes(value));
  }
  assert.ok(pnlCardSvg(card, { meme: "auto", template: "death" }).includes("sayin it since $MELANIA"));
});
