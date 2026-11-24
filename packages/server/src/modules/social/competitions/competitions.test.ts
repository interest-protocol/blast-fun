import assert from "node:assert/strict";
import test from "node:test";
import { competitionInput } from "@blast/core/modules/social/competitions/config.ts";
import { competitionPage, competitionPeriod } from "./route.ts";
const config = {
  slug: "sui-week-one",
  name: "SUI week",
  coin_type: "0x2::sui::SUI",
  coin_symbol: "SUI",
  starts_at_ms: 1000,
  ends_at_ms: 2000,
};
test("competition config canonicalizes coin types and refuses ambiguous rules", () => {
  assert.equal(competitionInput.parse(config).coin_type, `0x${"2".padStart(64, "0")}::sui::SUI`);
  for (const change of [
    { ends_at_ms: 1000 },
    { starts_at_ms: -1 },
    { ends_at_ms: Number.MAX_SAFE_INTEGER },
    { slug: "../bad" },
    { coin_type: "invalid" },
    { scoring: "anything" },
    { rules_url: "javascript:alert(1)" },
    { rules_url: "https://example.com/rules" },
    { prize_description: "Top three win" },
    { coin_icon_url: "javascript:alert(1)" },
    { coin_icon_url: "https://user:password@example.com/icon.png" },
  ]) {
    assert.equal(competitionInput.safeParse({ ...config, ...change }).success, false);
  }
});
test("coin art is optional and supports any coin's HTTPS artwork", () => {
  assert.equal(competitionInput.parse(config).feature_on_swap, false);
  assert.equal(competitionInput.parse({ ...config, feature_on_swap: true }).feature_on_swap, true);
  assert.equal(competitionInput.safeParse({ ...config, feature_on_swap: "true" }).success, false);
  assert.equal(competitionInput.parse(config).coin_icon_url, null);
  assert.equal(
    competitionInput.parse({
      ...config,
      coin_icon_url: "https://example.com/coin.png",
    }).coin_icon_url,
    "https://example.com/coin.png",
  );
});

test("archive period defaults to current and validates repeated or unknown values", () => {
  assert.equal(competitionPeriod(new URLSearchParams()), "current");
  assert.equal(competitionPeriod(new URLSearchParams("period=past")), "past");
  for (const value of ["period=all", "period=", "period=past&period=current"]) {
    assert.throws(() => competitionPeriod(new URLSearchParams(value)));
  }
});

test("pagination is bounded and rejects repeated or malformed parameters", () => {
  assert.equal(competitionPage(new URLSearchParams()), 1);
  assert.equal(competitionPage(new URLSearchParams("page=2")), 2);
  for (const value of [
    "page=0",
    "page=-1",
    "page=1.5",
    "page=100000",
    "page=1&page=2",
    "page=abc",
  ]) {
    assert.throws(() => competitionPage(new URLSearchParams(value)));
  }
});

test("optional organizer prize details require a safe X rules link", () => {
  const input = competitionInput.parse({
    ...config,
    prize_description: "Top three share the prize pool",
    rules_url: "https://x.com/example/status/123",
  });
  assert.equal(input.prize_description, "Top three share the prize pool");
  assert.equal(competitionInput.parse(config).prize_description, null);
});

test("parity: a structured prize is whole coins of a named coin, set together, behind the rules link", () => {
  const rules = { rules_url: "https://x.com/example/status/123" };
  const prize = { prize_amount: "25000", prize_coin_type: "0x2::sui::SUI", prize_coin_symbol: "SUI" };
  const input = competitionInput.parse({ ...config, ...rules, ...prize });
  assert.deepEqual([input.prize_amount, input.prize_coin_type, input.prize_coin_symbol], ["25000", `0x${"2".padStart(64, "0")}::sui::SUI`, "SUI"]);
  assert.equal(competitionInput.parse({ ...config, ...rules, ...prize, prize_amount: "0.000000001" }).prize_amount, "0.000000001");
  assert.deepEqual([competitionInput.parse(config).prize_amount, competitionInput.parse(config).prize_coin_type], [null, null]);
  for (const broken of [
    { ...prize },
    { ...rules, ...prize, prize_amount: "0" },
    { ...rules, ...prize, prize_amount: "0.0" },
    { ...rules, ...prize, prize_amount: "-5" },
    { ...rules, ...prize, prize_amount: "1e3" },
    { ...rules, ...prize, prize_amount: "1.0000000001" },
    { ...rules, ...prize, prize_amount: "100000000000000000000" },
    { ...rules, ...prize, prize_amount: 25000 },
    { ...rules, prize_amount: "25000", prize_coin_symbol: "SUI" },
    { ...rules, prize_coin_type: "0x2::sui::SUI", prize_coin_symbol: "SUI" },
    { ...rules, ...prize, prize_coin_type: "not a coin" },
    { ...rules, ...prize, prize_coin_symbol: "" },
  ]) assert.throws(() => competitionInput.parse({ ...config, ...broken }), JSON.stringify(broken));
});
