import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type { FeedItem } from "@blast/core/modules/social/contracts/items.ts";

import { STORY_NOW, TIDE, tideFacts } from "../../../../test/fixtures/social/commit/commit-fixtures.ts";
import { fixtureWallet } from "../../../../test/fixtures/social/trade/trade-fixtures.ts";
import type { CommitBlastInput } from "./CommitPanel";
import type { CommitFacts, CommitKit, CommitSendResult } from "./commit-kit";
import { HOLD_COIN_NOT_HELD } from "./commit-input";
import { createCommitQuotes } from "./commit-quote";
import { heldRefusalText, heldTargetOfItem, heldTargetOfPresale, judgeHeldBlast, sendHeldBlast } from "./use-held-blast.ts";

/**
 * R3-13: a held blast's money path is the one commit module's. The release is
 * judged on the commit quote's fresh facts by `commit/quote.ts`'s refusals, in
 * the gate's words, before anything is built; the write is one `kit.send` —
 * the dialog's own flow (T-024's intent with the digest as its key, R3-27's
 * log, the toast and the sound) — with the held amount, the Settings coin (by
 * default the sale's own), no why, and the post it came through.
 */

type Sent = Readonly<{ facts: CommitFacts; input: CommitBlastInput; options: unknown }>;

function fakeKit(answer: CommitFacts | null, result: CommitSendResult = { status: "sent", digest: "4vJ9" }, holdCoin: string | null | Error = null) {
  const sent: Sent[] = [];
  let reads = 0;
  const kit: Pick<CommitKit, "quotes" | "send" | "quotePayment" | "holdCoin"> = {
    holdCoin: { peek: () => (holdCoin instanceof Error ? undefined : holdCoin), read: async () => { if (holdCoin instanceof Error) throw holdCoin; return holdCoin; } },
    quotePayment: async () => assert.fail("unexpected swap quote"),
    quotes: createCommitQuotes<CommitFacts>({
      client: createTestQueryClient(),
      read: async () => {
        reads += 1;
        return answer;
      },
    }),
    send: async (facts, input, options) => {
      sent.push({ facts, input, options });
      return result;
    },
  };
  return {
    kit,
    sent,
    get reads() {
      return reads;
    },
  };
}

async function hold(facts: CommitFacts | null, amountUsd: number, nowMs = STORY_NOW, holdCoin: string | null | Error = null) {
  const fake = fakeKit(facts, undefined, holdCoin);
  const judged = await judgeHeldBlast(fake.kit, TIDE.presaleId, amountUsd, nowMs);
  if ("refusal" in judged) return { fake, refusal: judged.refusal };
  await sendHeldBlast(fake.kit, judged, { entryId: "a:post-1", through: "Mira" });
  return { fake, refusal: null };
}

test("R3-13-AC-4: a charged release sends exactly one commit with that amount, in USDC, with no why, crediting the post it came through", async () => {
  const { fake, refusal } = await hold(tideFacts(), 100);
  assert.equal(refusal, null);
  assert.equal(fake.sent.length, 1, "one write");
  const [one] = fake.sent;
  assert.deepEqual(one!.input, { payWith: "USDC", pay: 100, usd: 100, quote: 100, why: "" });
  assert.deepEqual(one!.options, { source: { entryId: "a:post-1", through: "Mira" } });
  assert.equal(one!.facts.sale?.presaleId, TIDE.presaleId, "judged on the commit quote's own facts");
  assert.equal(fake.reads, 1, "one quote read at the release");
});

test("R3-13-AC-5: a quote refusal (below the minimum) sends nothing and says the refusal's own words", async () => {
  const { fake, refusal } = await hold(tideFacts({ sale: { minCommitment: 500 } }), 100);
  assert.equal(refusal, "The minimum is $500");
  assert.deepEqual(fake.sent, []);
});

test("a held release uses the exact input balance even if the holdings view has more", async () => {
  const wallet = fixtureWallet();
  const fake = fakeKit({ ...tideFacts(), wallet });
  const inputBalance = {
    peek: () => null,
    async read(address: string, coinType: string) {
      assert.equal(address, wallet.address);
      assert.equal(coinType, wallet.coins?.find((coin) => coin.symbol === "USDC")?.coin_type);
      return 95_240_600n;
    },
  };
  const judged = await judgeHeldBlast({ ...fake.kit, inputBalance }, TIDE.presaleId, 100, STORY_NOW);
  assert.deepEqual(judged, { refusal: "Not enough to cover it" });
});

test("R3-13-AC-10: a sale that closed while held refuses at the release with its own copy, and writes nothing", async () => {
  const closedByClock = await hold(tideFacts(), 100, TIDE.endMs + 1);
  assert.equal(closedByClock.refusal, "Tidal isn't taking commitments");
  assert.deepEqual(closedByClock.fake.sent, []);
  const funded = await hold(tideFacts({ sale: { lifecycle: "funded" } }), 100);
  assert.equal(funded.refusal, "Tidal isn't taking commitments");
  assert.deepEqual(funded.fake.sent, []);
});

test("R3-13: the balance, the wallet cap and the blasting-off wall all refuse before anything is built", async () => {
  // The balance moved under the hold: re-checked at the release.
  const poorer = await hold(tideFacts({ viewer: { usdc: 60, sui: 0 } }), 100);
  assert.equal(poorer.refusal, "Not enough to cover it");
  // The cap counts what the wallet already holds.
  const capped = await hold(tideFacts({ sale: { walletCap: 1_000 }, viewer: { committed: 950 } }), 100);
  assert.equal(capped.refusal, "The most one wallet can put in is $1,000");
  // No deployment manifest here: the published line, the same as the dialog's.
  const off = await hold(tideFacts({ blockers: ["presale_not_deployed"] }), 100);
  assert.equal(off.refusal, "Blasting opens once the sale contract is live on Sui mainnet. Nothing is sent until then.");
  // An unreadable sale.
  const unreadable = await hold(null, 100);
  assert.equal(unreadable.refusal, "That didn’t go through");
  // The Settings coin is not in this wallet: refused, never paid with another coin.
  const notHeld = await hold({ ...tideFacts(), wallet: fixtureWallet() }, 100, STORY_NOW, `0x${"c".repeat(64)}::coin::COIN`);
  assert.equal(notHeld.refusal, HOLD_COIN_NOT_HELD);
  // The Settings read failed: the hold cannot know its coin.
  const noSettings = await hold(tideFacts(), 100, STORY_NOW, new Error("offline"));
  assert.equal(noSettings.refusal, "That didn’t go through");
  for (const result of [poorer, capped, off, unreadable, notHeld, noSettings]) assert.deepEqual(result.fake.sent, []);
});

test("a hold on a SUI sale with no coin chosen pays SUI directly, sized at SUI's price", async () => {
  const { fake, refusal } = await hold(tideFacts({ sale: { quoteCoin: "SUI" } }), 100);
  assert.equal(refusal, null);
  assert.equal(fake.sent[0]?.input.payWith, "SUI");
  assert.equal(fake.sent[0]?.input.pay, 29.23);
});

test("R3-13: the refusal words are the gate's (commitErrorText), and the wall's are the published line", () => {
  assert.equal(heldRefusalText(null), "That didn’t go through");
});

test("R3-13: a post's target credits that post at the release; a sale's carries no source; the fill is the raise's own", () => {
  const presale = {
    presale_id: "0xabc",
    name: "Meridian",
    lifecycle: "open",
    raised: "184221000000",
    raise_target: "250000000000",
  } as unknown as NonNullable<FeedItem["presale"]>;
  const item = { entry_id: "a:entry", presale, actor: { type: "account", callsign: "mira", display_name: "Mira" } } as unknown as FeedItem;
  const target = heldTargetOfItem(item, "kai");
  assert.ok(target);
  assert.equal(target.presaleId, "0xabc");
  assert.equal(target.open, true);
  assert.ok(Math.abs((target.fill ?? 0) - 0.736884) < 1e-6);
  assert.equal(target.source?.().entryId, "a:entry");
  const sale = heldTargetOfPresale({ ...presale, lifecycle: "funded" });
  assert.equal(sale.open, false, "only an open sale charges");
  assert.equal(sale.source, undefined);
  assert.equal(heldTargetOfItem({ ...item, presale: null } as unknown as FeedItem, "kai"), null);
});

test("#588: a sale scheduled to open later does not charge until its start", () => {
  const presale = { presale_id: "0xabc", name: "Meridian", lifecycle: "open", start_ms: 2_000, raised: "0", raise_target: "250000000000" } as unknown as NonNullable<FeedItem["presale"]>;
  assert.equal(heldTargetOfPresale(presale, 1_999).open, false);
  assert.equal(heldTargetOfPresale(presale, 2_000).open, true);
  const item = { entry_id: "a:entry", presale, actor: null } as unknown as FeedItem;
  assert.equal(heldTargetOfItem(item, null, 1_999)?.open, false);
});

test("R3-13: a held blast builds no commit of its own — no fetch, no second flow — and the old commitHold path is gone", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  // The code, not its comments (which name the flow it goes through).
  const code = async (path: string) => (await read(path)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const path of [
    "./use-held-blast.ts",
    "../../blast-feel/use-feel-hold.ts",
    "../../blast-feel/feel-hold-gesture.ts",
    "../../blast-feel/feel-hold-release.ts",
  ]) {
    const source = await code(path);
    assert.doesNotMatch(source, /\bfetch\(|callSocialApi|Authorization|runCommit|commit-run|signTransaction|registerIntent/, `${path} builds no commit`);
  }
  // Its only write is the kit's send — the commit dialog's own blast.
  assert.match(await code("./use-held-blast.ts"), /kit\.send\(/);
  for (const path of ["./CommitHost.tsx", "../feed-ui/shell-bridge.tsx", "../post/PostCard.tsx"]) {
    assert.doesNotMatch(await code(path), /commitHold|CommitHold/, `${path} still carries the superseded hold path`);
  }
});
