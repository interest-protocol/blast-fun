import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestDom, recordAnimations, testEvent, type TestElement } from "../../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const motion = recordAnimations();
// The test DOM has no text inputs' `oninput`: without it React falls back to old IE's input polyfill (`attachEvent`) when the field takes focus.
// Nor a selection, which React's select events read on a key in a focused field.
Object.assign(document, { oninput: null });
Object.assign(window, { getSelection: () => ({ rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0 }) });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { ShellActionsProvider, useShellAction, useShellActions } = await import("#web/components/blast-ui/shell-actions.tsx");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { SocialViewerProvider } = await import("../SignInGate");
const { SearchSheet } = await import("./SearchSheet");

import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { SocialSearchResponse } from "@blast/core/modules/social/contracts/search.ts";
import type { SocialTradeCoin } from "@blast/core/modules/social/contracts/trades.ts";
import { queryKeys } from "#web/lib/query/keys.ts";

const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const NIMBUS: SocialTradeCoin = { coin_type: `${hex(11)}::nimb::NIMB`, symbol: "NIMB", name: "Nimbus", decimals: 9, icon_url: null, usd_price: "0.0031", presale_id: null };
const ANSWER: SocialSearchResponse = {
  query: "nim",
  presales: [{ presale_id: hex(11), name: "Nimbus", symbol: "NIMB", icon_url: "", phase: "trading" }],
  people: [],
  as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 },
};
function CoinOpener({ opened }: Readonly<{ opened: (string | undefined)[] }>) {
  useShellAction("openCoin", (key) => void opened.push(key));
  const run = useShellActions();
  return <button data-open-search onClick={() => run("openSearch")} type="button">Search</button>;
}

async function mount(t: TestContext, coin: SocialTradeCoin) {
  const opened: (string | undefined)[] = [];
  const pushed: string[] = [];
  const router = { push: (href: string) => void pushed.push(href), replace: () => undefined, prefetch: () => undefined } as unknown as AppRouterInstance;
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const queries = createTestQueryClient({queries: {gcTime: 60_000}});
  queries.setQueryData(queryKeys.prices.history(`coin:${coin.coin_type}`, "24h"), {presale_id: null, coin_type: coin.coin_type, price_usd: "0.0031", points: [], change_24h_bps: null});
  queries.setQueryData(queryKeys.search(""), { ...ANSWER, query: "" });
  queries.setQueryData([...queryKeys.search(""), "coins"], []);
  queries.setQueryData([...queryKeys.search(coin.coin_type), "coins"], [coin]);
  await act(async () =>
    root.render(
      withQueryClient(
        queries,
        <AppRouterContext value={router}>
          <SocialViewerProvider callsign="kaimoreno" signedIn>
            <ShellActionsProvider>
              <CoinOpener opened={opened} />
              <SearchSheet />
            </ShellActionsProvider>
          </SocialViewerProvider>
        </AppRouterContext>,
      ),
    ),
  );
  await act(async () => container.querySelector<HTMLButtonElement>("[data-open-search]")!.click());
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>("[role=combobox]")!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, coin.coin_type);
    input.dispatchEvent(new window.Event("input", {bubbles: true}));
  });
  await act(async () => motion.finishAll());
  t.after(async () => {
    await act(async () => root.unmount());
    queries.clear();
    container.parentNode?.removeChild(container);
  });
  return { opened, pushed };
}

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');
const coinRow = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) => row.textContent.includes("NIMB · $0.0031")) ?? null;

test("a coin without a Blast page is displayed without a wallet sheet action", async (t) => {
  const { opened, pushed } = await mount(t, NIMBUS);
  const row = coinRow() as TestElement | null;
  assert.ok(row, "Nimbus is listed under Coins");
  assert.equal(row.tagName, "DIV");
  assert.equal(row.getAttribute("aria-disabled"), "true");
  await act(async () => row.click());
  const input = document.querySelector<HTMLElement>('input[role="combobox"]') as TestElement;
  await act(async () => void input.dispatchEvent(testEvent("keydown", { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })));
  await act(async () => motion.finishAll());
  assert.deepEqual(opened, []);
  assert.ok(sheet(), "search stays open");
  assert.deepEqual(pushed, [], "no navigation");
});

test("Enter on a Blast launch result closes search and opens the coin page", async (t) => {
  const { opened, pushed } = await mount(t, { ...NIMBUS, launch_id: hex(25) });
  const input = document.querySelector<HTMLElement>('input[role="combobox"]') as TestElement;
  input.focus();
  await act(async () => void input.dispatchEvent(testEvent("keydown", { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })));
  await act(async () => motion.finishAll());
  assert.deepEqual(pushed, [`/coin/${encodeURIComponent(NIMBUS.coin_type)}`]);
  assert.deepEqual(opened, []);
  assert.equal(sheet(), null);
});
