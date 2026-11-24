import assert from "node:assert/strict";
import { queryKeys } from "#web/lib/query/keys.ts";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { readFileSync } from "#web/test/css-design-px.ts";
import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";
import type { Competition } from "@blast/core/modules/social/competitions/contracts.ts";

import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";

import { CompetitionHero } from "./CompetitionHeader.tsx";
import { competitionStatus, competitionWhen } from "./competition-format.ts";
import { wholeUsd } from "./competition-volume.ts";

/**
 * The Competitions board: a competition's card (status and time chips, the
 * display-face name, its UTC schedule, the prize tile), the leaderboard's
 * whole-dollar volumes, and the geometry the board draws.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 27, 12);
const COMPETITION: Competition = {
  slug: "wal-volume-sprint",
  name: "WAL Volume Sprint",
  coin_type: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL",
  coin_symbol: "WAL",
  feature_on_swap: false,
  coin_icon_url: null,
  prize_description: "25,000 WAL",
  prize_amount: null,
  prize_coin_type: null,
  prize_coin_symbol: null,
  rules_url: "https://x.com/blast/status/1",
  starts_at_ms: NOW - DAY,
  ends_at_ms: NOW + 3 * DAY + 6 * 3_600_000,
  rules_version: 1,
};

const render = (node: Parameters<typeof withQueryClient>[1]) => renderToStaticMarkup(withQueryClient(createTestQueryClient(), node));
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("Competitions board: the status chip and the time chip follow the schedule", () => {
  assert.equal(competitionStatus(COMPETITION, NOW), "Live");
  assert.equal(competitionWhen(COMPETITION, NOW), "Ends in 3d 6h");
  assert.equal(competitionStatus(COMPETITION, NOW - 2 * DAY), "Scheduled");
  assert.equal(competitionWhen(COMPETITION, NOW - 2 * DAY), "Starts in 1d 0h");
  assert.equal(competitionStatus(COMPETITION, NOW + 5 * DAY), "Ended");
  assert.equal(competitionWhen(COMPETITION, NOW + 5 * DAY), "Ended 30 Oct");
});

test("Competitions board: the directory's card is one link with the chips, the name, the schedule and the prize tile", () => {
  const html = render(<CompetitionHero competition={COMPETITION} href="/competitions/wal-volume-sprint" nowMs={NOW} />);
  assert.match(html, /^<a class="card hero heroLink" href="\/competitions\/wal-volume-sprint">/);
  assert.match(html, /<span class="chip" data-live="true">Live<\/span><span class="chip">Ends in 3d 6h<\/span><\/span><h2 class="heroName">WAL Volume Sprint<\/h2>/);
  assert.match(words(html), /26 Oct ’26 → to 30 Oct ’26/);
  assert.match(html, /<span class="stat"><span>Prize pool<\/span><b>25,000 WAL<\/b><\/span>/);
  // Nothing interactive inside the link: the coin and the rules wait for the competition's own page.
  assert.doesNotMatch(html, /<button|Announcement/);
  // A visitor has no rank, and the directory carries no traders count: neither tile is drawn.
  assert.doesNotMatch(html, /Your rank|Traders/);
});

test("Competitions board: on its own page the card names the page's competition, its coin and the rules", () => {
  const html = render(<CompetitionHero competition={COMPETITION} nowMs={NOW} />);
  assert.match(html, /<section aria-labelledby="competition-title" class="card hero">/);
  assert.match(html, /<h2 class="heroName" id="competition-title">WAL Volume Sprint<\/h2>/);
  assert.match(html, /aria-label="Inspect full coin type"|coin type/);
  assert.match(html, /Announcement &amp; rules/);
  const plain = render(<CompetitionHero competition={{ ...COMPETITION, prize_description: null, rules_url: null }} nowMs={NOW} />);
  assert.doesNotMatch(plain, /class="stats"|Announcement/);
});

test("Competitions board: the Traders tile counts the board's members beside the prize pool, from the board or the viewer's rank read", () => {
  const tiles = (html: string) => [...html.matchAll(/<span class="stat"><span>([^<]+)<\/span><b[^>]*>([^<]+)<\/b><\/span>/g)].map(([, label, value]) => `${label} ${value}`);
  // The competition's own page: the board read's `members_total`.
  assert.deepEqual(tiles(render(<CompetitionHero competition={COMPETITION} membersTotal={1_284} nowMs={NOW} />)), ["Prize pool 25,000 WAL", "Traders 1,284"]);
  assert.deepEqual(tiles(render(<CompetitionHero competition={COMPETITION} membersTotal={1_284} nowMs={NOW + 5 * DAY} />)), ["Prize pool 25,000 WAL", "Traders 1,284"], "an ended board keeps its count");
  assert.deepEqual(tiles(render(<CompetitionHero competition={{ ...COMPETITION, prize_description: null, rules_url: null }} membersTotal={0} nowMs={NOW} />)), ["Traders 0"]);
  // Before the start nobody is counted yet, and an answer without the count draws no tile.
  assert.deepEqual(tiles(render(<CompetitionHero competition={COMPETITION} membersTotal={0} nowMs={NOW - 2 * DAY} />)), ["Prize pool 25,000 WAL"]);
  assert.deepEqual(tiles(render(<CompetitionHero competition={COMPETITION} membersTotal={undefined} nowMs={NOW} />)), ["Prize pool 25,000 WAL"]);
  // The directory's card for a signed-in viewer: the rank read's count, then the viewer's rank.
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.me.competitionRank(COMPETITION.slug, "kai_9"), { competition: COMPETITION, member: { rank: 37 }, members_total: 1_284, as_of_ms: NOW, usd_basis: "input_value_at_submission" });
  const signedIn = renderToStaticMarkup(withQueryClient(client,
    <SocialViewerProvider callsign="kai_9" getAccessToken={async () => "token"} signedIn>
      <CompetitionHero competition={COMPETITION} href="/competitions/wal-volume-sprint" nowMs={NOW} />
    </SocialViewerProvider>,
  ));
  assert.deepEqual(tiles(signedIn), ["Prize pool 25,000 WAL", "Traders 1,284", "Your rank #37"]);
});

test("Competitions board: volumes read in whole dollars and a nonzero volume never reads $0", () => {
  assert.equal(wholeUsd("1284120.55"), "$1,284,120");
  assert.equal(wholeUsd("48210"), "$48,210");
  assert.equal(wholeUsd("0.40"), "<$1");
  assert.equal(wholeUsd("0.00"), "$0");
});

test("Competitions board: the card, tiles and leaderboard rows keep the board's geometry", () => {
  const css = readFileSync(new URL("./CompetitionScreen.module.css", import.meta.url), "utf8");
  assert.match(css, /\.screen \.hero \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;[^}]*gap: 24px;[^}]*padding: 24px;[^}]*border-radius: 24px;[^}]*background: linear-gradient\(120deg, var\(--info-soft\), transparent 55%\), var\(--card\);/);
  assert.match(css, /\.heroName \{[^}]*font-family: var\(--display\);[^}]*font-size: 30px;[^}]*font-weight: 650;[^}]*letter-spacing: -\.035em;/);
  assert.match(css, /\.stat \{[^}]*padding: 12px 16px; border-radius: var\(--r-sm\);/);
  assert.match(css, /\.screen \.board \{ margin-top: 20px; padding: 16px 10px 10px; border-radius: 24px; \}/);
  assert.match(css, /\.row \{[^}]*grid-template-columns: 40px 36px minmax\(0, 1fr\) auto auto;[^}]*gap: 12px;[^}]*min-height: 60px;[^}]*padding: 0 12px;/);
});
