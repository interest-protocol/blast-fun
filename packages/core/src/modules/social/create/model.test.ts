import assert from "node:assert/strict";
import test from "node:test";

import { CREATE_HASHI_BTC_QUOTE_TYPE, CREATE_WAL_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE, CREATE_QUOTE_TYPE, CREATE_QUOTES, CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE, type CreateAllowlistSummary, type CreateDraft } from "@blast/core/modules/social/contracts/create.ts";
import { blankDraft, CREATE_DEFAULT_FEE_POLICY, DraftShapeError, draftIssues, draftQuote, draftShort, draftTerms, nearestTierFee, niceRound, switchDraftQuote, parseDraft, pctText, reviewButtonLabel } from "@blast/core/modules/social/create/model.ts";
import { createIssues, presaleArgs, quoteAtoms, tokenAtoms, usdcAtoms, vestingTerms } from "@blast/core/modules/social/create/presale-args.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";

const fees = CREATE_DEFAULT_FEE_POLICY;
const context = { fees, allowlist: null } as const;
const addr = (tag: string) => `0x${tag.padStart(64, "0")}`;

/** The design's sample once its required fields are typed. */
function filled(): CreateDraft {
  const draft = blankDraft();
  return {
    ...draft,
    name: "Meridian",
    symbol: "MRDN",
    tagline: "Onchain FX for stablecoins on Sui",
    token_recipients: [
      { ...draft.token_recipients[0]!, address: addr("a1") },
      { ...draft.token_recipients[1]!, address: addr("a2") },
    ],
    raise_recipients: [{ ...draft.raise_recipients[0]!, address: addr("a1") }],
  };
}

const messages = (draft: CreateDraft, allowlist: CreateAllowlistSummary | null = null) =>
  draftIssues(draft, { fees, allowlist }).map((issue) => `${issue.section}:${issue.path}:${issue.message}`);

test("saved draft parser and published schema reject retired recipient names in both arrays", () => {
  const validator = createSocialValidator();
  for (const key of ["token_recipients", "raise_recipients"] as const) {
    const old = { label: "Team", address: "", bps: 0, vest: false, cliff_months: 3, months: 12 };
    for (const row of [old, { ...old, cliff: 3, duration: 12 }]) {
      const body = { ...blankDraft(), [key]: [row] };
      assert.throws(() => parseDraft(body), (error) => error instanceof DraftShapeError && error.field === `${key}.0`);
      assert.equal(validator.validate("create-draft", body).valid, false);
    }
  }
});

test("the blank draft is the design's crBlank: five things to fix, in the design's words", () => {
  assert.deepEqual(messages(blankDraft()), [
    "token:name:Add a name",
    "token:symbol:Add a ticker",
    "split:token_recipients.0.address:Add Team's Sui address",
    "split:token_recipients.1.address:Add Treasury's Sui address",
    "rsplit:raise_recipients.0.address:Add Team's Sui address",
  ]);
  assert.equal(reviewButtonLabel(5), "5 to fix before publishing");
  assert.equal(reviewButtonLabel(0), "Review and publish");
});

test("the filled sample has nothing to fix, and the contract preview agrees", () => {
  assert.deepEqual(messages(filled()), []);
  assert.deepEqual(createIssues(filled(), context), []);
});

test("existing coin identities block review and publish arguments for names and tickers", () => {
  const reserved = ["Blast", "Sui", "Walrus", "WAL", "USDC", "USD Coin", "USDT", "Tether", "USDSui", "Bitcoin", "BTC", "Ethereum", "ETH", "Solana", "SOL"];
  for (const identity of reserved) {
    for (const path of ["name", "symbol"] as const) {
      for (const value of [identity, ` ${identity.toUpperCase()} `, identity.toLowerCase(), identity.split("").join("\u200b"), identity.replace(/[A-Za-z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0))]) {
        const draft = { ...filled(), [path]: value };
        const label = path === "name" ? "name" : "ticker";
        const issue = { section: "token", path, message: `This ${label} is reserved for an existing coin. Choose another ${label}.` };
        assert.deepEqual(draftIssues(draft, context), [issue], `${path}: ${value}`);
        assert.deepEqual(createIssues(draft, context), [issue]);
        assert.throws(() => presaleArgs(draft, { ...context, creator: addr("c0"), logoUrl: null }), /draft has issues/);
      }
    }
  }
});

test("coin identity checks allow distinct names and tickers without substring blocking", () => {
  for (const name of ["Meridian", "Sui Cats", "Blaster", "Walrus Club", "Solarium"]) {
    assert.deepEqual(messages({ ...filled(), name }), []);
  }
  for (const symbol of ["MRDN", "SUICAT", "BLASTOFF", "WALLY", "SOLAR"]) {
    assert.deepEqual(messages({ ...filled(), symbol }), []);
  }
});

test("the preview's figures are the design's crTerms", () => {
  const terms = draftTerms(blankDraft(), fees);
  assert.equal(terms.buyersTokens, 450_000_000);
  assert.equal(terms.poolTokens, 300_000_000);
  assert.equal(terms.lpBps, 10_000 - 200 - 2_300);
  assert.ok(Math.abs(terms.price - 250_000 / 450_000_000) < 1e-15);
  assert.equal(terms.poolQuote, 250_000 * 0.75);
  assert.ok(Math.abs(terms.launch - 187_500 / 300_000_000) < 1e-15);
  assert.ok(Math.abs(terms.premium - 12.5) < 1e-9);
});

test("each check of the design, with its message", () => {
  const base = filled();
  assert.deepEqual(messages({ ...base, symbol: "M" }), ["token:symbol:Use 2 to 10 letters or digits"]);
  assert.deepEqual(messages({ ...base, supply: 0 }), ["token:supply:Set a supply"]);
  assert.deepEqual(messages({ ...base, target: 0 }), ["raise:target:Set a target"]);
  assert.deepEqual(messages({ ...base, min_commitment: 30_000 }), ["join:min_commitment:The minimum is above the limit per wallet"]);
  assert.deepEqual(messages({ ...base, max_wallets: 70_000 }), ["join:max_wallets:Allow 1 to 65,536 wallets"]);
  assert.deepEqual(messages({ ...base, max_wallets: 1_000 }), ["join:reach:At the minimum, 1,000 wallets raise only $10K"]);
  assert.deepEqual(messages({ ...base, eligibility: "allowlist" }), ["join:allowlist:Upload the allowlist"]);
  assert.deepEqual(messages({ ...base, buyers_bps: 4_000 }), ["split:split_total:The shares make 95%, not 100%"]);
  assert.deepEqual(messages({ ...base, holders_bps: 4_000 }), ["fees:fee_total:The shares make 90%, not 100%"]);
  assert.deepEqual(
    messages({ ...base, raise_recipients: [{ ...base.raise_recipients[0]!, bps: 9_800 }] }),
    ["rsplit:rsplit_total:Leave part of the raise for the pool"],
  );
  assert.deepEqual(
    messages({ ...base, token_recipients: [base.token_recipients[0]!, { ...base.token_recipients[1]!, address: addr("a1") }] }),
    ["split:token_recipients.1.address:Treasury repeats another address"],
  );
  assert.deepEqual(
    messages({ ...base, token_recipients: [{ ...base.token_recipients[0]!, address: "0x12" }, base.token_recipients[1]!] }),
    ["split:token_recipients.0.address:Team's address isn't a Sui address"],
  );
  assert.deepEqual(
    messages({ ...base, token_recipients: [{ ...base.token_recipients[0]!, cliff: 13 }, base.token_recipients[1]!] }),
    ["split:token_recipients.0.vest:The cliff is longer than the vesting"],
  );
  assert.deepEqual(
    messages({ ...base, lift: true, lift_access: "anyone", lift_max_wallets: 20_000 }),
    ["join:lift_max_wallets:Allow at least 30,000 wallets, as many as before"],
  );
  assert.deepEqual(
    messages({ ...base, lift: true, lift_access: "anyone", lift_max_wallets: 30_000, lift_min: 5 }),
    ["join:lift_reach:At the minimum, the open slots raise only $150K"],
  );
});

test("the contract's own limits the design leaves to the chain (OA-13)", () => {
  const base = filled();
  assert.deepEqual(messages({ ...base, supply: 20_000_000_000 }), ["token:supply:Use at most 18,446,744,073 tokens"]);
  assert.deepEqual(messages({ ...base, target: 20_000_000_000 }).slice(0, 1), ["raise:target:Use at most $10B"]);
  assert.deepEqual(
    messages({ ...base, token_recipients: [{ ...base.token_recipients[0]!, address: addr("0") }, base.token_recipients[1]!] }),
    ["split:token_recipients.0.address:Team's address can't be zero"],
  );
  assert.deepEqual(
    messages({ ...base, token_recipients: [{ ...base.token_recipients[0]!, duration: 121, cliff: 0 }, base.token_recipients[1]!] }),
    [],
  );
  assert.deepEqual(messages({ ...base, pool_fee: 40_000, venue: "bluefin" }), ["raise:pool_fee:Pick a fee Bluefin offers"]);
});

test("OA-14: the creator's own fee row at 0% is not an error and is left off the chain", () => {
  const draft = { ...filled(), holders_bps: 10_000, fee_recipients: [{ self: true, label: "You", address: "", bps: 0 }] };
  assert.deepEqual(messages(draft), []);
  const args = presaleArgs(draft, { fees, allowlist: null, creator: addr("c0"), logoUrl: null });
  assert.deepEqual(args.feeSplit.routes, [{ destination: { kind: "HolderRewards" }, bps: 10_000n }]);
  const paid = presaleArgs(filled(), { fees, allowlist: null, creator: addr("c0"), logoUrl: "https://x.example/l.webp" });
  assert.deepEqual(paid.feeSplit.routes, [{ destination: { kind: "Address", address: addr("c0") }, bps: 5_000n }, { destination: { kind: "HolderRewards" }, bps: 5_000n }]);
  const noHolders = { ...filled(), holders_bps: 0, fee_recipients: [{ self: true, label: "You", address: "", bps: 10_000 }] };
  assert.deepEqual(messages(noHolders), []);
  assert.deepEqual(presaleArgs(noHolders, { fees, allowlist: null, creator: addr("c0"), logoUrl: null }).feeSplit.routes, [{ destination: { kind: "Address", address: addr("c0") }, bps: 10_000n }]);
});

test("addresses typed with spaces or capitals reach the chain trimmed and in lowercase", () => {
  const typed = (tag: string) => ` ${addr(tag).toUpperCase()} `;
  const base = filled();
  const draft = {
    ...base,
    token_recipients: [{ ...base.token_recipients[0]!, address: typed("a1") }, base.token_recipients[1]!],
    raise_recipients: [{ ...base.raise_recipients[0]!, address: typed("a3") }],
    holders_bps: 4_000,
    fee_recipients: [...base.fee_recipients, { self: false, label: "Ops", address: typed("d1"), bps: 1_000 }],
  };
  assert.deepEqual(messages(draft), []);
  const args = presaleArgs(draft, { fees, allowlist: null, creator: addr("c0"), logoUrl: null });
  assert.equal(args.recipientAllocations[0]!.recipient.destination, addr("a1"));
  assert.equal(args.raiseAllocations[0]!.recipient.destination, addr("a3"));
  assert.deepEqual(args.feeSplit.routes, [
    { destination: { kind: "Address", address: addr("c0") }, bps: 5_000n },
    { destination: { kind: "Address", address: addr("d1") }, bps: 1_000n },
    { destination: { kind: "HolderRewards" }, bps: 4_000n },
  ]);
});

test("a final phase open only to eligible wallets carries no new slots or minimum", () => {
  const draft = { ...filled(), lift: true, lift_access: "eligible" as const };
  assert.deepEqual(messages(draft), []);
  assert.deepEqual(presaleArgs(draft, { fees, allowlist: null, creator: addr("c0"), logoUrl: null }).uncapped, {
    startsAfterMs: 3n * 86_400_000n - 6n * 3_600_000n,
    access: { kind: "eligible" },
  });
});

test("an allowlist read in the browser, before the server has its root, waits for it instead of showing a contract refusal", () => {
  const local = { allowlist_id: "00000000-0000-4000-8000-000000000001", root: "", leaf_count: 1_000, min_cap: 100, max_cap: 5_000, quote_type: CREATE_QUOTE_TYPE };
  const base = filled();
  // The chain refuses this draft: a fee row repeats the publishing wallet.
  const draft = { ...base, eligibility: "allowlist" as const, allowlist_id: local.allowlist_id, holders_bps: 4_000, fee_recipients: [...base.fee_recipients, { self: false, label: "Ops", address: addr("c0"), bps: 1_000 }] };
  assert.deepEqual(draftIssues(draft, { fees, allowlist: local }), []);
  assert.deepEqual(createIssues(draft, { fees, allowlist: local, creator: addr("c0") }), []);
  assert.deepEqual(createIssues(draft, { fees, allowlist: { ...local, root: "ab".repeat(32) }, creator: addr("c0") }), [
    { section: "fees", path: "fee_total", message: "Each fee share needs its own wallet" },
  ]);
});

test("an allowlist draft with an open-to-anyone phase counts only the slots beyond the list", () => {
  const allowlist = { allowlist_id: "00000000-0000-4000-8000-000000000001", root: "ab".repeat(32), leaf_count: 1_000, min_cap: 100, max_cap: 5_000, quote_type: CREATE_QUOTE_TYPE };
  const draft = { ...filled(), eligibility: "allowlist" as const, allowlist_id: allowlist.allowlist_id, lift: true, lift_access: "anyone" as const, lift_max_wallets: 2_000, lift_min: 100 };
  assert.deepEqual(messages(draft, allowlist), ["join:lift_reach:At the minimum, the open slots raise only $100K"]);
  const reaching = { ...draft, lift_min: 250 };
  assert.deepEqual(messages(reaching, allowlist), []);
  const args = presaleArgs(reaching, { fees, allowlist, creator: addr("c0"), logoUrl: null });
  assert.deepEqual(args.eligibility, { kind: "allowlisted", root: allowlist.root, leafCount: 1_000n });
  assert.deepEqual(args.uncapped, {
    startsAfterMs: 3n * 86_400_000n - 6n * 3_600_000n,
    access: { kind: "anyone", maxParticipants: 2_000n, minCommitment: 250_000_000n },
  });
  assert.deepEqual(args.hardCap, { startsAfterMs: 3n * 86_400_000n - 6n * 3_600_000n, closesWhenFilled: false });
  const immediate = presaleArgs({ ...reaching, launch_when_filled: true }, { fees, allowlist, creator: addr("c0"), logoUrl: null });
  assert.deepEqual(immediate.hardCap, { startsAfterMs: 0n, closesWhenFilled: true });
  assert.deepEqual(immediate.eligibility, args.eligibility);
  assert.deepEqual(immediate.uncapped, args.uncapped);
  const cappedList = presaleArgs({ ...reaching, lift: false, launch_when_filled: true }, { fees, allowlist, creator: addr("c0"), logoUrl: null });
  assert.deepEqual(cappedList.eligibility, args.eligibility);
  assert.equal(cappedList.uncapped, null);
  assert.deepEqual(cappedList.hardCap, { startsAfterMs: 0n, closesWhenFilled: true });
  assert.equal(presaleArgs({ ...reaching, lift_hard_cap: false }, { fees, allowlist, creator: addr("c0"), logoUrl: null }).hardCap, null);
});

test("immediate launch caps the raise from the start without lifting wallet limits", () => {
  const draft = { ...filled(), launch_when_filled: true, lift_hard_cap: false };
  const args = presaleArgs(draft, { ...context, creator: addr("c0"), logoUrl: null });
  assert.deepEqual(args.hardCap, { startsAfterMs: 0n, closesWhenFilled: true });
  assert.equal(args.uncapped, null);
  assert.deepEqual(args.eligibility, { kind: "open", walletCap: 25_000_000_000n, maxParticipants: 30_000n, minCommitment: 10_000_000n });
  assert.deepEqual(createIssues(draft, context), []);
});

test("launch timing survives a save and rejects invalid values; older drafts wait for their scheduled end", () => {
  const validator = createSocialValidator();
  for (const launch_when_filled of [true, false]) {
    const draft = { ...filled(), launch_when_filled };
    const wire = JSON.stringify(draft);
    const saved = JSON.parse(wire);
    assert.deepEqual(parseDraft(saved), draft);
    assert.equal(validator.validate("create-draft", saved).valid, true);
  }
  const older = Object.fromEntries(Object.entries(filled()).filter(([key]) => key !== "launch_when_filled"));
  assert.equal(parseDraft(older).launch_when_filled, false);
  assert.equal(validator.validate("create-draft", older).valid, true);
  for (const invalid of [null, "true", 1]) {
    const draft = { ...older, launch_when_filled: invalid };
    assert.throws(() => parseDraft(draft), (error: unknown) => error instanceof DraftShapeError && error.field === "launch_when_filled");
    assert.equal(validator.validate("create-draft", draft).valid, false);
  }
});

test("parity: a scheduled start opens the sale at its time; after the check time and within 90 days; absent or null opens on publish", () => {
  const validator = createSocialValidator();
  const now = Date.UTC(2026, 9, 28, 12);
  const at = now + 2 * 86_400_000;
  const scheduled = { ...filled(), start_ms: at };
  assert.deepEqual(draftIssues(scheduled, { ...context, nowMs: now }), []);
  assert.equal(presaleArgs(scheduled, { ...context, creator: addr("c0"), logoUrl: null, nowMs: now }).startMs, BigInt(at));
  assert.equal(presaleArgs(filled(), { ...context, creator: addr("c0"), logoUrl: null, nowMs: now }).startMs, 0n, "no start: opens at once");
  const issue = (start_ms: number) => draftIssues({ ...filled(), start_ms }, { ...context, nowMs: now }).map((one) => `${one.section}:${one.path}:${one.message}`);
  assert.deepEqual(issue(now), ["raise:start_ms:Pick a time from now on"]);
  assert.deepEqual(issue(now - 60_000), ["raise:start_ms:Pick a time from now on"]);
  assert.deepEqual(issue(now + 90 * 86_400_000), []);
  assert.deepEqual(issue(now + 90 * 86_400_000 + 1), ["raise:start_ms:Open within 90 days"]);
  // Publishing checks the start against its own clock: one that passed while the draft waited refuses.
  assert.throws(() => presaleArgs({ ...filled(), start_ms: now }, { ...context, creator: addr("c0"), logoUrl: null, nowMs: now }), /draft has issues/);
  // Without a check time (a page's own preview) the start is not judged; the server always passes one.
  assert.deepEqual(draftIssues({ ...filled(), start_ms: 1 }, context), []);
  // Saved and read back; an older draft has none; a wrong shape is refused by the parser and the schema.
  assert.deepEqual(parseDraft(structuredClone(scheduled)), scheduled);
  assert.equal(validator.validate("create-draft", scheduled).valid, true);
  assert.equal(parseDraft(filled()).start_ms, null);
  const older = Object.fromEntries(Object.entries(filled()).filter(([key]) => key !== "start_ms"));
  assert.equal(parseDraft(older).start_ms, null);
  assert.equal(validator.validate("create-draft", older).valid, true);
  // Null, not 0, opens on publish: 0 is no time.
  for (const invalid of ["1793000000000", 1.5, -1, 0, 8_640_000_000_000_001]) {
    const draft = { ...filled(), start_ms: invalid };
    assert.throws(() => parseDraft(draft), (error: unknown) => error instanceof DraftShapeError && error.field === "start_ms");
    assert.equal(validator.validate("create-draft", draft).valid, false, String(invalid));
  }
});

test("the arguments are exact in the contract's units", () => {
  const args = presaleArgs(filled(), { fees, allowlist: null, creator: addr("c0"), logoUrl: null });
  assert.equal(args.tokenSupply, 1_000_000_000n * 1_000_000_000n);
  assert.equal(args.raiseTarget, 250_000_000_000n);
  assert.deepEqual(args.eligibility, { kind: "open", walletCap: 25_000_000_000n, maxParticipants: 30_000n, minCommitment: 10_000_000n });
  assert.equal(args.uncapped, null);
  assert.equal(args.hardCap, null, "no uncapped phase, no hard cap: as before, the sale may go over its target");
  assert.equal(args.participantVesting, null);
  assert.equal(args.durationMs, 3n * 86_400_000n);
  assert.equal(args.liquidityWindowMs, 7n * 86_400_000n);
  assert.deepEqual(args.recipientAllocations[0], { recipient: { destination: addr("a1"), vestingTerms: vestingTerms(3, 12) }, bps: 1_900n });
  assert.deepEqual(vestingTerms(3, 12), { cliffDelayMs: 90n * 86_400_000n, periodDurationMs: 86_400_000n, periods: 360n });
  assert.equal(args.recipientAllocations[1]!.recipient.vestingTerms, null);
  assert.deepEqual(args.raiseAllocations[0], { recipient: { destination: addr("a1"), vestingTerms: vestingTerms(0, 6) }, bps: 2_300n });
  assert.equal(args.tickSpacing, 200);
  assert.equal(args.poolFeeRate, 10_000n);
  assert.equal(usdcAtoms(0.07), 70_000n);
  assert.equal(usdcAtoms(9_999_999_999.99), 9_999_999_999_990_000n);
  assert.equal(tokenAtoms(18_446_744_073, 9), 18_446_744_073_000_000_000n);
  assert.deepEqual(args.coin, { name: "Meridian", symbol: "MRDN", description: "Onchain FX for stablecoins on Sui", iconUrl: "", decimals: 9 });
  const padded = { ...filled(), name: " Meridian ", tagline: " Onchain FX for stablecoins on Sui " };
  assert.deepEqual(messages(padded), []);
  assert.deepEqual(presaleArgs(padded, { fees, allowlist: null, creator: addr("c0"), logoUrl: "https://x.example/l.webp" }).coin, {
    name: "Meridian",
    symbol: "MRDN",
    description: "Onchain FX for stablecoins on Sui",
    iconUrl: "https://x.example/l.webp",
    decimals: 9,
  });
});

test("6 and 9 decimals convert whole supply to matching coin metadata and atoms", () => {
  for (const [decimals, atoms] of [[6, 1_000_000_000_000_000n], [9, 1_000_000_000_000_000_000n]] as const) {
    const draft = parseDraft({ ...filled(), decimals });
    assert.deepEqual(createIssues(draft, context), []);
    const args = presaleArgs(draft, { ...context, creator: addr("c0"), logoUrl: null });
    assert.equal(args.coin.decimals, decimals);
    assert.equal(args.tokenSupply, atoms);
  }
});

test("older drafts default to 9 decimals and unsupported precision is refused", () => {
  const { decimals: defaultDecimals, ...older } = blankDraft();
  assert.equal(defaultDecimals, 9);
  assert.equal(parseDraft(older).decimals, 9);
  for (const decimals of [0, 7, 18, 1.5]) {
    assert.throws(() => parseDraft({ ...older, decimals }), (error: unknown) => error instanceof DraftShapeError && error.field === "decimals");
    assert.ok(messages({ ...filled(), decimals }).includes("token:decimals:Choose 6 or 9 decimals"));
  }
});

test("each precision accepts the largest whole u64 supply and refuses overflow", () => {
  for (const [decimals, supply] of [[6, 18_446_744_073_709], [9, 18_446_744_073]] as const) {
    const draft = parseDraft({ ...filled(), decimals, supply });
    assert.deepEqual(createIssues(draft, context), []);
    assert.ok(tokenAtoms(supply, decimals) <= (1n << 64n) - 1n);
    assert.ok(messages({ ...draft, supply: supply + 1 }).some((message) => message.startsWith("token:supply:Use at most")));
  }
});

test("a contract refusal the form cannot see becomes an issue: a fee row repeating the publishing wallet", () => {
  const base = filled();
  const repeat = { ...base, holders_bps: 4_000, fee_recipients: [...base.fee_recipients, { self: false, label: "Ops", address: addr("c0"), bps: 1_000 }] };
  assert.deepEqual(draftIssues(repeat, context), []);
  assert.deepEqual(createIssues(repeat, { ...context, creator: addr("c0") }), [
    { section: "fees", path: "fee_total", message: "Each fee share needs its own wallet" },
  ]);
  assert.deepEqual(createIssues(repeat, { ...context, creator: addr("c1") }), []);
});

test("a saved draft is read strictly; unfinished values are kept", () => {
  const saved = JSON.stringify(blankDraft());
  assert.deepEqual(parseDraft(JSON.parse(saved)), blankDraft());
  const half = { ...blankDraft(), name: "Mer", supply: 0, buyers_bps: 15_000 };
  assert.deepEqual(parseDraft(half), half);
  const refuse = (value: unknown, field: string) =>
    assert.throws(() => parseDraft(value), (error: unknown) => error instanceof DraftShapeError && error.field === field);
  refuse({ ...blankDraft(), extra: 1 }, "draft");
  refuse({ ...blankDraft(), symbol: "mrdn" }, "symbol");
  refuse({ ...blankDraft(), target: 10.555 }, "target");
  refuse({ ...blankDraft(), days: 2 }, "days");
  refuse({ ...blankDraft(), name: "x".repeat(33) }, "name");
  refuse({ ...blankDraft(), fee_recipients: [] }, "fee_recipients");
  refuse({ ...blankDraft(), fee_recipients: [{ self: false, label: "", address: "", bps: 0 }] }, "fee_recipients.0.self");
  refuse({ ...blankDraft(), token_recipients: Array.from({ length: 65 }, () => blankDraft().token_recipients[1]) }, "token_recipients");
  refuse({ ...blankDraft(), allowlist_id: "nope" }, "allowlist_id");
  refuse({ ...blankDraft(), tagline: "a\u0000b" }, "tagline");
});

test("switching venue keeps the nearest fee the venue offers", () => {
  assert.equal(nearestTierFee("bluefin", 40_000), 20_000);
  assert.equal(nearestTierFee("cetus", 10_000), 10_000);
  assert.equal(pctText(1_900), "19%");
  assert.equal(pctText(1_234), "12.34%");
});

test("R3-25-AC-1 / AC-2: a draft's links and quote: optional on a save, a pasted handle kept bare, only USDC raised, wrong ones named", () => {
  const blank = blankDraft();
  assert.deepEqual([blank.site, blank.x_handle, blank.telegram, blank.docs_url, blank.audit_url, blank.quote_type], ["", "", "", "", "", CREATE_QUOTE_TYPE]);
  const older = Object.fromEntries(Object.entries(blank).filter(([key]) => !["quote_type", "site", "x_handle", "telegram", "docs_url", "audit_url"].includes(key)));
  assert.deepEqual(parseDraft(older), blank);
  const pasted = parseDraft({ ...blank, x_handle: "https://x.com/@meridianfx", telegram: "https://t.me/meridianfx" });
  assert.deepEqual([pasted.x_handle, pasted.telegram], ["meridianfx", "meridianfx"]);
  assert.equal(parseDraft({ ...blank, telegram: "@meridianfx" }).telegram, "meridianfx");
  assert.throws(() => parseDraft({ ...blank, quote_type: "0x2::sui::SUI" }), (error: unknown) => error instanceof DraftShapeError && error.field === "quote_type");
  assert.throws(() => parseDraft({ ...blank, site: 1 }), (error: unknown) => error instanceof DraftShapeError && error.field === "site");
  assert.throws(() => parseDraft({ ...blank, website: "x" }), (error: unknown) => error instanceof DraftShapeError && error.field === "draft");
  const links = (draft: typeof blank) => draftIssues(draft, { fees: CREATE_DEFAULT_FEE_POLICY, allowlist: null }).filter((issue) => issue.section === "links");
  assert.deepEqual(links({ ...blank, site: "meridian.finance", x_handle: "meridianfx", telegram: "meridianfx", docs_url: "docs.meridian.finance", audit_url: "" }), []);
  assert.deepEqual(links({ ...blank, site: "nope", docs_url: "ftp://x", audit_url: "https://a.example:8443/r.pdf", x_handle: "a".repeat(16), telegram: "abcd" }).map((issue) => `${issue.path}: ${issue.message}`), [
    "site: Website isn't a web address",
    "docs_url: Docs isn't a web address",
    "audit_url: Audit report isn't a web address",
    "x_handle: X handles are up to 15 letters, digits or _",
    "telegram: Telegram names are 5 to 32 letters, digits or _",
  ]);
});

/*
 * R3-42: the "Raise in" picker. The conversion happens only on an explicit
 * pick (`switchDraftQuote`), at the SUI price row, rounded to round numbers
 * (the gate's `niceRound`), exactly; with no price it cannot happen at all.
 */
const SUI_PRICE = { usd_price: "3.42", as_of_ms: 1_790_000_000_000 };

test("R3-42: niceRound is the gate's, exactly: two significant digits from 100, the nearest whole under it, at least 1", () => {
  const ratio = (n: bigint, d: bigint) => ({ n, d });
  // The gate's own: Math.round(n / p) * p with p = 10^(floor(log10 n) − 1).
  assert.equal(niceRound(ratio(40_000_000n, 342n)), 120_000, "$400,000 at $3.42 is 116,959 SUI → 120,000");
  assert.equal(niceRound(ratio(2_923_977n, 100n)), 29_000);
  assert.equal(niceRound(ratio(1368n, 10n)), 140);
  assert.equal(niceRound(ratio(855n, 10n)), 86, "85.5 rounds half up");
  assert.equal(niceRound(ratio(995n, 10n)), 100, "99.5 → 100");
  assert.equal(niceRound(ratio(1n, 10n)), 1, "never below 1");
  assert.equal(niceRound(ratio(1_250n, 1n)), 1_300, "1,250 → 1,300 (half up)");
});

test("R3-42-AC-2: switching to SUI converts the target, limits and minimums at the SUI price and rounds them; switching back converts again", () => {
  const draft = { ...filled(), target: 400_000, wallet_cap: 25_000, min_commitment: 10, lift_min: 0 };
  const sui = switchDraftQuote(draft, CREATE_SUI_QUOTE_TYPE, SUI_PRICE)!;
  assert.equal(sui.quote_type, CREATE_SUI_QUOTE_TYPE);
  // 400,000 / 3.42 = 116,959 → 120,000; 25,000 / 3.42 = 7,309.9 → 7,300; 10 / 3.42 = 2.92 → 3; 0 stays 0.
  assert.deepEqual([sui.target, sui.wallet_cap, sui.min_commitment, sui.lift_min], [120_000, 7_300, 3, 0]);
  // Nothing else moves.
  assert.deepEqual({ ...sui, target: 0, wallet_cap: 0, min_commitment: 0, quote_type: "" }, { ...draft, target: 0, wallet_cap: 0, min_commitment: 0, quote_type: "" });
  const back = switchDraftQuote(sui, CREATE_QUOTE_TYPE, SUI_PRICE)!;
  // 120,000 × 3.42 = 410,400 → 410,000; 7,300 × 3.42 = 24,966 → 25,000; 3 × 3.42 = 10.26 → 10.
  assert.deepEqual([back.quote_type, back.target, back.wallet_cap, back.min_commitment], [CREATE_QUOTE_TYPE, 410_000, 25_000, 10]);
  // The same coin, a coin Create does not raise, or no price: no conversion at all (never a guessed rate).
  assert.equal(switchDraftQuote(draft, CREATE_QUOTE_TYPE, SUI_PRICE), null);
  assert.equal(switchDraftQuote(draft, "0x2::wal::WAL", SUI_PRICE), null);
  assert.equal(switchDraftQuote(draft, CREATE_SUI_QUOTE_TYPE, null), null);
  assert.equal(switchDraftQuote(draft, CREATE_SUI_QUOTE_TYPE, { usd_price: "0", as_of_ms: 1 }), null);
});

test("R3-42: a SUI draft parses, checks and publishes in SUI: its issues name SUI, its atoms have SUI's nine decimals, its quote is SUI", () => {
  const sui: CreateDraft = { ...filled(), quote_type: CREATE_SUI_QUOTE_TYPE, target: 120_000, wallet_cap: 7_300, min_commitment: 3, max_wallets: 10 };
  // As a save's body arrives: JSON text, read back.
  const wire = JSON.stringify(sui);
  assert.equal(parseDraft(JSON.parse(wire)).quote_type, CREATE_SUI_QUOTE_TYPE);
  assert.throws(() => parseDraft({ ...JSON.parse(wire), quote_type: "0x2::wal::WAL" }), DraftShapeError);
  assert.deepEqual(draftQuote(sui), CREATE_QUOTES[0]);
  assert.equal(draftShort(sui, 120_000), "120K SUI");
  assert.deepEqual(messages(sui), ["join:reach:At the minimum, 10 wallets raise only 30 SUI"]);
  assert.deepEqual(messages({ ...sui, target: 20_000_000_000 }).slice(0, 1), ["raise:target:Use at most 10B SUI"]);
  const reaching = { ...sui, max_wallets: 40_000 };
  const args = presaleArgs(reaching, { fees, allowlist: null, creator: addr("c0"), logoUrl: null });
  assert.equal(args.quoteType, CREATE_SUI_QUOTE_TYPE);
  assert.equal(args.raiseTarget, 120_000n * 1_000_000_000n);
  assert.deepEqual(args.eligibility, { kind: "open", walletCap: 7_300n * 1_000_000_000n, maxParticipants: 40_000n, minCommitment: 3n * 1_000_000_000n });
  assert.equal(quoteAtoms(12.34, 9), 12_340_000_000n);
  assert.equal(quoteAtoms(12.34, 6), usdcAtoms(12.34));
});

test("R3-42: a list uploaded for one coin asks to be uploaded again once the draft raises another; never rescaled behind the creator's back", () => {
  const list: CreateAllowlistSummary = { allowlist_id: "00000000-0000-4000-8000-000000000001", root: "ab".repeat(32), leaf_count: 1_000, min_cap: 100, max_cap: 5_000, quote_type: CREATE_QUOTE_TYPE };
  const draft = { ...filled(), eligibility: "allowlist" as const, allowlist_id: list.allowlist_id };
  assert.deepEqual(messages(draft, list), []);
  const sui = switchDraftQuote(draft, CREATE_SUI_QUOTE_TYPE, SUI_PRICE)!;
  assert.equal(sui.allowlist_id, list.allowlist_id, "the list stays attached");
  assert.deepEqual(messages(sui, list), ["join:allowlist:Upload the allowlist again, in SUI"]);
  assert.deepEqual(messages(sui, { ...list, quote_type: CREATE_SUI_QUOTE_TYPE }), []);
});

test("a USDC list carries over to USDsui and back: the same dollars in the same six decimals", () => {
  const list: CreateAllowlistSummary = { allowlist_id: "00000000-0000-4000-8000-000000000001", root: "ab".repeat(32), leaf_count: 1_000, min_cap: 100, max_cap: 5_000, quote_type: CREATE_QUOTE_TYPE };
  const draft = { ...filled(), eligibility: "allowlist" as const, allowlist_id: list.allowlist_id };
  const usdsui = switchDraftQuote(draft, CREATE_USDSUI_QUOTE_TYPE, null)!;
  assert.deepEqual(messages(usdsui, list), []);
  assert.deepEqual(messages(draft, { ...list, quote_type: CREATE_USDSUI_QUOTE_TYPE }), []);
  assert.deepEqual(messages({ ...draft, quote_type: CREATE_WAL_QUOTE_TYPE }, list), ["join:allowlist:Upload the allowlist again, in WAL"]);
  assert.deepEqual(messages(usdsui, { ...list, quote_type: CREATE_WAL_QUOTE_TYPE }), ["join:allowlist:Upload the allowlist again, in USDsui"]);
});


test("unpriced quotes keep entered amounts and preserve the chosen venue", () => {
  const original = { ...filled(), venue: "cetus" as const, pool_fee: 3_000 };
  const fake = switchDraftQuote(original, CREATE_TEST_SUI_QUOTE_TYPE, null)!;
  assert.equal(fake.target, original.target);
  assert.equal(fake.wallet_cap, original.wallet_cap);
  assert.equal(fake.venue, original.venue);
  assert.equal(parseDraft(fake).quote_type, CREATE_TEST_SUI_QUOTE_TYPE);
  assert.equal(presaleArgs(fake, { ...context, creator: addr("c1"), logoUrl: null }).quoteType, CREATE_TEST_SUI_QUOTE_TYPE);
  assert.deepEqual(messages(fake), []);
  assert.deepEqual(messages({ ...fake, venue: "cetus" }), []);
  assert.equal(switchDraftQuote(fake, CREATE_QUOTE_TYPE, null)!.target, original.target);
});

test("short description accepts its 120-character bound and refuses oversized saved drafts", () => {
  const tagline = "🚀".repeat(120);
  assert.equal(parseDraft({ ...blankDraft(), tagline }).tagline, tagline);
  assert.throws(() => parseDraft({ ...blankDraft(), tagline: "a".repeat(121) }));
});


test("USDsui drafts parse and publish with six decimals, retaining explicit coin amounts on switches", () => {
  const original = { ...filled(), target: 400_000.25, wallet_cap: 25_000.25, min_commitment: 20.25 };
  const draft = switchDraftQuote(original, CREATE_USDSUI_QUOTE_TYPE, null)!;
  assert.equal(parseDraft(draft).quote_type, CREATE_USDSUI_QUOTE_TYPE);
  assert.deepEqual(draft, { ...original, quote_type: CREATE_USDSUI_QUOTE_TYPE });
  assert.equal(draftShort(draft, 400_000), "400K USDsui");
  const args = presaleArgs(draft, { ...context, creator: addr("c1"), logoUrl: null });
  assert.equal(args.quoteType, CREATE_USDSUI_QUOTE_TYPE);
  assert.equal(args.raiseTarget, 400_000_250_000n);
  assert.deepEqual(switchDraftQuote(draft, CREATE_QUOTE_TYPE, null), original);
  assert.equal(switchDraftQuote(draft, CREATE_SUI_QUOTE_TYPE, SUI_PRICE)!.target, draft.target);
  assert.equal(switchDraftQuote({ ...original, quote_type: CREATE_SUI_QUOTE_TYPE }, CREATE_USDSUI_QUOTE_TYPE, SUI_PRICE)!.target, original.target);
});

test("a hashiBTC target keeps four decimal places through the draft and transaction", () => {
  const draft = { ...filled(), quote_type: CREATE_HASHI_BTC_QUOTE_TYPE, target: 0.0105, wallet_cap: 0.01, min_commitment: 0.01 };
  const parsed = parseDraft(JSON.parse(JSON.stringify(draft)));
  assert.equal(parsed.target, 0.0105);
  assert.equal(presaleArgs(parsed, { ...context, creator: addr("c1"), logoUrl: null }).raiseTarget, 1_050_000n);
  const usdc = switchDraftQuote(parsed, CREATE_QUOTE_TYPE, null)!;
  assert.equal(parseDraft(usdc).target, 0.01);
});


test("WAL drafts retain explicit amounts across coin switches and publish with nine decimals", () => {
  const original = { ...filled(), target: 400_000.25, wallet_cap: 25_000.25, min_commitment: 20.25, lift_min: 12.34 };
  const draft = switchDraftQuote(original, CREATE_WAL_QUOTE_TYPE, null)!;
  assert.deepEqual(draft, { ...original, quote_type: CREATE_WAL_QUOTE_TYPE });
  const wire = JSON.stringify(draft);
  assert.deepEqual(parseDraft(JSON.parse(wire)), draft);
  const validate = createSocialValidator();
  assert.equal(validate.validate("create-draft", draft).valid, true);
  assert.equal(draftQuote(draft).decimals, 9);
  assert.equal(draftShort(draft, 400_000), "400K WAL");
  const args = presaleArgs(draft, { ...context, creator: addr("c1"), logoUrl: null });
  assert.equal(args.quoteType, CREATE_WAL_QUOTE_TYPE);
  assert.equal(args.raiseTarget, 400_000_250_000_000n);
  assert.deepEqual(args.eligibility, { kind: "open", walletCap: 25_000_250_000_000n, maxParticipants: BigInt(draft.max_wallets), minCommitment: 20_250_000_000n });
  for (const quoteType of [CREATE_QUOTE_TYPE, CREATE_SUI_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE]) {
    for (const price of [null, SUI_PRICE]) {
      const other = { ...original, quote_type: quoteType };
      assert.deepEqual(switchDraftQuote(other, CREATE_WAL_QUOTE_TYPE, price), draft);
      assert.deepEqual(switchDraftQuote(draft, quoteType, price), other);
    }
  }
  const list: CreateAllowlistSummary = { allowlist_id: "00000000-0000-4000-8000-000000000001", root: "ab".repeat(32), leaf_count: 1_000, min_cap: 100, max_cap: 5_000, quote_type: CREATE_QUOTE_TYPE };
  assert.ok(messages({ ...draft, eligibility: "allowlist", allowlist_id: list.allowlist_id }, list).includes("join:allowlist:Upload the allowlist again, in WAL"));
});
