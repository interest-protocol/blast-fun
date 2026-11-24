import assert from "node:assert/strict";
import test from "node:test";
import { bcs } from "@mysten/sui/bcs";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { defineBlastDeployment, launchpadDeployment } from "@interest-protocol/blast-sdk/deployments";
import { LaunchpadTransactions } from "@interest-protocol/blast-sdk/launchpad";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { fixturePrivySigner, fixtureWalletSigner, NON_PRODUCTION_MANIFEST } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { createTradeFixtureChain, TRADE_LAUNCH_ID, TRADE_MEME_TYPE } from "../../../../../../packages/core/test/fixtures/launchpad/trade/trade-fixtures.ts";
import { curveTradeAdapter, type CurveTradeInput } from "./curve-adapter.ts";
import { CurveSponsorshipUnavailable } from "./curve-payment-client.ts";
import { runFreshPreflight } from "../transaction/preflight.ts";
import { signAndSubmitOnce } from "../transaction/execution.ts";

const OWNER = normalizeSuiAddress("0x123");
const RESERVATION = "00000000-0000-4000-8000-000000000001";

for (const direction of ["buy", "sell"] as const) {
  test(`embedded ${direction} uses sponsor gas, reuses its review reservation, signs once and submits through the sponsor`, async (t) => {
    const fixture = createTradeFixtureChain({ quoteType: CREATE_TEST_SUI_QUOTE_TYPE });
    const baseSigner = fixturePrivySigner();
    const signer = { ...baseSigner, accessToken: async () => "fixture-access-token" };
    fixture.state.meme[signer.address] = 5_000_000_000_000_000n;
    const input: CurveTradeInput = { launchId: TRADE_LAUNCH_ID, direction, amount: direction === "buy" ? "5" : "1000000", slippageBps: 100n };
    let reservations = 0;
    let executionBytes: Uint8Array | null = null;
    let altered = false;
    let unavailable = false;
    const adapter = curveTradeAdapter(direction, undefined, async (_signer, request) => {
      reservations++;
      if (unavailable) throw new Error("Sponsor unavailable");
      const sdk = new LaunchpadTransactions(launchpadDeployment(defineBlastDeployment(NON_PRODUCTION_MANIFEST)));
      const args = { launch: { objectId: TRADE_LAUNCH_ID, initialSharedVersion: "12", mutable: true as const }, memeType: TRADE_MEME_TYPE, quoteType: CREATE_TEST_SUI_QUOTE_TYPE, recipient: signer.address };
      const tx = direction === "buy"
        ? sdk.buy({ ...args, quoteAmount: BigInt(request.amount), minMemeOut: BigInt(request.min_out), useGasCoin: false })
        : sdk.sell({ ...args, memeAmount: BigInt(request.amount), minQuoteOut: BigInt(request.min_out) });
      tx.setSender(signer.address);
      const kind = await tx.build({ client: fixture.client, onlyTransactionKind: true });
      // Like the shared sponsor: exact kind, sender and a separate gas owner.
      const bytes = bcs.TransactionData.serialize({ V1: { kind: bcs.TransactionKind.parse(kind), sender: altered ? OWNER : signer.address, gasData: { owner: OWNER, price: 1000, budget: 50000000, payment: [] }, expiration: { None: true } } }).toBytes();
      executionBytes = bytes;
      return { reservation_id: RESERVATION, transaction_bytes: toBase64(bytes), transaction_kind_bytes: toBase64(kind), expires_at_ms: Date.now() + 60_000 };
    });
    const run = (signing = signer) => runFreshPreflight({ chain: { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" }, signer: signing, adapter, input, reviewId: "sponsor" });
    const first = await run();
    assert.equal(first.outcome.status, "ready", JSON.stringify(first.outcome));
    if (first.outcome.status !== "ready") return;
    assert.equal(first.outcome.review.sponsorReservationId, RESERVATION);
    const data = Transaction.from(first.outcome.review.transactionBytes).getData();
    assert.equal(data.gasData.owner, OWNER);
    assert.ok(data.commands.every(command => !command.SplitCoins || command.SplitCoins.coin.$kind !== "GasCoin"), "payment must come from the user's assets, never sponsor gas");
    const second = await run();
    assert.equal(second.outcome.status, "ready");
    assert.equal(reservations, 1, "approval must not reserve a second sponsorship");
    let sends = 0;
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      sends++;
      assert.equal(String(url), `/api/presale/sponsor/${RESERVATION}/execute`);
      const signature = JSON.parse(String(init?.body)).user_signature;
      assert.ok(executionBytes);
      await fixture.client.core.executeTransaction({ transaction: executionBytes, signatures: [signature] });
      return Response.json({ digest: TransactionDataBuilder.getDigestFromBytes(executionBytes), effects: { status: "success" } });
    });
    const sent = await signAndSubmitOnce({ client: fixture.client, signer, review: first.outcome.review });
    assert.equal(sent.status, "submitted");
    assert.equal(sends, 1);
    assert.equal(fixture.calls.execute, 1);

    // A changed minimum needs a fresh reservation, whose bytes still must match.
    altered = true;
    const changed = { ...input, slippageBps: 200n };
    const rejected = await runFreshPreflight({ chain: { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" }, signer, adapter, input: changed, reviewId: "changed" });
    assert.equal(rejected.outcome.status, "blocked");
    unavailable = true;
    const refused = await runFreshPreflight({ chain: { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" }, signer, adapter, input: { ...input, slippageBps: 300n }, reviewId: "refused" });
    assert.equal(refused.outcome.status, "blocked");
    assert.equal(sends, 1, "no fallback submission when sponsorship is refused");
  });
}

test("past the trade cap an outside wallet pays its own gas; an embedded wallet is refused", async () => {
  const fixture = createTradeFixtureChain({ quoteType: CREATE_TEST_SUI_QUOTE_TYPE });
  const input: CurveTradeInput = { launchId: TRADE_LAUNCH_ID, direction: "buy", amount: "5", slippageBps: 100n };
  const adapter = curveTradeAdapter("buy", undefined, async () => { throw new CurveSponsorshipUnavailable(); });
  const chain = { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" as const };

  const wallet = { ...fixtureWalletSigner(), sponsored: true };
  const paid = await runFreshPreflight({ chain, signer: wallet, adapter, input, reviewId: "wallet-pays" });
  assert.equal(paid.outcome.status, "ready", JSON.stringify(paid.outcome));
  if (paid.outcome.status !== "ready") return;
  assert.equal(paid.outcome.review.sponsorReservationId, undefined);
  const data = Transaction.from(paid.outcome.review.transactionBytes).getData();
  assert.equal(data.gasData.owner, wallet.address);

  const embedded = { ...fixturePrivySigner(), accessToken: async () => "fixture-access-token" };
  const refused = await runFreshPreflight({ chain, signer: embedded, adapter, input, reviewId: "embedded-refused" });
  assert.equal(refused.outcome.status, "blocked");
});
