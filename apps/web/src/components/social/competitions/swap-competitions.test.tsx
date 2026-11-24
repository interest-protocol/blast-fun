import assert from "node:assert/strict";
import test from "node:test";
import {
  installTestDom,
  setInputValue,
  recordAnimations,
} from "../../../../test/fixtures/social/test-dom.ts";
import {
  FIXTURE_COINS,
  DEFAULT_SWAP_MODE,
} from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { fixtureQuote } from "../../../../test/fixtures/social/coins/swap-fixture.ts";
import { competitionInput } from "@blast/core/modules/social/competitions/config.ts";

const { document, window } = installTestDom();
Object.assign(document, { oninput: null });
const motion = recordAnimations();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { CoinSheet } = await import("../coins/CoinSheet.tsx");
const { TokenPickerBody } = await import("../coins/TokenPicker.tsx");
const { liveSwapCompetitions } = await import("./swap-competitions.ts");
const coin = { ...FIXTURE_COINS[2]!, key: FIXTURE_COINS[2]!.coinType, presale: null };
const event = {
  ...competitionInput.parse({
    slug: "kestrel-week",
    name: "Kestrel week",
    coin_type: coin.coinType,
    coin_symbol: coin.symbol,
    feature_on_swap: true,
    rules_url: "https://x.com/kestrel/status/123",
    starts_at_ms: 1000,
    ends_at_ms: 2000,
  }),
  rules_version: 1 as const,
};

test("promotion follows server time, includes start and excludes end with a skewed client clock", () => {
  const data = {
    competitions: [event],
    coins: [],
    as_of_ms: 1000,
    request_started_at_ms: 999_000,
    next_change_at_ms: 2000,
  };
  assert.deepEqual(liveSwapCompetitions(data, 0), []);
  assert.deepEqual(liveSwapCompetitions({ ...data, as_of_ms: 999 }, 999_000), []);
  assert.deepEqual(liveSwapCompetitions(data, 999_000), [event]);
  assert.deepEqual(liveSwapCompetitions(data, 999_999), [event]);
  assert.deepEqual(liveSwapCompetitions(data, 1_000_000), []);
  assert.deepEqual(
    liveSwapCompetitions(
      { ...data, competitions: [{ ...event, feature_on_swap: false }] },
      999_000,
    ),
    [],
  );
});

test("featured shortcuts precede preferred coins, deduplicate and preserve normal eligibility", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const picked: string[] = [];
  await act(async () =>
    root.render(
      <TokenPickerBody
        current={coin}
        wallet={[...FIXTURE_COINS.filter((value) => value.coinType !== coin.coinType), coin]}
        hidden={false}
        pins={[]}
        listCoins={async () => []}
        onPick={(value) => picked.push(value.coinType)}
        featuredCoins={[
          coin,
          FIXTURE_COINS[1]!,
          coin,
          { ...coin, key: "unavailable", coinType: "unavailable", metadataAvailable: false },
        ]}
      />,
    ),
  );
  const chips = [
    ...container.querySelectorAll<HTMLButtonElement>('[aria-label="Quick choices"] button'),
  ];
  assert.equal(chips[0]!.textContent, "KSTL");
  assert.equal(chips[1]!.textContent, "SUI");
  assert.equal(chips.filter((chip) => chip.hasAttribute("data-competition")).length, 2);
  assert.equal(chips[0]!.getAttribute("aria-pressed"), "true");
  await act(async () => chips[0]!.click());
  assert.deepEqual(picked, [coin.coinType]);
});

test("expiry removes promotion while a prepared swap retains its assets, amount and pending trade", async (t) => {
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    if (reads > 1) return new Promise(() => undefined); // Expiry works without a fresh response.
    return Response.json({
      competitions: [{ ...event, ends_at_ms: 5500 }],
      coins: [],
      as_of_ms: 1000,
      next_change_at_ms: 5500,
    });
  };
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  });
  const settle = async (ms = 50) => {
    await act(async () => {
      motion.finishAll();
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };
  const click = async (selector: string) => {
    const node = container.querySelector<HTMLElement>(selector);
    assert.ok(node, selector);
    await act(async () => node.click());
    await settle();
  };
  const pending = Promise.withResolvers<{ status: "traded" }>();
  const coins = [...FIXTURE_COINS.filter((value) => value.coinType !== coin.coinType), coin];
  await act(async () =>
    root.render(
      withQueryClient(
        client,
        <CoinSheet
          inline
          open
          session={1}
          first={{ kind: "trade", key: "sui" }}
          wallet={{ status: "ready", address: "0x" + "ab".repeat(32), fee: "sponsored", coins }}
          onClose={() => {}}
          onCopy={() => {}}
          onRetry={() => {}}
          onWithdraw={async () => false}
          trading={{
            signedIn: true,
            onSignIn: () => {},
            listCoins: async () => [],
            requestQuote: async (body) => ({
              status: "ok",
              body: fixtureQuote(body, coins, DEFAULT_SWAP_MODE, Date.now()),
              httpStatus: 200,
            }),
            trade: () => pending.promise,
          }}
        />,
      ),
    ),
  );
  await settle();
  await click('[data-coin-pick="out"]');
  assert.match(
    container.querySelector('[aria-label="Quick choices"] button')!.textContent!,
    /^KSTL$/,
  );
  assert.equal(
    container.querySelector<HTMLAnchorElement>('a[href="/competitions/kestrel-week"]')?.textContent,
    "Leaderboard",
  );
  assert.equal(
    container.querySelector<HTMLAnchorElement>('a[href="https://x.com/kestrel/status/123"]')
      ?.target,
    "_blank",
  );
  await click("[data-competition]");
  const input = container.querySelector<HTMLInputElement>("[data-coin-focus]")!;
  await act(async () => {
    setInputValue(input, "10");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle(350);
  await click("[data-trade]");
  await act(async () => settleQueries(client));
  assert.equal(container.querySelector("[data-trade]")!.getAttribute("aria-busy"), "true");
  await settle(5000);
  assert.equal(container.querySelector('[aria-label="Live trading competitions"]'), null);
  assert.equal(container.querySelector("[data-coin-focus]"), input);
  assert.equal(input.value, "10");
  assert.equal(input.disabled, true);
  assert.match(container.querySelector('[data-coin-pick="out"]')!.textContent!, /KSTL/);
  assert.equal(container.querySelector("[data-trade]")!.getAttribute("aria-busy"), "true");
  await act(async () => pending.resolve({ status: "traded" }));
});
