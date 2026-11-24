import type { TestContext } from "node:test";
import { installTestDom, setInputValue } from "../test-dom.ts";
import { FIXTURE_COINS } from "./coins-fixture-model.ts";
import type { WalletCoinView } from "#web/components/social/coins/coin-model.ts";
import type { CoinSheetTrading } from "#web/components/social/coins/SwapForm.tsx";

export const swapDom = installTestDom();
Object.assign(swapDom.document, {oninput: null});
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { SwapForm } = await import("#web/components/social/coins/SwapForm.tsx");
const { typedAmount } = await import("#web/components/social/trade/trade-ticket.ts");

export async function mountSwap(t: TestContext, trading: CoinSheetTrading, options: Readonly<{ inCoin?: WalletCoinView; outCoin?: WalletCoinView; fee?: "wallet" | "sponsored" }> = {}) {
  const inCoin = options.inCoin ?? FIXTURE_COINS[1]!;
  const outCoin = options.outCoin ?? FIXTURE_COINS[0]!;
  function Screen() {
    const [field, setField] = useState(() => typedAmount("", inCoin.decimals));
    const [detail, setDetail] = useState(false);
    return <SwapForm active inCoin={inCoin} outCoin={outCoin} field={field} onField={setField}
      detail={detail} onDetail={setDetail} onFlip={setField} onPick={() => undefined}
      hidden={false} walletFee={options.fee ?? "sponsored"} trading={trading} />;
  }
  const container = swapDom.document.createElement("div");
  swapDom.document.body.append(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client, <Screen />)));
  const type = async (value: string) => {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>("input")!;
      setInputValue(input, value);
      input.dispatchEvent(new swapDom.window.Event("input", { bubbles: true }));
    });
  };
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); }); };
  const trade = () => container.querySelector<HTMLButtonElement>("[data-trade]")!;
  const press = async () => { await act(async () => trade().click()); await act(async () => settleQueries(client)); };
  /** Closes the screen early (the cleanup's second unmount is a no-op). */
  const unmount = async () => { await act(async () => root.unmount()); };
  return { container, type, settle, trade, press, act, unmount };
}
