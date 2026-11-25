import assert from "node:assert/strict";
import test from "node:test";

import type { SocialBuyAlert } from "@blast/core/modules/social/contracts/buy-alerts.ts";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ALERT_LIFE_MS, FollowedBuyAlert, buyAlertText } = await import("./FollowedBuyAlert");

function alert(overrides: Partial<SocialBuyAlert> = {}): SocialBuyAlert {
  return {
    activity_id: "1200:3:1:0",
    occurred_at_ms: 1_000,
    actor: { type: "account", callsign: "maya", display_name: "Maya", avatar_url: null, x_handle: null, path: "/@maya", verified: false },
    wallet: `0x${"a1".repeat(32)}`,
    coin: { presale_id: null, coin_type: `0x${"d4".repeat(32)}::orbit::ORBIT`, symbol: "ORBIT", name: "Orbit", icon_url: null },
    usd: "120.00",
    market_cap_usd: "45000.00",
    ...overrides,
  };
}

test("the line reads who, how much, which coin and the cap; missing parts drop out", () => {
  assert.deepEqual(buyAlertText(alert()), { name: "Maya", amount: "$120", symbol: "ORBIT", cap: "$45K" });
  const bare = buyAlertText(alert({ usd: null, market_cap_usd: null, actor: { ...alert().actor, display_name: null } }));
  assert.deepEqual(bare, { name: "maya", amount: null, symbol: "ORBIT", cap: null });
});

async function mount(t: test.TestContext, value: SocialBuyAlert) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const closed: number[] = [];
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<FollowedBuyAlert alert={value} coinHref="/coin/orbit" onClose={() => closed.push(1)} />));
  return { container, closed };
}

test("the card reads as one line with profile and coin links and a dismiss button", async (t) => {
  const { container } = await mount(t, alert());
  const card = container.querySelector('[data-buy-alert]');
  assert.match(card?.textContent ?? "", /^Maya bought \$120 of ORBIT · \$45K cap$/);
  const hrefs = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
  assert.deepEqual(hrefs, ["/@maya", "/@maya", "/coin/orbit"]);
  assert.ok(container.querySelector('button[aria-label="Dismiss"]'));
});

test("without a price or cap the line says only who bought which coin", async (t) => {
  const { container } = await mount(t, alert({ usd: null, market_cap_usd: null }));
  const text = container.querySelector('[data-buy-alert]')?.textContent ?? "";
  assert.match(text, /^Maya bought ORBIT$/);
  assert.doesNotMatch(text, /cap|\$/);
});

test("the card leaves after its life, and hover pauses the count", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { container, closed } = await mount(t, alert());
  const card = container.querySelector<HTMLElement>('[data-buy-alert]')!;
  const pointer = (type: string) => {
    const event = new window.PointerEvent(type, { bubbles: type !== "pointerenter" && type !== "pointerleave", pointerType: "mouse" });
    card.dispatchEvent(event);
  };
  await act(async () => { t.mock.timers.tick(ALERT_LIFE_MS - 1_000); });
  await act(async () => { pointer("pointerover"); pointer("pointerenter"); });
  await act(async () => { t.mock.timers.tick(10_000); });
  assert.equal(card.hasAttribute("data-leaving"), false, "hover holds the card");
  await act(async () => { pointer("pointerout"); pointer("pointerleave"); });
  await act(async () => { t.mock.timers.tick(1_000); });
  assert.equal(card.getAttribute("data-leaving"), "fade");
  await act(async () => { t.mock.timers.tick(500); });
  assert.equal(closed.length, 1, "the exit ends even without a transition event");
});

test("the dismiss button sends the card up", async (t) => {
  const { container } = await mount(t, alert());
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!;
  await act(async () => { button.click(); });
  assert.equal(container.querySelector('[data-buy-alert]')?.getAttribute("data-leaving"), "up");
});

test("worst cases: a long name, no icon, no cap and a huge amount still make one short line", async (t) => {
  const name = "W".repeat(120);
  const huge = alert({ actor: { ...alert().actor, display_name: name }, usd: "987654321098765.43", market_cap_usd: null, coin: { ...alert().coin, symbol: "SUPERLONGSYMBOLNAME", icon_url: null } });
  const text = buyAlertText(huge);
  assert.ok(text.amount !== null && text.amount.length <= 12, `compact amount (the shared formatter tops out at B): ${text.amount}`);
  const { container } = await mount(t, huge);
  const card = container.querySelector('[data-buy-alert]')!;
  assert.equal(card.querySelector("a")?.getAttribute("href"), "/@maya");
  assert.match(card.textContent ?? "", new RegExp(`^${name} bought \\${text.amount} of SUPERLONGSYMBOLNAME$`));
});
