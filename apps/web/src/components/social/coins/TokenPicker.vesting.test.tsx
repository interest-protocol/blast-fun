import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TokenPickerBody } = await import("./TokenPicker");
const { PUBLIC_PREFERRED_COINS } = await import("./coin-model");
import type { WalletCoinView } from "./coin-model";
const UNLISTED: WalletCoinView = {
  ...PUBLIC_PREFERRED_COINS[0]!,
  key: "unlisted",
  coinType: `0x${"a".repeat(64)}::coin::TOKEN`,
  name: "Unlisted coin",
  symbol: "TOKEN",
  decimals: 0,
  metadataAvailable: false,
  atoms: 9007199254740993n,
  amount: 9007199254740992,
  value: null,
  price: null,
  iconUrl: null,
  presale: {
    presaleId: "sale",
    venue: "",
    trading: false,
    inPresale: true,
    multiple: null,
  },
};

async function mount(
  t: import("node:test").TestContext,
  props: Parameters<typeof TokenPickerBody>[0],
) {
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(<TokenPickerBody {...props} />));
  return container;
}
async function search(container: HTMLElement, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
}

test("vesting accepts unlisted, unpriced, metadata-free and presale coins with exact accessible balances", async (t) => {
  const picks: WalletCoinView[] = [];
  const twin = {
    ...UNLISTED,
    key: "twin",
    coinType: `0x${"b".repeat(64)}::coin::TOKEN`,
  };
  const container = await mount(t, {
    current: null,
    wallet: [UNLISTED, twin],
    balancesKnown: true,
    pins: [],
    hidden: false,
    listCoins: async () => [],
    onPick: (coin) => picks.push(coin),
    purpose: "vesting",
  });
  const rows = [
    ...container.querySelectorAll<HTMLElement>('[role="option"]'),
  ].filter((row) => row.textContent?.includes("TOKEN"));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.getAttribute("aria-disabled") !== "true"));
  assert.ok(
    container.querySelector(
      '[aria-label="Exact balance: 9007199254740993 atoms TOKEN"]',
    ),
  );
  assert.ok(container.querySelector(`[title="${UNLISTED.coinType}"]`));
  assert.ok(container.querySelector(`[title="${twin.coinType}"]`));
  assert.equal(
    container
      .querySelector('input[role="combobox"]')
      ?.getAttribute("maxlength"),
    "512",
  );
  await act(async () => rows[0]!.click());
  assert.equal(picks[0]?.coinType, UNLISTED.coinType);
});
test("swap keeps its eligibility restrictions for the same coin", async (t) => {
  const container = await mount(t, {
    current: PUBLIC_PREFERRED_COINS[0]!,
    wallet: [UNLISTED],
    pins: [],
    hidden: false,
    listCoins: async () => [],
    onPick: () => assert.fail("Unavailable coin selected"),
  });
  const row = [...container.querySelectorAll('[role="option"]')].find((row) =>
    row.textContent?.includes("TOKEN"),
  );
  assert.ok(row);
  assert.equal(row.getAttribute("aria-disabled"), "true");
});
test("a late remote response cannot replace the newest coin search", async (t) => {
  const older = Promise.withResolvers<readonly WalletCoinView[]>();
  const newer = Promise.withResolvers<readonly WalletCoinView[]>();
  const container = await mount(t, {
    current: null,
    wallet: [],
    pins: [],
    hidden: false,
    purpose: "vesting",
    onPick: () => {},
    listCoins: async (query) =>
      query === "old" ? older.promise : query === "new" ? newer.promise : [],
  });
  await search(container, "old");
  await search(container, "new");
  const newest = { ...UNLISTED, key: "new", symbol: "NEW", name: "New answer" };
  await act(async () => newer.resolve([newest]));
  assert.match(container.textContent ?? "", /New answer/);
  await act(async () =>
    older.resolve([{ ...UNLISTED, symbol: "OLD", name: "Old answer" }]),
  );
  assert.match(container.textContent ?? "", /New answer/);
  assert.doesNotMatch(container.textContent ?? "", /Old answer/);
});

test("the coin picker selects the highlighted row with the keyboard", async (t) => {
  const picks: WalletCoinView[] = [];
  const container = await mount(t, {
    current: null,
    wallet: [UNLISTED],
    pins: [],
    hidden: false,
    purpose: "vesting",
    onPick: (coin) => picks.push(coin),
    listCoins: async () => [],
  });
  const input = container.querySelector<HTMLInputElement>(
    'input[role="combobox"]',
  )!;
  await act(async () => {
    input.focus();
    input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  await act(async () =>
    input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  assert.equal(picks.length, 1);
  assert.equal(picks[0]?.coinType, UNLISTED.coinType);
});

test("vesting resolves case-sensitive full types without Swap search normalization", async (t) => {
  const queries: (string | null)[] = [];
  const container = await mount(t, {
    current: null,
    wallet: [],
    pins: [],
    hidden: false,
    purpose: "vesting",
    onPick: () => {},
    listCoins: async (query) => {
      queries.push(query);
      return [];
    },
  });
  await search(container, "  0x2::sui::SUI  ");
  assert.equal(queries.at(-1), "0x2::sui::SUI");
  await search(container, "0x2::sui::sui");
  assert.equal(queries.at(-1), "0x2::sui::sui");
});


test("vesting catalog balances stay unavailable until a successful wallet read", async (t) => {
  const container = await mount(t, {
    current: null, wallet: [], pins: [], hidden: false,
    listCoins: async () => PUBLIC_PREFERRED_COINS, onPick: () => {}, purpose: "vesting",
  });
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
  assert.match(container.textContent!, /Balance unavailable/);
  assert.equal(container.querySelector('[aria-label^="Exact balance:"]'), null);
});


test("hidden vesting balances never expose numeric text, titles or exact-balance labels", async t => {
  const picks: WalletCoinView[] = [];
  const container = await mount(t, {
    current: null, wallet: [UNLISTED], balancesKnown: true, pins: [], hidden: true,
    listCoins: async () => [], onPick: coin => picks.push(coin), purpose: "vesting",
  });
  assert.equal(container.querySelector('[aria-label^="Exact balance:"]'), null);
  assert.doesNotMatch(container.innerHTML, /900719925474099|9[,.]007/);
  assert.match(container.textContent!, /Balance hidden/);
  const row = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(row => row.textContent?.includes("TOKEN"))!;
  await act(async () => row.click());
  assert.equal(picks[0]?.atoms, UNLISTED.atoms, "privacy changes presentation, not the selected coin balance");
});
