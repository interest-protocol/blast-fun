import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";
const { document } = installTestDom();
const globals = globalThis as unknown as { creationWallet: Record<string, unknown> };
globals.creationWallet = { wallet: null, walletLoading: true, viewer: { signedIn: false, sessionPending: true }, node: null, busy: false, fee: null };
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./use-vesting-wallet") return { shortCircuit: true, url: "data:text/javascript,export function useVestingWallet(){return globalThis.creationWallet}" };
  if (specifier === "next/navigation") return { shortCircuit: true, url: 'data:text/javascript,export function useRouter(){return {push(){}}};export function usePathname(){return "/vesting/new"}' };
  return next(specifier, context);
} });
const { CreateVesting } = await import("./CreateVesting");
hooks.deregister();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { QueryClient } = await import("@tanstack/react-query");

test("restoring a signed-in session never offers sign-in; helpers settle without example data", async t => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const render = () => root.render(<QueryProvider client={client}><CreateVesting /></QueryProvider>);
  t.after(async () => { await act(() => root.unmount()); client.clear(); container.remove(); });
  await act(render);
  assert.doesNotMatch(container.textContent!, /Sign in/);
  assert.ok(container.querySelector('[aria-label="Restoring your session"]'));
  assert.ok(container.querySelector('[aria-label="Checking network fee"]'));
  const helpers = container.querySelector('[aria-label="Restoring your wallet"]')!.parentElement;
  globals.creationWallet = { ...globals.creationWallet, wallet: "fixture-wallet", walletLoading: false, fee: "sponsored", viewer: { signedIn: true, sessionPending: false } };
  client.setQueryData(["blast", "me", "vesting-coins", "fixture-wallet"], []);
  await act(render);
  assert.equal(helpers?.isConnected, true, "helper slot remains mounted without a selected coin");
  assert.ok([...container.querySelectorAll("button")].find(button => button.textContent === "Review vesting" && !button.disabled));
  assert.match(container.textContent!, /Network gas is paid by Blast/);
  assert.doesNotMatch(container.textContent!, /Available 0|Sign in/);
});
