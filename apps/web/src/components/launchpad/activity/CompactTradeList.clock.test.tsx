import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const { act, memo } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CompactTradeList, CompactTradeRow } = await import("./CompactTradeList");

const NOW = 1_790_000_000_000;

test("each second redraws only the trade ages, never the rows", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const rows = [{ position: "2", at: NOW - 5_000 }, { position: "1", at: NOW - 65_000 }];
  let rowRenders = 0;
  const Row = memo(function Row({ at, entering, leaving }: Readonly<{ at: number; entering: boolean; leaving: boolean }>) {
    rowRenders += 1;
    return <CompactTradeRow side="buy" trader="trader" profile={null} timestampMs={at} tokens="10" quote={null} digest={null} explorer={null} entering={entering} leaving={leaving} />;
  });
  const visibility = { rows, held: false, holdRows() {}, hideSmallTrades: false, changeFilter() {}, allows: () => true };
  const container = dom.document.createElement("div");
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); });
  await act(async () => root.render(
    <CompactTradeList visibility={visibility}>{(row, state) => <Row key={row.position} at={row.at} {...state} />}</CompactTradeList>,
  ));
  const ages = () => [...container.querySelectorAll("li")].map((li) => li.querySelector("span")!.textContent!.split(" · ")[1]);
  assert.deepEqual(ages(), ["5s", "1m"]);
  const drawn = rowRenders;

  await act(async () => { t.mock.timers.tick(1_000); });
  assert.deepEqual(ages(), ["6s", "1m"]);
  await act(async () => { t.mock.timers.tick(55_000); });
  assert.deepEqual(ages(), ["1m", "2m"]);
  assert.equal(rowRenders, drawn, "a tick must not redraw a row");
});
