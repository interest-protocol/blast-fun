import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, testEvent } from "../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useTablePagination } = await import("./use-table-pagination");
const { TableFooter } = await import("./TableFooter");
const { presaleIdsOf } = await import("./presale-ids");
const { happeningPresale, happeningRead } = await import("../../../../test/fixtures/social/happening/happening-fixtures.ts");

function Table({ name, count, scope }: Readonly<{ name: "traders" | "posts"; count: number; scope: string }>) {
  const pagination = useTablePagination(name, count, scope);
  return <section data-table={name}>
    <output>{pagination.page}:{pagination.rows}:{Math.min(pagination.rows, count - pagination.start)}</output>
    <TableFooter what={name} {...pagination} />
  </section>;
}

test("independent table pages default to five, show the remainder, reset on size/window changes and clamp after removals", async t => {
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = async (count = 7, scope = "24h") => act(async () => root.render(<><Table name="traders" count={count} scope={scope} /><Table name="posts" count={12} scope="feed" /></>));
  const output = (table: string) => container.querySelector(`[data-table=${table}] output`)?.textContent;
  const click = async (selector: string) => act(async () => { const button = container.querySelector(selector); assert.ok(button); button.dispatchEvent(testEvent("click", { detail: 1 })); });
  await render();
  assert.equal(output("traders"), "1:5:5");
  assert.equal(output("posts"), "1:5:5");
  await click('[data-table=posts] [aria-label="Next page"]');
  assert.equal(output("posts"), "2:5:5");
  assert.equal(output("traders"), "1:5:5");
  await click('[data-table=traders] [aria-label="Next page"]');
  assert.equal(output("traders"), "2:5:2");
  assert.equal(output("posts"), "2:5:5");
  await render(3);
  assert.equal(output("traders"), "1:5:3");
  await render(7, "1h");
  assert.equal(output("traders"), "1:5:5");
  await click('[data-table=traders] [aria-label="Next page"]');
  await click('[aria-label="Traders rows per page: 5 per page"]');
  const ten = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent!.includes("10 per page"));
  assert.ok(ten);
  await act(async () => ten.dispatchEvent(testEvent("click", { detail: 1 })));
  assert.equal(output("traders"), "1:10:7");
  assert.equal(output("posts"), "2:5:5");
  assert.equal(container.querySelector('[data-table=traders] nav'), null);
  assert.ok(container.querySelector('[aria-label="Traders rows per page: 10 per page"]'), "#518's rows label (#526)");
});

test("eligible presales beyond the first five remain available for pagination, without duplicates", () => {
  const sales = Array.from({ length: 7 }, (_, i) => happeningPresale({ presale_id: `sale-${i}` }));
  const ids = presaleIdsOf(happeningRead({ today: sales.slice(0, 2), fastest: sales, opening_soon: [] }), sales[0]!.presale.start_ms + 1);
  assert.deepEqual(ids.ids, sales.map(sale => sale.presale.presale_id));
});
