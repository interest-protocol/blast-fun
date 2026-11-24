import { createContext, use, useState, type ReactNode } from "react";
import type { ActionState } from "../../../../src/components/launchpad/transaction/action-machine.ts";
import type { ActionController } from "../../../../src/components/launchpad/transaction/controller.ts";
import type { CurveTradeInput } from "../../../../src/components/launchpad/trade/curve-adapter.ts";
import type { CurveTradeSession } from "../../../../src/components/launchpad/trade/CurveTradeProvider.tsx";

export const sessions: ReturnType<typeof makeSession>[] = [];
function makeController(direction: "buy" | "sell") {
  let state: ActionState<CurveTradeInput> = { phase: "editing", input: { launchId: "0x1", direction, amount: "10", slippageBps: 100n }, attempt: 0, notice: null };
  const listeners = new Set<() => void>();
  let rechecks = 0;
  let submissions = 0;
  const controller: ActionController<CurveTradeInput> = {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onInvalidate: () => () => {}, edit() {}, chooseSigner() {}, cancel() {}, approve() {}, acknowledge() {},
    submit() { submissions += 1; },
    recheck() { rechecks += 1; },
  };
  return { controller, counts: () => ({ rechecks, submissions }),
    ambiguous() {
      state = { phase: "ambiguous", input: state.input, attempt: 1, review: {} as never, digest: "retained-fixture-digest", reason: "submission-unknown", message: "Check this transaction before trading again." };
      for (const listener of listeners) listener();
    },
  };
}
function makeSession() {
  const buy = makeController("buy");
  const sell = makeController("sell");
  const session = {
    controllers: { buy: buy.controller, sell: sell.controller },
    curve: { status: "unavailable", message: "Fixture read" }, balances: null,
    completed: {}, direction: "buy", setDirection() {}, refresh() {},
  } as unknown as CurveTradeSession;
  return { buy, sell, session };
}
const Context = createContext<CurveTradeSession | null>(null);
export function CurveTradeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [instance] = useState(() => { const instance = makeSession(); sessions.push(instance); return instance; });
  return <Context value={instance.session}>{children}</Context>;
}
export function useCurveTrade(): CurveTradeSession {
  return use(Context)!;
}
