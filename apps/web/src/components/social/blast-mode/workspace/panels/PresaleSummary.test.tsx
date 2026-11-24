import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PRESALE_PHASES } from "@blast/core/modules/social/contracts/presales.ts";
import { presaleDetail } from "../../../../../../test/fixtures/workspace/presale-fixtures.ts";
import { PresaleHero, PresaleSummary } from "./PresaleSummary";
import { fundedText, presaleStage, presaleStageLine } from "./presale-stage";

test("every indexed lifecycle has an honest summary action, including time boundaries", () => {
  const expected = [
    "View presale",
    "Join presale",
    "View outcome",
    "View position",
    "View trading",
    "View refund",
  ];
  for (const [index, phase] of PRESALE_PHASES.entries()) {
    const sale = presaleDetail(phase).presale;
    assert.equal(presaleStage(sale).action, expected[index]);
  }
  const sale = presaleDetail().presale;
  assert.equal(presaleStage(sale, sale.start_ms - 1).label, "Upcoming");
  assert.equal(presaleStage(sale, sale.start_ms).action, "Join presale");
  assert.equal(presaleStage(sale, sale.end_ms).action, "View outcome");
  assert.equal(
    presaleStage({ ...sale, phase: "funded" }, sale.end_ms + 1).label,
    "Funded",
  );
});

test("compact summary exposes exact financial values and does not mount a commitment form", () => {
  const detail = presaleDetail();
  const html = renderToStaticMarkup(<><PresaleHero detail={detail} /><PresaleSummary detail={detail} now={Date.now()} /></>);
  assert.match(html, /\$123\.45/);
  assert.match(html, /123\.450001 USDC/);
  assert.match(html, /0\.000111111111111111 USDC per KSTL/);
  assert.match(html, /Funding progress/);
  assert.match(html, /UTC/);
  assert.doesNotMatch(html, /<input|<form|data-presale-submit/);
  // The default view is one quiet line, not tiles: price per token, then timing.
  const line = renderToStaticMarkup(<PresaleSummary detail={detail} now={Date.now()} />);
  assert.doesNotMatch(line, /<dl|<dt/);
  assert.match(line, /USDC per KSTL<\/button>/);
  assert.match(line, /closes (?:<span[^>]*>)*<button[^>]*aria-label="Inspect full closing time: /);
});

test("the stage line and ring state what is known without rounding a nonzero raise to zero", () => {
  const sale = presaleDetail().presale;
  const now = sale.end_ms - (4 * 3_600_000 + 12 * 60_000 + 30_000);
  assert.deepEqual(presaleStageLine(sale, now), { lead: "Presale", next: "closes in 4h 12m" });
  assert.deepEqual(presaleStageLine(sale, sale.start_ms - 2 * 86_400_000 - 6 * 3_600_000), { lead: "Upcoming", next: "opens in 2d 6h" });
  assert.deepEqual(presaleStageLine({ ...sale, phase: "pending", start_ms: 0 }, now), { lead: "Upcoming", next: "not open yet" });
  assert.equal(presaleStageLine(presaleDetail("trading").presale, now).next, null);
  assert.deepEqual([0, 5, 123, 9_999, 10_000, 15_049].map(fundedText), ["0%", "<1%", "1%", "99%", "100%", "150%"]);
});

test("the hero reads unknown funding as a dash, never zero, and names followed backers only when the viewer read says so", () => {
  const unknown = renderToStaticMarkup(<PresaleHero detail={null} />);
  assert.doesNotMatch(unknown, />0%</);
  assert.match(unknown, /—/);
  const detail = presaleDetail();
  assert.doesNotMatch(renderToStaticMarkup(<PresaleHero detail={detail} />), /you follow/);
  const person = { callsign: "mara", display_name: "Mara Lin", avatar_url: null, verified: true };
  const viewer = { following: [{ account: person, commitment_usd: "1", commitment_atoms: "1000000", last_commit_ms: 1, why: null, commits: [] }], following_total_usd: "1", following_total_atoms: "1000000", mine: null };
  const html = renderToStaticMarkup(<PresaleHero detail={detail} viewer={viewer} />);
  assert.match(html, /<b>1<\/b> backer · <b>1<\/b> you follow/);
});

test("list tabs fold the hero into one line: a bare ring, raised of target, and the backer count", () => {
  const detail = presaleDetail();
  const html = renderToStaticMarkup(<PresaleHero detail={detail} compact />);
  assert.match(html, /aria-label="Funding progress: /);
  assert.doesNotMatch(html, /funded</);
  assert.match(html, /\$123\.45/);
  assert.match(html, />of <b>/);
  assert.match(html, /<b>1<\/b> backer</);
  assert.doesNotMatch(renderToStaticMarkup(<PresaleHero detail={null} compact />), />0%</);
});
