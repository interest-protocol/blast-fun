import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { installTestDom, recordAnimations } from "../../../../test/fixtures/social/test-dom.ts";
import { parseAllowlist } from "./allowlist-csv";

const dom = installTestDom();
const { document } = dom;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AllowlistReview } = await import("./AllowlistReview");

for (const count of [2, 50, 51, 100, 151]) {
  test(`${count} wallets: paging resets the rows, preserves page scroll and keeps keyboard focus in the dialog`, async () => {
    const container = document.createElement("div");
    container.setAttribute("data-blast-ui", "");
    document.body.append(container);
    const root = createRoot(container);
    const parsed = parseAllowlist("address,amount\n" + Array.from({ length: count }, (_, i) => `0x${(i + 1).toString(16)},${i + 1}.00`).join("\n"));
    let accepted = 0;
    let closed = 0;
    try {
      await act(async () => root.render(<AllowlistReview parsed={parsed} fileName="wallets.csv" symbol="USDC" busy={false} errors={[]} uploadError={null} onAccept={() => accepted++} onClose={() => closed++} />));
      const region = document.querySelector<HTMLDivElement>('[aria-label="Allowlist wallets"]')!;
      const nav = document.querySelector('[aria-label="Pages of wallets"]');
      const rows = () => [...region.querySelectorAll("tbody tr")];
      assert.equal(rows().length, Math.min(count, 50));
      assert.match(rows()[0]!.textContent!, /CSV line 2/);
      if (count <= 50) {
        assert.equal(nav, null, "one page needs no pager");
        return;
      }
      const previous = nav!.querySelector<HTMLButtonElement>('button[aria-label="Previous page"]')!;
      const next = nav!.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!;
      const current = () => nav!.querySelector('[aria-current="page"]')!.textContent;
      const firstEnabled = () => nav!.querySelector<HTMLButtonElement>("button:not([disabled])");
      assert.equal(current(), "1");
      assert.equal(previous.disabled, true);
      assert.equal(next.disabled, false);
      document.body.scrollTop = 321;
      region.scrollTop = 3948;
      next.focus();
      await act(async () => next.click());
      assert.equal(region.scrollTop, 0);
      assert.equal(document.body.scrollTop, 321);
      assert.equal(current(), "2");
      assert.equal(rows().length, Math.min(count - 50, 50));
      assert.match(rows()[0]!.textContent!, /CSV line 52/);
      assert.equal(document.activeElement, count <= 100 ? firstEnabled() : next, "focus never stays on a disabled control");
      assert.equal(accepted, 0);
      assert.equal(closed, 0);
      region.scrollTop = 1000;
      previous.focus();
      await act(async () => previous.click());
      assert.equal(region.scrollTop, 0);
      assert.equal(document.body.scrollTop, 321);
      assert.equal(document.activeElement, firstEnabled());
      assert.notEqual(document.activeElement, previous);
      assert.match(rows()[0]!.textContent!, /CSV line 2/);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      document.body.scrollTop = 0;
    }
  });
}

test("review groups whole digits and preserves all supported decimals, including trailing zeros and the u64 limit", async () => {
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.append(container);
  const root = createRoot(container);
  const amounts = ["250.00", "12649.75", "18446744073709.551615", "0.000001", "001234.500000"];
  const parsed = parseAllowlist("address,amount\n" + amounts.map((amount, i) => `0x${i + 1},${amount}`).join("\n"));
  try {
    await act(async () => root.render(<AllowlistReview parsed={parsed} fileName="limits.csv" symbol="USDC" busy={false} errors={[]} uploadError={null} onAccept={() => {}} onClose={() => {}} />));
    assert.deepEqual([...document.querySelectorAll("tbody td:last-child")].map(cell => cell.textContent), ["250.00", "12,649.75", "18,446,744,073,709.551615", "0.000001", "001,234.500000"]);
    assert.match(document.querySelector(".cr-list-header")!.textContent!, /5 wallets · Limits: 0\.000001–18,446,744,073,709\.551615 USDC/);
    assert.equal(document.querySelector('[aria-label="Pages of wallets"]'), null, "one page needs no pager");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("invalid CSV keeps a concise summary separate from all source diagnostics", async () => {
  const text = readFileSync(new URL("../../../../test/fixtures/social/allowlist-invalid-100.csv", import.meta.url), "utf8");
  const fileName = `${"a".repeat(251)}.csv`;
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AllowlistReview busy={false} errors={[]} fileName={fileName} onAccept={() => assert.fail("Invalid files cannot be accepted")} onClose={() => {}} parsed={parseAllowlist(text)} symbol="USDC" uploadError={null} />));
    const filename = dom.document.querySelector("[title]")!;
    assert.equal(filename.textContent, fileName);
    assert.equal(filename.getAttribute("title"), `${"a".repeat(24)}…`);
    const summary = dom.document.querySelector('[role="alert"]')!;
    assert.match(summary.textContent!, /50 rows need attention out of 100/);
    assert.doesNotMatch(summary.textContent!, /not-a-sui-address/);
    const diagnostics = dom.document.querySelector('[aria-label="CSV diagnostics"]')!;
    assert.equal(diagnostics.querySelectorAll("li").length, 50);
    assert.doesNotMatch(diagnostics.textContent!, /Fix your CSV/);
    assert.ok(!diagnostics.textContent!.includes(fileName));
    assert.match(diagnostics.querySelector("li")!.textContent!, /Line 7.*Address.*not-a-sui-address-6.*Invalid Sui address/);
    assert.match(diagnostics.querySelector("li:last-child")!.textContent!, /Line 101.*1.1234567890.*Maximum 6 decimal places/);
    assert.match(diagnostics.textContent!, /Duplicate wallet; first on line 2/);
    assert.match(dom.document.body.textContent!, /10 invalid addresses/);
    assert.match(dom.document.body.textContent!, /never rounded/);
    assert.equal(diagnostics.querySelector('[role="alert"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a small file has three compact diagnostics and escapes supplied text", async () => {
  const text = readFileSync(new URL("../../../../test/fixtures/social/allowlist-invalid.csv", import.meta.url), "utf8");
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  const render = (csv: string) => act(async () => root.render(<AllowlistReview busy={false} errors={[]} fileName="allowlist-invalid.csv" onAccept={() => assert.fail("Invalid files cannot be accepted")} onClose={() => {}} parsed={parseAllowlist(csv)} symbol="USDC" uploadError={null} />));
  try {
    await render(text);
    assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /3 rows need attention out of 4/);
    assert.equal(dom.document.querySelectorAll('[aria-label="CSV diagnostics"] li').length, 3);
    assert.equal(dom.document.querySelector('[aria-label="Issue categories"]'), null);
    assert.deepEqual([...dom.document.querySelectorAll('[aria-label="CSV diagnostics"] code')].map((code) => code.textContent), ["0x1", "not-a-sui-address", "100abc"]);
    await render('<img src=x onerror=alert(1)>,100\n0x1, "<b>bad</b>" ');
    const region = dom.document.querySelector('[aria-label="CSV diagnostics"]')!;
    assert.equal(region.querySelector("img, b"), null);
    assert.deepEqual([...region.querySelectorAll("code")].map((code) => code.textContent), ['<img src=x onerror=alert(1)>', ' "<b>bad</b>" ']);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("all wallets can be paged through with exact amounts, keyboard controls and explicit acceptance", async () => {
  const parsed = parseAllowlist(Array.from({ length: 51 }, (_, index) => `0x${(index + 1).toString(16)},${index + 1}.000001`).join("\n"));
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.append(container);
  const root = createRoot(container);
  let accepted = 0;
  let cancelled = 0;
  const motion = recordAnimations();
  try {
    await act(async () => root.render(<AllowlistReview busy={false} errors={[]} fileName="list.csv" onAccept={() => accepted++} onClose={() => cancelled++} parsed={parsed} symbol="USDC" uploadError={null} />));
    const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === text || element.getAttribute("aria-label") === text)!;
    const currentPage = () => document.querySelector('[aria-label="Pages of wallets"] [aria-current="page"]')?.textContent;
    assert.equal(document.querySelectorAll("tbody tr").length, 50);
    assert.equal(currentPage(), "1");
    assert.equal(button("Previous page").disabled, true);
    assert.equal(accepted, 0);
    assert.ok(document.querySelector('[aria-labelledby="cr-list-title"]'));
    assert.match(document.querySelector("tbody")!.textContent!, /50\.000001/);
    await act(async () => button("Next page").click());
    assert.equal(document.querySelectorAll("tbody tr").length, 1);
    assert.match(document.querySelector("tbody")!.textContent!, /51\.000001/);
    assert.equal(currentPage(), "2");
    assert.equal(button("Next page").disabled, true);
    await act(async () => button("Previous page").click());
    assert.equal(document.querySelectorAll("tbody tr").length, 50);
    await act(async () => button("Accept allowlist").click());
    assert.equal(accepted, 1);
    await act(async () => button("Cancel").click());
    await act(async () => motion.finishAll());
    assert.equal(cancelled, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("valid zero-prefixed amounts render promptly without changing their digits or decimals", async () => {
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.append(container);
  const root = createRoot(container);
  const parsed = parseAllowlist(`address,amount\n0x1,${"0".repeat(50_000)}1.000001\n`);
  assert.equal(parsed.errorCount, 0);
  try {
    const started = performance.now();
    await act(async () => root.render(<AllowlistReview parsed={parsed} fileName="zeros.csv" symbol="USDC" busy={false} errors={[]} uploadError={null} onAccept={() => {}} onClose={() => {}} />));
    const elapsed = performance.now() - started;
    assert.equal(document.querySelector("tbody td:last-child")!.textContent, `${"000,".repeat(16_666)}001.000001`);
    assert.ok(elapsed < 2_000, `Review rendering took ${Math.round(elapsed)} ms`);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("long filenames remain available and upload errors stay visible above the wallet table", async () => {
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.append(container);
  const root = createRoot(container);
  const fileName = `${"a".repeat(251)}.csv`;
  try {
    for (const csv of ["address,amount\n0x1,250.00", "address,amount\ninvalid,250.00"]) {
      await act(async () => root.render(<AllowlistReview parsed={parseAllowlist(csv)} fileName={fileName} symbol="USDC" busy={false} errors={[]} uploadError={null} onAccept={() => {}} onClose={() => {}} />));
      const invalid = parseAllowlist(csv).errorCount > 0;
      document.querySelector<HTMLDivElement>(invalid ? ".cr-csv-diagnostics" : ".cr-list-scroll")!.scrollTop = 500;
      await act(async () => root.render(<AllowlistReview parsed={parseAllowlist(csv)} fileName={fileName} symbol="USDC" busy={false} errors={[]} uploadError="Your list couldn't upload. Your current list is unchanged." onAccept={() => {}} onClose={() => {}} />));
      const filename = document.querySelector('[title]')!;
      assert.equal(filename.textContent, fileName);
      assert.equal(filename.getAttribute("title"), `${"a".repeat(24)}…`);
      if (invalid) {
        assert.match(document.querySelector(".cr-csv-header")!.textContent!, /Your list couldn't upload/);
      } else {
        assert.match(document.querySelector('.cr-list-notice[role="alert"]')!.textContent!, /Your list couldn't upload/);
        assert.equal(document.querySelector(".cr-list-scroll .cr-list-notice"), null, "recovery feedback must not scroll away with the rows");
        assert.equal(document.querySelector(".cr-list-scroll")!.scrollTop, 0);
        assert.doesNotMatch(document.querySelector(".cr-list-header")!.textContent!, /Your list couldn't upload/);
      }
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
