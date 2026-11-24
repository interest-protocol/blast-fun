import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";
import { presaleDetailQuery } from "#web/components/social/queries.ts";
import { FIXTURE_NOW, fixtureDetail } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { SaleView, TeamVestingRow } from "./SaleView";
import { SaleSkeleton } from "./SaleLoading";
import { RowSkeletons } from "#web/components/social/portfolio/HoldingsSkeleton.tsx";

const base = fixtureDetail("mrdn");

test("every lifecycle stage has its own state line, and trading is the coin page with no unfinished tail", () => {
  const lines = new Map<string, string>();
  for (const phase of ["pending", "open", "closed", "funded", "cancelled", "trading"] as const) {
    const detail = { ...base, presale: { ...base.presale, phase } };
    const document = new JSDOM(renderToStaticMarkup(<SaleView detail={detail} nowMs={FIXTURE_NOW} viewerEntry={null} />)).window.document;
    const notice = document.querySelector(".sale-notice");
    if (phase === "trading") {
      assert.equal(notice, null, "a trading coin has no presale state line");
      assert.ok(document.querySelector("[data-coin-identity]"), "trading is drawn as the Coin board");
      continue;
    }
    assert.equal(notice?.getAttribute("role"), "status", phase);
    assert.doesNotMatch(notice!.textContent!, /Unlocks/, phase);
    lines.set(phase, [...notice!.querySelectorAll("[data-notice]")].map((part) => part.textContent).join(" · "));
  }
  assert.match(lines.get("pending")!, /^Opens .* · Then trades on Cetus$/);
  assert.match(lines.get("open")!, /^Opened .* · Closes .* · Then trades on Cetus$/);
  assert.match(lines.get("closed")!, /^Closed .* · The result settles on chain shortly\.$/);
  assert.match(lines.get("funded")!, /^Funded · Claims open when trading starts on Cetus$/);
  assert.equal(lines.get("cancelled"), "The target was missed. Everyone can claim a full refund.");
});

test("sale loading reserves the board layout and holdings wait for confirmed lifecycle data", () => {
  const sale = new JSDOM(renderToStaticMarkup(<SaleSkeleton />)).window.document;
  assert.ok(sale.querySelector('[aria-busy="true"][data-shell-aside="wide"]'));
  assert.ok(sale.querySelector(".sale-head .sale-cover"));
  assert.equal(sale.querySelectorAll(".sale-raise .sale-tiles > span").length, 4);
  assert.ok(sale.querySelector(".sale-notice"));
  const portfolio = new JSDOM(renderToStaticMarkup(<RowSkeletons count={1} kind="presales" />)).window.document;
  const pending = portfolio.querySelector('[role="status"][aria-label="Loading your holdings"]');
  assert.equal(pending?.getAttribute("aria-busy"), "true");
  assert.equal(portfolio.querySelector("ol > li, button, a"), null);
});

test("a prelaunch allocation without indexed vesting does not promise a future schedule", () => {
  const detail = {
    ...base,
    team_vesting: null,
    terms: { ...base.terms!, supply: { ...base.terms!.supply, recipients: base.terms!.supply.recipients.map((recipient) => ({ ...recipient, vesting: null })) } },
  };
  const document = new JSDOM(renderToStaticMarkup(<SaleView detail={detail} nowMs={FIXTURE_NOW} viewerEntry={null} />)).window.document;
  assert.equal(document.querySelector('.sale-card .kv [role="status"]')?.textContent, "Team schedule not confirmed yet");
  assert.doesNotMatch(document.body.textContent ?? "", /Schedule set at trading launch|Set at launch/);
  assert.equal(document.querySelector('.vest-viz'), null);
});

test("unlock loading and failure come from the shared request; neither renders an empty chart", () => {
  const detail = { ...base, terms: null, team_vesting: null };
  for (const failed of [false, true]) {
    const queries = createTestQueryClient();
    const key = presaleDetailQuery(detail.presale.presale_id).queryKey;
    queries.setQueryData(key, detail);
    queries.getQueryCache().find({ queryKey: key })!.setState(failed
      ? { status: "error", fetchStatus: "idle", error: new Error("Network failed") }
      : { status: "success", fetchStatus: "fetching" });
    const document = new JSDOM(renderToStaticMarkup(withQueryClient(queries, <dl><TeamVestingRow detail={detail} /></dl>))).window.document;
    const status = document.querySelector('[role="alert"], [role="status"]')!;
    if (failed) assert.equal(status.textContent, "Couldn't load the team schedule.");
    else {
      assert.ok(status.querySelector('[aria-hidden="true"].text'), "pending schedule uses the shared skeleton");
      assert.doesNotMatch(status.textContent!, /Loading/);
    }
    assert.equal(document.querySelector(".vest-viz"), null);
    assert.equal(document.querySelector("button")?.textContent ?? null, failed ? "Try again" : null);
    queries.clear();
  }
});

test("missing USD data differs from a known zero in the main card", () => {
  for (const raised_usd of [null, "0"]) {
    const detail = { ...base, presale: { ...base.presale, raised_usd, target_usd: null } };
    const document = new JSDOM(renderToStaticMarkup(<SaleView detail={detail} nowMs={FIXTURE_NOW} viewerEntry={null} />)).window.document;
    const figure = document.querySelector(".sale-raise .sale-raised");
    assert.equal(figure?.querySelector("b")?.textContent, raised_usd === null ? "Unavailable" : "0 USDC");
    assert.equal(figure?.querySelector("span.num")?.textContent, "of Unavailable");
  }
});
