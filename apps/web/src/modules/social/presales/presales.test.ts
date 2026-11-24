import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import { socialPresaleListPath, type SocialPresaleSummary } from "@blast/core/modules/social/contracts/presales.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { PresaleTerms } from "@blast/core/modules/presale/terms/index.ts";
import { teamVestingOf, termsOf } from "@blast/server/modules/social/presales/detail.ts";
import { parsePresaleListQuery, presaleIdParameter } from "@blast/server/modules/social/presales/route.ts";
import { decimalRatio, decodeListCursor, encodeListCursor, ratioBps, summaryOf, trustFilterSql, type SummaryRow } from "@blast/server/modules/social/presales/summary.ts";
import { readViewerPresales } from "@blast/server/modules/social/presales/viewer.ts";

const ID = `0x${"a".repeat(64)}`;

test("partner filter accepts one canonical on-chain ID and preserves it in page URLs", () => {
  const path = socialPresaleListPath({ status: "ended", partnerId: ID, trust: ["audited"], limit: 1 });
  const parsed = parsePresaleListQuery(new URL(path, "https://blast.fun"));
  assert.equal(parsed.partnerId, ID);
  assert.deepEqual(parsed.trust, ["audited"]);
  assert.equal(parsed.status, "ended");
  assert.equal(parsePresaleListQuery(new URL("https://blast.fun/api/social/presales")).partnerId, undefined);
  assert.notEqual(path, socialPresaleListPath({ status: "ended", limit: 1 }));
  assert.notEqual(path, socialPresaleListPath({ status: "ended", partnerId: `0x${"b".repeat(64)}`, trust: ["audited"], limit: 1 }));
  for (const value of ["", "acme", "0x1", `0x${"A".repeat(64)}`, `${ID}&partner_id=${ID}`, "' OR true--"]) {
    assert.throws(() => parsePresaleListQuery(new URL(`https://blast.fun/api/social/presales?partner_id=${value}`)),
      (error: unknown) => error instanceof SocialRouteError && error.code === "invalid_parameter");
  }
});

test("UI-09: fills and multiples come from exact atoms, never floats past the display", () => {
  assert.equal(ratioBps("184221000000", "250000000000"), 7368);
  assert.equal(ratioBps("398600000000", "400000000000"), 9965);
  assert.equal(ratioBps("1", "0"), 0);
  assert.equal(ratioBps("311400000000", "250000000000"), 12456);
  assert.equal(decimalRatio("0.0021", "0.0005"), "4.2");
  assert.equal(decimalRatio(null, "1"), null);
  assert.equal(decimalRatio("0", "1"), null);
});

test("UI-09: list cursors round-trip and anything else is invalid_parameter (cursor)", () => {
  const cursor = encodeListCursor({ key: "-1", presaleId: ID });
  assert.deepEqual(decodeListCursor(cursor), { key: "-1", presaleId: ID });
  for (const raw of ["nope", encodeListCursor({ key: "1e5", presaleId: ID }), Buffer.from(JSON.stringify(["1", "0x1"])).toString("base64url"), "x".repeat(500)]) {
    assert.throws(() => decodeListCursor(raw), (error: unknown) => error instanceof SocialRouteError && error.code === "invalid_parameter");
  }
});

test("UI-09: the list query defaults to Live, Pinned first, 20 and refuses another tab's sort", () => {
  const parse = (query: string) => parsePresaleListQuery(new URL(`https://blast.fun/api/social/presales${query}`));
  assert.deepEqual(parse(""), { status: "live", sort: "pinned", cursor: null, limit: 20 });
  assert.equal(parse("?sort=ending").sort, "ending");
  assert.deepEqual(parse("?status=upcoming"), { status: "upcoming", sort: "opening", cursor: null, limit: 20 });
  assert.deepEqual(parse("?status=ended&sort=best&limit=50&cursor=abc"), { status: "ended", sort: "best", cursor: "abc", limit: 50 });
  for (const query of ["?status=x", "?sort=opening", "?limit=0", "?limit=51", "?limit=1.5", "?sort=a&sort=b"]) {
    assert.throws(() => parse(query), (error: unknown) => error instanceof SocialRouteError && error.code === "invalid_parameter");
  }
  assert.equal(presaleIdParameter(new Request(`https://blast.fun/api/social/presales/${ID}`)), ID);
  assert.throws(() => presaleIdParameter(new Request("https://blast.fun/api/social/presales/0xABC")));
});

test("UI-10: every presale-page statement reads chain data through chain_read_v1 views only", async () => {
  const statements: string[] = [];
  const db = { read: async (text: string) => { assertChainReadThroughViews(text); statements.push(text); return { rows: [] } as never; } };
  await readViewerPresales(db, "00000000-0000-4000-8000-000000000001", [ID], [ID]);
  assert.equal(statements.length, 2);
  assert.ok(statements.every((text) => !/\b(?:FROM|JOIN)\s+(?:public\.)?(?:positions|balances|trades|coins|pools)\b/i.test(text)));
});

test("R3-29-AC-3: the published presale schemas require `interested` as a non-negative integer", () => {
  const validator = createSocialValidator();
  const row: SocialPresaleSummary = {
    presale_id: ID, name: "Sable", symbol: "SABL", icon_url: "https://cdn.blast.fun/sabl.png", phase: "pending", venue: "cetus",
    start_ms: 1_791_914_400_000, end_ms: 1_792_173_600_000, ended_ms: null, launched_ms: null, target_usd: "400000.00", raised_usd: "0.00",
    quote_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", quote_symbol: "USDC", quote_decimals: 6, target_atoms: "400000000000", raised_atoms: "0",
    fill_bps: 0, participants: 0, interested: 4_020, presale_price_usd: null, presale_price_quote: null, price_usd: null, multiple: null,
    verified_team: false, audited: false, metadata: null,
  };
  assert.deepEqual(validator.validate("presale-summary", row).errors, []);
  assert.deepEqual(validator.validate("presale-summary", { ...row, interested: 0 }).errors, []);
  const missing = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "interested"));
  const bad: Record<string, unknown> = { missing, null: { ...row, interested: null }, negative: { ...row, interested: -1 }, fraction: { ...row, interested: 1.5 }, text: { ...row, interested: "3" } };
  for (const [label, value] of Object.entries(bad)) assert.equal(validator.validate("presale-summary", value).valid, false, label);
  // The list page, the watchlist page and the viewer's rows embed this one row schema; the sale page repeats the field.
  const page = { presales: [row], next_cursor: null, as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 } };
  assert.deepEqual(validator.validate("presale-list-page", page).errors, []);
  assert.equal(validator.validate("presale-list-page", { ...page, presales: [missing] }).valid, false);
});

test("R3-29: every phase passes the row's follow count through unchanged, 0 included", () => {
  const base: SummaryRow = {
    presale_id: ID, name: "Sable", symbol: "SABL", icon_url: "https://cdn.blast.fun/sabl.png", lifecycle: "pending", start_ms: "100", end_ms: "200",
    venue: "cetus", participants: "0", sale_token: `${ID}::sabl::SABL`, sale_decimals: 9, quote_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", quote_symbol: "USDC", raise_target: "1", total_commitments: "0",
    quote_decimals: 6, stable: true, target_usd: "1.00", raised_usd: "0.00", allowlisted: false, min_commitment_usd: null, wallet_cap_usd: null,
    min_commitment_atoms: null, wallet_cap_atoms: null,
    opened_ms: null, funded_ms: null, migrated_ms: null, cancelled_ms: null, interested: 0, claimed_price_usd: null, claimed_price_quote: null, price_usd: null,
    verified_team: false, audited: false, sort_key: null,
    tagline: null, site: null, x_handle: null, telegram: null, docs_url: null, audit_url: null, launch_at_ms: null,
    cover_key: null, cover_url: null, cover_width: null, cover_height: null, cover_source_width: null, cover_source_height: null,
  };
  for (const lifecycle of ["pending", "open", "funded", "migrated", "cancelled"]) {
    for (const interested of [0, 1, 4_020]) {
      assert.equal(summaryOf({ ...base, lifecycle, interested }, 150).interested, interested, `${lifecycle} ${interested}`);
    }
  }
});

test("R3-23: the list's trust filters are `verified_team=true` and `audited=true`, nothing else, and no LP-lock filter", () => {
  const parse = (query: string) => parsePresaleListQuery(new URL(`https://blast.fun/api/social/presales${query}`));
  assert.deepEqual(parse("?verified_team=true"), { status: "live", sort: "pinned", cursor: null, limit: 20, trust: ["verified_team"] });
  assert.deepEqual(parse("?status=ended&audited=true&verified_team=true").trust, ["verified_team", "audited"]);
  assert.equal(parse("?lp_locked=true").trust, undefined, "an unknown parameter is ignored, as every other one is: it filters nothing");
  for (const query of ["?verified_team=1", "?verified_team=false", "?audited=", "?audited=true&audited=true"]) {
    assert.throws(() => parse(query), (error: unknown) => error instanceof SocialRouteError && error.code === "invalid_parameter", query);
  }
  assert.equal(socialPresaleListPath({ status: "live", trust: ["audited", "verified_team"] }), "/api/social/presales?status=live&verified_team=true&audited=true");
  assert.equal(trustFilterSql(undefined), "");
  assert.equal(trustFilterSql([]), "");
  assert.equal(trustFilterSql(["verified_team"]), " AND EXISTS (SELECT 1 FROM social_sale_trust t WHERE t.presale_id = p.presale_id AND t.verified_team)");
  assert.equal(
    trustFilterSql(["verified_team", "audited", "audited"]),
    " AND EXISTS (SELECT 1 FROM social_sale_trust t WHERE t.presale_id = p.presale_id AND t.audited AND t.verified_team)",
  );
});

test("R3-23-AC-2: the published presale schemas require the two trust flags as booleans, nothing about who set them, and no LP-lock flag (OA-26)", () => {
  const validator = createSocialValidator();
  const row: SocialPresaleSummary = {
    presale_id: ID, name: "Sable", symbol: "SABL", icon_url: "https://cdn.blast.fun/sabl.png", phase: "pending", venue: "cetus",
    start_ms: 1_791_914_400_000, end_ms: 1_792_173_600_000, ended_ms: null, launched_ms: null, target_usd: "400000.00", raised_usd: "0.00",
    quote_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", quote_symbol: "USDC", quote_decimals: 6, target_atoms: "400000000000", raised_atoms: "0",
    fill_bps: 0, participants: 0, interested: 0, presale_price_usd: null, presale_price_quote: null, price_usd: null, multiple: null,
    verified_team: true, audited: false, metadata: null,
  };
  assert.deepEqual(validator.validate("presale-summary", row).errors, []);
  for (const flag of ["verified_team", "audited"] as const) {
    const missing = Object.fromEntries(Object.entries(row).filter(([key]) => key !== flag));
    assert.equal(validator.validate("presale-summary", missing).valid, false, `${flag} missing`);
    assert.equal(validator.validate("presale-summary", { ...row, [flag]: null }).valid, false, `${flag} null`);
    assert.equal(validator.validate("presale-summary", { ...row, [flag]: "true" }).valid, false, `${flag} text`);
  }
  // The operator's identity, time and note have no place in the closed schema, nor has a per-sale LP lock:
  // every migration pool's LP position is locked for good by the contracts (OA-26).
  for (const extra of ["note", "verified_by", "verified_at_ms", "audited_by", "audited_at_ms", "updated_at_ms", "lp_locked"]) {
    assert.equal(validator.validate("presale-summary", { ...row, [extra]: "x" }).valid, false, extra);
  }
});

test("R3-23: every phase passes the row's trust flags through, false when the sale has no row", () => {
  const base: SummaryRow = {
    presale_id: ID, name: "Sable", symbol: "SABL", icon_url: "https://cdn.blast.fun/sabl.png", lifecycle: "pending", start_ms: "100", end_ms: "200",
    venue: "cetus", participants: "0", sale_token: `${ID}::sabl::SABL`, sale_decimals: 9, quote_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", quote_symbol: "USDC", raise_target: "1", total_commitments: "0",
    quote_decimals: 6, stable: true, target_usd: "1.00", raised_usd: "0.00", allowlisted: false, min_commitment_usd: null, wallet_cap_usd: null,
    min_commitment_atoms: null, wallet_cap_atoms: null,
    opened_ms: null, funded_ms: null, migrated_ms: null, cancelled_ms: null, interested: 0, claimed_price_usd: null, claimed_price_quote: null, price_usd: null,
    verified_team: false, audited: false, sort_key: null,
    tagline: null, site: null, x_handle: null, telegram: null, docs_url: null, audit_url: null, launch_at_ms: null,
    cover_key: null, cover_url: null, cover_width: null, cover_height: null, cover_source_width: null, cover_source_height: null,
  };
  for (const lifecycle of ["pending", "open", "funded", "migrated", "cancelled"]) {
    const none = summaryOf({ ...base, lifecycle }, 150);
    assert.deepEqual([none.verified_team, none.audited], [false, false], lifecycle);
    assert.equal("lp_locked" in none, false, "no per-sale LP lock (OA-26)");
    const all = summaryOf({ ...base, lifecycle, verified_team: true, audited: true }, 150);
    assert.deepEqual([all.verified_team, all.audited], [true, true], lifecycle);
  }
});

test("the team unlock: only the token recipients' schedules, and nothing when the read cannot tell which are the team's", () => {
  const wallet = (tag: string) => `0x${tag.padStart(64, "0")}`;
  const [team, advisor, treasury, backer] = [wallet("7ea"), wallet("ad5"), wallet("7eb"), wallet("ba1")];
  const DAY = 86_400_000;
  const LAUNCH = Date.UTC(2026, 8, 19);
  const schedule = (beneficiary: string, cliffDays: number, days: number, share = "token") => ({
    share, asset: share === "raise" ? "quote" : "sale_token",
    beneficiary,
    start_ms: String(LAUNCH),
    cliff_end_ms: String(LAUNCH + cliffDays * DAY),
    end_ms: String(LAUNCH + days * DAY),
  });
  const share = (address: string, bps: number) => ({ address, bps, amount: String(bps) });
  const terms = (tokens: readonly string[], raise: readonly string[]): PresaleTerms => ({
    presaleId: ID,
    raiseTarget: "250000000000",
    supply: {
      total: "1000000000000000000",
      participants: { bps: 4_500, amount: "1" },
      liquidity: { bps: 3_000, amount: "1" },
      recipients: tokens.map((address) => share(address, 1_000)),
      protocol: { bps: 0, amount: "0" },
    },
    raise: { poolShare: "1", recipients: raise.map((address) => share(address, 2_300)), protocol: { bps: 200, amount: "1" } },
    eligibility: { kind: "open" },
    burnable: false,
    hardCap: false,
  });
  const teams = schedule(team, 90, 360);
  const span = { start_ms: LAUNCH, cliff_end_ms: LAUNCH + 90 * DAY, end_ms: LAUNCH + 360 * DAY };

  // The defect: a backer's own schedule (no cliff) and a raise recipient's (no cliff) no longer move the team's unlock.
  const withOthers = [schedule(backer, 0, 180, "participant"), teams, schedule(treasury, 0, 180, "raise")];
  assert.deepEqual(teamVestingOf(terms([team], [treasury]), withOthers), span);
  assert.notDeepEqual(teamVestingOf(terms([team], [treasury]), withOthers)?.cliff_end_ms, LAUNCH, "never the earliest cliff of every schedule");
  // Two token recipients on the same terms are one team unlock.
  assert.deepEqual(teamVestingOf(terms([team, advisor], [treasury]), [teams, schedule(advisor, 90, 360)]), span);

  // Nothing to say, rather than a guess:
  assert.equal(teamVestingOf(null, [teams]), null, "no terms, so no list names the team");
  assert.deepEqual(teamVestingOf(terms([team], [team]), [teams, schedule(team, 0, 180, "raise"), schedule(team, 0, 180, "participant")]), span, "share identity keeps buyer and quote schedules out of the team dates");
  assert.deepEqual(teamVestingOf(terms([team], [team]), [teams]), span, "the token share remains identifiable when the recipient also receives quote tokens");
  assert.equal(teamVestingOf(terms([team, advisor], [treasury]), [teams, schedule(advisor, 30, 180)]), null, "an advisor's share unlocks earlier, and the chain names no role");
  assert.equal(teamVestingOf(terms([team], [treasury]), [schedule(backer, 0, 180)]), null, "no token recipient has a schedule");
  assert.equal(teamVestingOf(terms([], [treasury]), [schedule(treasury, 0, 180)]), null, "no token recipient at all");
});

test("R3-90-AC-2: the sale page's terms pass the coin's `burnable` and the hard cap through, null when unread, and the schema requires both", () => {
  const terms = (burnable: boolean | null, hardCap: boolean | null): PresaleTerms => ({
    presaleId: ID,
    raiseTarget: "250000000000",
    supply: {
      total: "1000000000000000000",
      participants: { bps: 4_500, amount: "450000000000000000" },
      liquidity: { bps: 3_000, amount: "300000000000000000" },
      recipients: [],
      protocol: { bps: 0, amount: "0" },
    },
    raise: { poolShare: "187500000000", recipients: [], protocol: { bps: 200, amount: "5000000000" } },
    eligibility: { kind: "open" },
    burnable,
    hardCap,
  });
  const row = { target_usd: "250000.00", raise_target: "250000000000", quote_decimals: 6, sale_decimals: 9 } as unknown as SummaryRow;
  for (const burnable of [true, false, null]) {
    for (const hardCap of [true, false, null]) {
      const read = termsOf(terms(burnable, hardCap), row, []);
      assert.equal(read.burnable, burnable);
      assert.equal(read.hard_cap, hardCap);
    }
  }
  const schema = JSON.parse(readFileSync(new URL("../../../../../../packages/core/src/modules/social/contracts/schemas/presale-detail.schema.json", import.meta.url), "utf8"));
  const shape = schema.properties.terms.oneOf.find((part: { type?: string }) => part.type === "object");
  for (const field of ["burnable", "hard_cap"]) {
    assert.ok(shape.required.includes(field), `${field} is required`);
    assert.deepEqual(shape.properties[field].type, ["boolean", "null"], `${field} is a boolean or null`);
  }
});
