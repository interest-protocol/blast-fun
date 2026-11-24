import { mainnetIdentity } from "@blast/core/modules/presale/deployment/mainnet-identity.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { fromBase64, normalizeStructTag } from "@mysten/sui/utils";
import { bcs } from "@mysten/sui/bcs";

import { presaleIdentityFixture } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { parsePresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import type { PresaleDeploymentState, PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import type { CreateDraft } from "@blast/core/modules/social/contracts/create.ts";
import { configuredFeePolicy, CREATE_QUOTE_TYPE, createPresaleTransaction, feePolicySource, publishAvailability, registerCurrencyTransaction, sdkSupportsVesting, type CoinTemplate } from "@blast/server/modules/social/create/chain.ts";
import { blankDraft, CREATE_DEFAULT_FEE_POLICY } from "@blast/core/modules/social/create/model.ts";
import { presaleArgs } from "@blast/core/modules/social/create/presale-args.ts";

const addr = (tag: string) => `0x${tag.padStart(64, "0")}`;
const asMainnet = parsePresaleRuntimeIdentity(presaleIdentityFixture(), { production: false });
const ready = (identity: PresaleRuntimeIdentity): PresaleDeploymentState => ({ status: "ready", identity });
const template: CoinTemplate = { bytecode: async () => ({ modules: [], dependencies: [] }) };

function filled(overrides: Partial<CreateDraft> = {}): CreateDraft {
  const draft = blankDraft();
  return {
    ...draft,
    name: "Meridian",
    symbol: "MRDN",
    token_recipients: draft.token_recipients.map((row, index) => ({ ...row, address: addr(`a${index}`) })),
    raise_recipients: draft.raise_recipients.map((row) => ({ ...row, address: addr("a0") })),
    ...overrides,
  };
}

test("publishing is off without a mainnet deployment, a coin template, or SDK vesting; each reason is named", () => {
  assert.deepEqual(publishAvailability({ state: { status: "unavailable", reason: "missing" }, template: null, draft: blankDraft(), vesting: false }), {
    available: false,
    reasons: ["presale_not_deployed", "coin_template_missing", "sdk_vesting_unsupported"],
  });
  const unvested = filled({ token_recipients: filled().token_recipients.map((row) => ({ ...row, vest: false })), raise_recipients: filled().raise_recipients.map((row) => ({ ...row, vest: false })) });
  assert.deepEqual(publishAvailability({ state: ready(asMainnet), template, draft: unvested, vesting: false }), { available: true });
  assert.deepEqual(publishAvailability({ state: ready(asMainnet), template, draft: filled(), vesting: false }), { available: false, reasons: ["sdk_vesting_unsupported"] });
  assert.deepEqual(publishAvailability({ state: ready(asMainnet), template, draft: filled(), vesting: true }), { available: true });
  // The published SDK carries the presale's vesting.
  assert.equal(sdkSupportsVesting(), true);
  assert.equal(sdkSupportsVesting({}), false);
  assert.equal(sdkSupportsVesting({ setParticipantVesting: () => null }), true);
  assert.equal(mainnetIdentity(ready(asMainnet)), asMainnet);
  assert.equal(mainnetIdentity({ status: "unavailable", reason: "network_not_allowed" }), null);
});

test("Blast's rates: configured (or the defaults) before the deploy, and while no node answers", async () => {
  assert.deepEqual(configuredFeePolicy(undefined), {
    raise_bps: 200,
    token_bps: 100,
    lp_fee_meme_bps: 1_500,
    lp_fee_quote_bps: 1_500,
    source: "config",
  });
  assert.deepEqual(configuredFeePolicy(" "), CREATE_DEFAULT_FEE_POLICY);
  assert.deepEqual(configuredFeePolicy("150, 50, 800, 900"), { raise_bps: 150, token_bps: 50, lp_fee_meme_bps: 800, lp_fee_quote_bps: 900, source: "config" });
  // This fails if invalid rates fall back to the defaults again instead of stopping boot.
  for (const raw of ["10000,0,0,0", "nope", "1,2,3"]) {
    assert.throws(() => configuredFeePolicy(raw), /^Error: SOCIAL_CREATE_FEE_POLICY must be four comma-separated BPS: raise, token, lp_meme, lp_quote\.$/);
  }
  let calls = 0;
  const before = feePolicySource({ state: { status: "unavailable", reason: "missing" }, client: () => { calls += 1; return null; }, configured: CREATE_DEFAULT_FEE_POLICY });
  assert.deepEqual(await before(), CREATE_DEFAULT_FEE_POLICY);
  assert.equal(calls, 0, "no node is asked before the deploy");
  const noNode = feePolicySource({ state: ready(asMainnet), client: () => null, configured: CREATE_DEFAULT_FEE_POLICY });
  assert.deepEqual(await noNode(), CREATE_DEFAULT_FEE_POLICY);
});

test("register_currency shares the coin's Currency through the Coin Registry", async () => {
  const tx = registerCurrencyTransaction({ coinType: `${addr("c01")}::mrdn::MRDN`, currency: { objectId: addr("cc"), version: "12", digest: "4yUWbNQnn9KhVz9mSaQnTnmzAhHmzuHJyUz1rQpRKjat" } });
  const data = tx.getData();
  assert.equal(data.commands.length, 1);
  const call = data.commands[0]!.MoveCall!;
  assert.equal(`${call.package}::${call.module}::${call.function}`, `${addr("2")}::coin_registry::finalize_registration`);
  assert.deepEqual(call.typeArguments, [normalizeStructTag(`${addr("c01")}::mrdn::MRDN`)]);
  assert.deepEqual(data.inputs.map((input) => Object.keys(input)[0]), ["UnresolvedObject", "Object"]);
});

test("create_presale is the venue's new, every setting, finalize, then share, and the cap to the creator, built by the SDK", () => {
  const draft = filled({ token_recipients: filled().token_recipients.map((row) => ({ ...row, vest: false })), raise_recipients: filled().raise_recipients.map((row) => ({ ...row, vest: false })) });
  const args = presaleArgs(draft, { fees: CREATE_DEFAULT_FEE_POLICY, allowlist: null, creator: addr("c0"), logoUrl: null });
  const coin = { coinType: `${addr("c01")}::mrdn::MRDN`, sealedTreasuryCap: { objectId: addr("ca"), version: "12", digest: "4yUWbNQnn9KhVz9mSaQnTnmzAhHmzuHJyUz1rQpRKjat" }, currency: { objectId: addr("cc"), initialSharedVersion: "12" } };
  const targets = (venue: "cetus" | "bluefin") => {
    const tx = createPresaleTransaction({ identity: asMainnet, args: { ...args, venue }, coin, creator: addr("c0") });
    return tx.getData().commands.flatMap((command) => (command.MoveCall ? [`${command.MoveCall.module}::${command.MoveCall.function}`] : command.TransferObjects ? ["transfer"] : []));
  };
  const cetus = targets("cetus");
  assert.ok(cetus.includes("cetus::prepare"));
  assert.ok(cetus.includes("blast_presale::new"));
  assert.ok(cetus.includes("blast_presale::open_eligibility"));
  assert.ok(cetus.includes("blast_presale::share"));
  assert.equal(cetus.at(-1), "transfer");
  assert.ok(cetus.indexOf("cetus::prepare") < cetus.indexOf("blast_presale::share"));
  assert.ok(targets("bluefin").includes("bluefin::prepare"));
  // Generation 2's initializer: every setting, then `finalize`, before `share`. Without an uncapped phase
  // there is no hard cap, so no `set_hard_cap`.
  assert.ok(cetus.indexOf("blast_presale::finalize") > cetus.indexOf("cetus::prepare") && cetus.indexOf("blast_presale::finalize") < cetus.indexOf("blast_presale::share"));
  assert.ok(!cetus.includes("blast_presale::set_hard_cap"));
  // With "stop at the target" the sale-level hard cap is set, never dropped (the terms are no longer cast).
  const capped = presaleArgs({ ...draft, lift: true, lift_hard_cap: true }, { fees: CREATE_DEFAULT_FEE_POLICY, allowlist: null, creator: addr("c0"), logoUrl: null });
  assert.ok(capped.hardCap);
  const cappedTargets = createPresaleTransaction({ identity: asMainnet, args: capped, coin, creator: addr("c0") })
    .getData()
    .commands.flatMap((command) => (command.MoveCall ? [`${command.MoveCall.module}::${command.MoveCall.function}`] : []));
  assert.ok(cappedTargets.includes("blast_presale::set_hard_cap"));
  assert.ok(cappedTargets.includes("blast_presale::set_uncapped_phase"));
  assert.equal(CREATE_QUOTE_TYPE, normalizeStructTag("0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"));
});

test("publish transactions set immediate launch from the start and scheduled launch waits even under a final-phase cap", () => {
  const coin = { coinType: `${addr("c01")}::mrdn::MRDN`, sealedTreasuryCap: { objectId: addr("ca"), version: "12", digest: "4yUWbNQnn9KhVz9mSaQnTnmzAhHmzuHJyUz1rQpRKjat" }, currency: { objectId: addr("cc"), initialSharedVersion: "12" } };
  for (const venue of ["cetus", "bluefin"] as const) {
    for (const launch_when_filled of [true, false]) {
      const draft = filled({ venue, launch_when_filled, lift: !launch_when_filled });
      const args = presaleArgs(draft, { fees: CREATE_DEFAULT_FEE_POLICY, allowlist: null, creator: addr("c0"), logoUrl: null });
      const data = createPresaleTransaction({ identity: asMainnet, args, coin, creator: addr("c0") }).getData();
      const cap = data.commands.find((command) => command.MoveCall?.function === "set_hard_cap")?.MoveCall;
      assert.ok(cap);
      // set_hard_cap(initializer, package_version, start_delay_ms, closes_when_filled)
      const values = cap.arguments.slice(2).map((argument) => {
        assert.ok("Input" in argument);
        const input = data.inputs[argument.Input];
        assert.ok(input?.Pure);
        return fromBase64(input.Pure.bytes);
      });
      assert.equal(bcs.u64().parse(values[0]!), launch_when_filled ? "0" : String(3 * 86_400_000 - 6 * 3_600_000));
      assert.equal(bcs.bool().parse(values[1]!), launch_when_filled);
      assert.equal(data.commands.some((command) => command.MoveCall?.function === "set_uncapped_phase"), !launch_when_filled);
      assert.ok(data.commands.some((command) => command.MoveCall?.function === "open_eligibility"));
    }
  }
});
