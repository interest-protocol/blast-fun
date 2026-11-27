import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AccountBalance } from "./AccountBalance";
import { balanceBreakdown, balanceNote, balanceAmount } from "./account-balance-model.ts";

test("zero and large balances retain cents; hiding amounts removes them from accessible text too", () => {
  for (const [value, text] of [[0, "$0.00"], [1234567890.12, "$1,234,567,890.12"]] as const) {
    const portfolio = { status: "ready", summary: { total_usd: value, today: null } } as const;
    const visible = renderToStaticMarkup(<AccountBalance hidden={false} portfolio={portfolio} />);
    assert.ok(visible.includes(text));
    assert.ok(!visible.includes("Total balance"), "only the amount and chevron are displayed");
    const hidden = renderToStaticMarkup(<AccountBalance hidden portfolio={portfolio} />);
    assert.ok(!hidden.includes(text));
    assert.ok(hidden.includes("••••") && hidden.includes("Portfolio value, hidden"));
  }
});

test("unknown balances use a skeleton with an accessible status, never an estimated zero", () => {
  const pending = renderToStaticMarkup(<AccountBalance hidden={false} portfolio={{ status: "loading" }} />);
  assert.match(pending, /Portfolio value, Loading…/);
  assert.match(pending, /aria-busy="true"/);
  assert.match(pending, /data-nav-bal=""><span aria-hidden="true" class="balancePlaceholder"><\/span>/);
  assert.doesNotMatch(pending, /\$0\.00/);
  const unavailable = renderToStaticMarkup(<AccountBalance hidden={false} portfolio={{ status: "unavailable" }} />);
  assert.match(unavailable, /Unavailable/);
  assert.doesNotMatch(unavailable, /\$0\.00|balancePlaceholder/);
});

test("a ready portfolio with unpriced assets is not presented as a failed read", () => {
  const portfolio={status:"ready",summary:{total_usd:null,known_value_usd:123.45,today:null,unpriced_assets:true}} as const;
  const html=renderToStaticMarkup(<AccountBalance hidden={false} portfolio={portfolio}/>);
  assert.match(html,/aria-label="Portfolio value, \$123\.45\. Portfolio breakdown\. Some assets have no price/);
  assert.doesNotMatch(html,/Unavailable|\$0\.00/);
  const hidden=renderToStaticMarkup(<AccountBalance hidden portfolio={portfolio}/>);
  assert.doesNotMatch(hidden,/\$123\.45|Unpriced assets/);
});


test("a portfolio with only unpriced holdings never presents a zero-dollar total", () => {
  const html = renderToStaticMarkup(<AccountBalance hidden={false} portfolio={{ status: "ready", summary: { total_usd: null, unpriced_assets: true, today: null } }} />);
  assert.match(html, /aria-label="Portfolio breakdown\. Your coins have no USD price yet/);
  assert.match(html, />Portfolio<\/span>/);
  assert.doesNotMatch(html, /\$0/);
});

test("a known zero subtotal is distinct from missing prices", () => {
  const html = renderToStaticMarkup(<AccountBalance hidden={false} portfolio={{ status: "ready", summary: { total_usd: null, known_value_usd: 0, unpriced_assets: true, today: null } }} />);
  assert.match(html, /aria-label="Portfolio value, \$0\.00\. Portfolio breakdown\. Some assets have no price/);
});

test("#601: under a priced subtotal the breakdown shows each category's priced part, never Unavailable beside a total that counts it", () => {
  const portfolio = { status: "ready", summary: { total_usd: null, known_value_usd: 9268036.06, unpriced_assets: true, today: null,
    breakdown: { coins: null, committed: 0, claimable: 0 }, known_breakdown: { coins: 9268036.06, committed: 0, claimable: 0 } } } as const;
  assert.deepEqual(balanceBreakdown(portfolio, false), [
    { label: "Coins", value: "$9,268,036.06" },
    { label: "In presales", value: "$0.00" },
    { label: "To claim", value: "$0.00" },
  ]);
  const onlyUnpriced = { status: "ready", summary: { ...portfolio.summary, known_value_usd: 0, known_breakdown: { coins: 0, committed: 0, claimable: 0 } } } as const;
  assert.equal(balanceBreakdown(onlyUnpriced, false)[0]!.value, "No price");
  assert.ok(balanceBreakdown(portfolio, true).every(({ value }) => !/\$9|unpriced|Unpriced/.test(value)), "hidden amounts stay hidden");
  // A failed holdings read is still Unavailable, not a priced part.
  const unread = { status: "ready", summary: { total_usd: null, today: null, breakdown: { coins: null, committed: 850, claimable: 250 } } } as const;
  assert.equal(balanceBreakdown(unread, false)[0]!.value, "Unavailable");
  assert.equal(balanceBreakdown({ status: "loading" }, false)[0]!.value, "Loading…");
});

test("a nonzero amount under a cent reads <$0.01 in the breakdown, never $0.00", () => {
  const portfolio = { status: "ready", summary: { total_usd: null, known_value_usd: 0.004, unpriced_assets: true, today: null,
    breakdown: { coins: null, committed: 0, claimable: 0 }, known_breakdown: { coins: 0.004, committed: 0, claimable: 0 } } } as const;
  assert.equal(balanceBreakdown(portfolio, false)[0]!.value, "<$0.01");
  assert.equal(balanceBreakdown(portfolio, false)[1]!.value, "$0.00");
});

test("a five-figure balance carries its short form beside the exact one, for the narrow bar to show $12.35K", () => {
  const html = renderToStaticMarkup(<AccountBalance hidden={false} portfolio={{ status: "ready", summary: { total_usd: 12_345.67, today: null } }} />);
  assert.match(html, /<span class="balanceExact">\$12,345\.67<\/span><span class="balanceCompact">\$12\.35K<\/span>/);
});

test("the balance shows a short partial-value marker", () => {
  const portfolio = { status: "ready", summary: { total_usd: null, known_value_usd: 4550.34, unpriced_assets: true, today: null } } as const;
  assert.match(renderToStaticMarkup(<AccountBalance hidden={false} portfolio={portfolio} />), />\$4,550\.34<\/span>.*> · Partial<\/span><\/b>/);
});

test("the popover's large total is the amount alone on one line; its description names the subtotal", () => {
  const portfolio = { status: "ready", summary: { total_usd: null, known_value_usd: 6925984.19, unpriced_assets: true, today: null } } as const;
  assert.equal(balanceAmount(portfolio, false), "$6,925,984.19");
  assert.doesNotMatch(balanceAmount(portfolio, true), /\d/, "hidden stays hidden");
  assert.equal(balanceAmount({ status: "ready", summary: { total_usd: 12.5, today: null } }, false), "$12.50");
});

test("WS-4: the popover says why there is no full total, and offers Try again only when trying again can help", () => {
  assert.deepEqual(balanceNote({ status: "unavailable" }, false), { title: "Your balance didn’t load", text: "Your coins are safe.", retry: true });
  const unread = { status: "ready", summary: { total_usd: null, today: null } } as const;
  assert.equal(balanceNote(unread, false)?.retry, true);
  // Missing prices are not a failure: nothing to retry.
  assert.deepEqual(balanceNote({ status: "ready", summary: { total_usd: null, known_value_usd: 0, unpriced_assets: true, today: null } }, false), { text: "Some assets have no price and aren’t included in these values.", retry: false });
  assert.equal(balanceNote({ status: "ready", summary: { total_usd: null, unpriced_assets: true, today: null } }, false)?.retry, false);
  assert.equal(balanceNote({ status: "ready", summary: { total_usd: 12, today: null } }, false), null);
  assert.equal(balanceNote({ status: "loading" }, false), null);
  assert.equal(balanceNote({ status: "unavailable" }, true), null);
});
