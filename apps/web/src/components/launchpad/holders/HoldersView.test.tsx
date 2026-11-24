import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { COIN_FIXTURE } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { holderSnapshotBody, type HolderFixtureState } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/holder-fixtures.ts";
import { parseHoldersSnapshotPage } from "@blast/core/modules/launchpad-contract/holders.ts";
import { parseInfraProvenance } from "@blast/core/modules/launchpad-contract/provenance.ts";

import { afterMore, afterRefresh, INITIAL_HOLDERS, type HoldersOutcome, type HoldersState } from "./holders-model";
import { WalletTradesProvider } from "../activity/wallet-trades";
import { HoldersView } from "./HoldersView";

const NOW = 1_790_235_061_630;

/** The fixture engine's answer for `state` as an outcome, the page after `cursor`. */
function outcome(state: HolderFixtureState, cursor: string | null = null, lagMs?: number): HoldersOutcome {
  const body = holderSnapshotBody(state, { cursor }, NOW, lagMs);
  const page = parseHoldersSnapshotPage(COIN_FIXTURE.launchId, COIN_FIXTURE.coinType, body);
  const provenance = parseInfraProvenance(body.provenance);
  if (page.facts === null) return { kind: "incomplete", snapshot: page.snapshot, provenance };
  return { kind: "facts", snapshot: page.snapshot, facts: page.facts, provenance, lagging: lagMs !== undefined && lagMs > 30_000 };
}

function render(state: HoldersState, pending: "refresh" | "more" | null = null) {
  return renderToStaticMarkup(
    <HoldersView state={state} symbol="FROGGY" decimals={6} pending={pending} onRefresh={() => {}} onMore={() => {}} onShowNewer={() => {}} />,
  );
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

const complete = afterRefresh(INITIAL_HOLDERS, outcome("complete"));

test("a complete list shows count, concentration and the wallet-held denominator", () => {
  const html = render(complete);
  const words = text(html);
  assert.doesNotMatch(words, /checkpoint|326,274,009/i);
  assert.match(words, /Holders 30 /);
  assert.match(words, /Held in wallets 567,000\.2 FROGGY/);
  assert.match(words, /Largest holder 21\.16% \(120,000 FROGGY\)/);
  assert.match(words, /Top 10 holders 61\.55% \(349,000\.06 FROGGY\)/);
  assert.match(words, /Share of coins held in wallets. Excludes burned coins and coins held inside on-chain objects/);
  assert.match(words, /Showing 25 of 30 holders/);
  assert.equal(html.match(/<tbody>.*<\/tbody>/s)?.[0].match(/<tr>/g)?.length, 25);
  assert.match(html, /<th scope="col"[^>]*>Share of wallet-held coins<\/th>/);
  assert.match(words, /Load more holders/);
  assert.doesNotMatch(words, /Source Network Sui localnet/);
  assert.doesNotMatch(words, /Stale|Unavailable/);
});

test("a creator holding the coin receives no label without a launch-wallet match", () => {
  const html = render(complete);
  assert.ok(html.includes(COIN_FIXTURE.creator), "the creator holds, shown by address");
  assert.doesNotMatch(text(html), /creator|whale|top.trader|label/i);
});

test("an incomplete snapshot is Unavailable with its checkpoint, never a count or zero", () => {
  const words = text(render(afterRefresh(complete, outcome("incomplete"))));
  assert.match(words, /Unavailable/);
  assert.match(words, /Holder balances are incomplete/);
  assert.doesNotMatch(words, /Holders \d|Held in wallets|Largest holder|of held supply \(/);
  assert.doesNotMatch(words, /Source Network Sui localnet/);
});

test("a genuine zero is a complete count of 0, not missing data", () => {
  const words = text(render(afterRefresh(INITIAL_HOLDERS, outcome("zero"))));
  assert.doesNotMatch(words, /checkpoint|326,274,009/i);
  assert.match(words, /Holders 0 /);
  assert.match(words, /No wallets hold FROGGY/);
  assert.doesNotMatch(words, /Unavailable|Stale|Largest holder|NaN/);
});

test("a behind snapshot or a lagging engine shows its facts under a Stale label with the cause", () => {
  const behind = text(render(afterRefresh(INITIAL_HOLDERS, outcome("behind"))));
  assert.match(behind, /Delayed/);
  assert.match(behind, /Holders may be out of date/);
  assert.doesNotMatch(behind, /checkpoint|blast-infra/);
  assert.match(behind, /Holders 30 /);

  const lagging = text(render(afterRefresh(INITIAL_HOLDERS, outcome("complete", null, 45_000))));
  assert.match(lagging, /Delayed/);
  assert.match(lagging, /Holders may be out of date/);
  assert.doesNotMatch(lagging, /Lag 45 s behind/);
});

test("an outage shows the last successful facts as Stale with their provenance, or Unavailable without them", () => {
  const kept = text(render(afterRefresh(complete, { kind: "failed", reason: "unreachable" })));
  assert.match(kept, /Delayed Holders may be out of date/);
  assert.match(kept, /Holders 30 /);
  assert.doesNotMatch(kept, /Checkpoint|326,274,009|blast-infra/);

  const none = text(render(afterRefresh(INITIAL_HOLDERS, { kind: "failed", reason: "not_ready" })));
  assert.match(none, /Unavailable Holders couldn’t load/);
  assert.doesNotMatch(none, /Holders \d|Held in wallets/);

  assert.match(text(render(INITIAL_HOLDERS)), /Loading Loading holders/);
});

test("later pages say which checkpoints their rows were read at; a newer snapshot is offered, not forced", () => {
  const first = outcome("complete");
  const cursor = first.kind === "facts" ? (first.facts.nextCursor as string) : "";
  const second = outcome("complete", cursor);
  const later: HoldersOutcome = second.kind === "facts" ? { ...second, snapshot: { ...second.snapshot, checkpoint: 326_274_015 } } : second;
  const paged = afterMore(complete, cursor, later);
  const words = text(render(paged));
  assert.match(words, /Showing 30 of 30 holders/);
  assert.doesNotMatch(words, /checkpoint/i);
  assert.match(words, /Some balances may have changed while you were loading more holders/);
  assert.doesNotMatch(words, /Load more holders/);

  const newest: HoldersOutcome = first.kind === "facts" ? { ...first, snapshot: { ...first.snapshot, checkpoint: 326_274_020 } } : first;
  const offered = text(render(afterRefresh(paged, newest)));
  assert.match(offered, /Newer holder balances are available/);
  assert.match(offered, /Show latest/);

  assert.match(text(render(afterMore(complete, cursor, { kind: "failed", reason: "unreachable" }))), /More holders couldn’t load/);
  assert.match(render(complete, "more"), /aria-label="Loading more holders"/);
});

test("the compact list keeps its denominator and stale warning outside snapshot details", () => {
  const state = afterRefresh(complete, { kind: "failed", reason: "unreachable" });
  const html = renderToStaticMarkup(<HoldersView compact state={state} symbol="FROGGY" decimals={6} pending={null} onRefresh={() => {}} onMore={() => {}} onShowNewer={() => {}} />);
  assert.match(text(html), /Holder balances may be out of date/);
  assert.match(text(html), /Share of coins held in wallets. Excludes burned coins and coins held inside on-chain objects/);
  assert.match(text(html), /View all holders/);
  assert.equal((html.match(/<li>/g) ?? []).length, 4);
  assert.doesNotMatch(text(html), /Complete native balances at checkpoint|Held in wallets 567/);
});

test("only the launch wallet carries the deployer icon among holders", () => {
  const html = renderToStaticMarkup(<WalletTradesProvider deployer={COIN_FIXTURE.creator}>
    <HoldersView state={complete} symbol="FROGGY" decimals={6} pending={null} onRefresh={() => {}} onMore={() => {}} onShowNewer={() => {}} />
  </WalletTradesProvider>);
  assert.equal(html.match(/data-wallet-label="deployer"/g)?.length, 1);
  assert.ok(html.includes(`Inspect full holder address: ${COIN_FIXTURE.creator}. Deployer.`));
});
