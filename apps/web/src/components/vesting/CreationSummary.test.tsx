import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PUBLIC_PREFERRED_COINS } from "#web/components/social/coins/coin-model.ts";
import { LiveSummary } from "./CreationSummary";
import type { CreationInput } from "./creation-model";

const coin = PUBLIC_PREFERRED_COINS.find((item) => item.symbol === "SUI")!;
const draft: CreationInput = {
  coinType: coin.coinType,
  decimals: coin.decimals,
  total: "0.000000003",
  beneficiary: `0x${"a".repeat(64)}`,
  kind: "checkpoints",
  start: "",
  end: "",
  periodDays: "30",
  periods: "12",
  cliffDays: "0",
  releases: [
    { key: "one", date: "2030-01-01T12:00", amount: "0.000000001" },
    { key: "two", date: "2030-02-01T12:00", amount: "0.000000002" },
  ],
  cancelable: false,
  refund: "",
  capRecipient: "",
};
test("a valid custom summary retains the exact amount and completed dates", () => {
  const html = renderToStaticMarkup(<LiveSummary draft={draft} coin={coin} />);
  assert.match(html, />0\.000000003 SUI<\/div>/);
  assert.doesNotMatch(html, /title="0\.000000003 SUI"/);
  assert.match(html, /2 release dates/);
  assert.doesNotMatch(html, /Add a valid amount|Complete schedule/);
});
test("an incomplete schedule cannot invent release dates", () => {
  const html = renderToStaticMarkup(
    <LiveSummary
      draft={{ ...draft, releases: [{ ...draft.releases[0]!, date: "" }] }}
      coin={coin}
    />,
  );
  assert.match(html, /Complete schedule/);
  assert.doesNotMatch(html, /All 1 releases|2030/);
});

test("a single checkpoint has one date and retains its exact amount", () => {
  const html = renderToStaticMarkup(
    <LiveSummary
      draft={{
        ...draft,
        kind: "checkpoints",
        total: "124968397.112711982",
        releases: [
          {
            key: "single",
            date: "2030-01-01T12:00",
            amount: "124968397.112711982",
          },
        ],
      }}
      coin={coin}
    />,
  );
  assert.match(html, /≈ 124.9683M SUI/);
  assert.match(html, /aria-label="Inspect full vesting amount: 124968397\.112711982 SUI"/);
  assert.doesNotMatch(html, /title="124968397\.112711982 SUI"/);
  assert.match(html, /1 release date/);
  assert.match(html, /Release date/);
  assert.doesNotMatch(html, /1 releases|First release|Final release/);
});

test("continuous summary shows a linear graph, start and end instead of release steps", () => {
  const html = renderToStaticMarkup(
    <LiveSummary
      draft={{
        ...draft,
        kind: "linear",
        total: "100",
        start: "2030-01-01T12:00",
        end: "2031-01-01T12:00",
      }}
      coin={coin}
    />,
  );
  assert.match(html, /Linear · continuous/);
  assert.match(html, /Vesting starts/);
  assert.match(html, /Fully vested/);
  assert.match(html, /Linear vesting: tokens unlock continuously/);
  assert.doesNotMatch(html, /per step|releases · every|1 ms|custom release/);
});
