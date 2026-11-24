import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { CommitDialog, SaleDialog } from "./CommitDialog";
import { commitSaleOf, commitViewerOf, type CommitSaleRead } from "./commit-view";

/**
 * OA-24 (the gate `design/blast-feel-preview-oa24.html`, sha256 232e34aa…3017f0a,
 * "Review pass"): the commit sheet docks its confirm/deposit button to the
 * sheet's bottom edge while the terms and the why scroll under it
 * (`.cta-dock`, `.sheet.has-dock`), and the sale sheet's bar wears its stage
 * once the sale stops filling: funded blue, cancelled grey (the gate's sheet
 * rule has no trading colour).
 */

const PRESALE = `0x${"ab".repeat(32)}`;
const START = 1_791_000_000_000;

function read(overrides: Partial<CommitSaleRead["presale"]> = {}): CommitSaleRead {
  return {
    presale: {
      presale_id: PRESALE,
      name: "Meridian",
      symbol: "MRDN",
      icon_url: "https://i/mrdn.png",
      phase: "open",
      venue: "cetus",
      start_ms: START,
      end_ms: START + 86_400_000,
      target_usd: "250000.00",
      raised_usd: "184221.00",
      fill_bps: 7_368,
      participants: 1_012,
      interested: 1_840,
      multiple: null,
      quote_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", quote_symbol: "USDC",
      quote_decimals: 6,
      target_atoms: "250000000000",
      raised_atoms: "184221000000",
      sale_token: `0x${"5a".repeat(32)}::mrdn::MRDN`,
      sale_decimals: 9,
      allowlisted: false,
      min_commitment_usd: "10.00",
      wallet_cap_usd: "25000.00",
      min_commitment_atoms: "10000000",
      wallet_cap_atoms: "25000000000",
      ...overrides,
    },
    terms: { presale_price_usd: "0.000556", presale_price_quote: "0.000556", supply: { total: "1000000000000000000" } },
    vesting: null,
  };
}

function commitDialog(): string {
  const detail = read();
  const sale = commitSaleOf(detail, { suiUsd: 3.42 })!;
  const viewer = commitViewerOf({ wallet: null, sale, entry: null, allowlist: null });
  return renderToStaticMarkup(
    <CommitDialog
      blockers={[]}
      detail={detail}
      nowMs={START}
      onBlast={async () => ({ ok: true })}
      onDeposit={() => undefined}
      onRequestClose={() => undefined}
      open
      sale={sale}
      viewer={viewer}
    />,
  );
}

test("OA-24: the commit sheet docks its one primary button to the bottom edge; the presale link stays in its scrollable body", () => {
  const html = commitDialog();
  assert.match(html, /<dialog aria-labelledby="[^"]+" aria-modal="true" class="sheet hasDock trade" open=""/);
  // The dock keeps the primary action and lock/refund terms visible together.
  const bodyEnd = html.indexOf('<div class="dock">');
  assert.ok(html.indexOf('class="purchaseBody"') < html.indexOf('class="sheetLink"'));
  assert.ok(html.indexOf('class="sheetLink"') < bodyEnd);
  assert.match(html.slice(bodyEnd), /<p class="commitTerms">Locked until close\. Unallocated payment refunded; full refund if the target is missed\.<\/p>/);

  assert.equal(html.match(/class="dock"/g)?.length, 1);
  // The sale sheet (every state but open) has no panel, so no dock.
  const funded = renderToStaticMarkup(<SaleDialog detail={read({ phase: "funded", fill_bps: 12_500 })} nowMs={START} onRequestClose={() => undefined} open />);
  assert.doesNotMatch(funded, /hasDock|class="dock"/);
});

test("OA-24: the dock's geometry is the gate's: sticky at 0, bleeding to the sheet's sides, a 13px fade, 28px under (21 + the safe area on phones)", () => {
  const css = readFileSync(new URL("../../blast-ui/Sheet.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.match(css, /\.sheet\.hasDock \{ padding-bottom: 0; \}/);
  assert.match(css, /\.sheet\.hasDock > :last-child \{ margin-bottom: 21px; \}/);
  assert.match(
    css,
    /\.dock \{\s*position: sticky;\s*bottom: 0;\s*z-index: 2;\s*display: flex;\s*flex-direction: column;\s*margin: -13px calc\(var\(--sheet-px\) \* -1\) 0;\s*padding: 13px var\(--sheet-px\) 28px;\s*background: linear-gradient\(to bottom, transparent, var\(--card\) 13px\);\s*\}/,
  );
  assert.match(phone, /\.dock \{ padding-bottom: calc\(21px \+ env\(safe-area-inset-bottom, 0px\)\); \}/);
  assert.match(phone, /\.sheet\.hasDock > :last-child \{ margin-bottom: calc\(21px \+ env\(safe-area-inset-bottom, 0px\)\); \}/);
});

test("OA-24: the sale sheet's bar wears funded and cancelled; open and trading keep the pink fill", () => {
  function stage(html: string) {
    const dom = new JSDOM(html);
    try {
      const progress = dom.window.document.querySelector("[data-progress-bar]");
      assert.ok(progress);
      assert.ok(progress.querySelector("i"));
      return progress.getAttribute("data-stage");
    } finally {
      dom.window.close();
    }
  }
  for (const [phase, expected] of [["funded", "funded"], ["cancelled", "cancelled"], ["trading", null]] as const) {
    const html = renderToStaticMarkup(<SaleDialog detail={read({ phase, fill_bps: phase === "cancelled" ? 2_040 : 10_000 })} nowMs={START} onRequestClose={() => undefined} open />);
    assert.equal(stage(html), expected);
  }
  assert.equal(stage(commitDialog()), null);
});
