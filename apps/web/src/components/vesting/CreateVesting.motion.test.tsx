import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { installTestDom, setInputValue } from "../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./use-vesting-wallet") return {
      url: 'data:text/javascript,export function useVestingWallet(){return {wallet:null,viewer:{signedIn:false},node:null,busy:false,phase:"idle"}}', shortCircuit: true,
    };
    if (specifier === "next/navigation") return {
      url: 'data:text/javascript,export function useRouter(){return {push(){}}};export function usePathname(){return "/vesting/new"}', shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
});
const { CreateVesting } = await import("./CreateVesting");
hooks.deregister();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { QueryClient } = await import("@tanstack/react-query");

test("schedule mode, cancellation, and checkpoint removal preserve the live draft and focus", async (t) => {
  // Keyboard policy makes this state/focus check deterministic; browser verification covers interpolation.
  document.documentElement.dataset.blastInput = "keyboard";
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); delete document.documentElement.dataset.blastInput; });
  await act(async () => root.render(<QueryProvider client={client}><CreateVesting /></QueryProvider>));
  const click = async (text: string) => {
    const button = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === text)!;
    assert.ok(button, text);
    await act(async () => button.click());
  };
  const fill = async (id: string, text: string) => {
    const input = document.getElementById(id)!;
    await act(async () => { setInputValue(input, text); input.dispatchEvent(new window.Event("input", { bubbles: true })); });
  };
  await fill("vesting-cliff", "7");
  await click("Release dates");
  await fill("vesting-amount-first", "42");
  await click("＋ Add release");
  const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[data-release-row]:not([inert])'));
  assert.equal(rows().length, 2);
  const first = document.getElementById("vesting-amount-first")!;
  const second = rows()[1]!.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  await fill(second.id, "12");
  const remove = rows()[0]!.querySelector<HTMLButtonElement>('button[aria-label="Remove release 1"]')!;
  remove.focus();
  await act(async () => remove.click());
  assert.equal(document.activeElement, second);
  assert.equal(rows().length, 1);
  assert.equal(second.value, "12");
  assert.ok(!first.isConnected || first.closest("[inert]"));
  assert.ok(rows()[0]!.textContent?.includes("Release 1"));
  assert.ok(container.textContent?.includes("Scheduled 12"));
  await click("Linear");
  assert.equal((document.getElementById("vesting-cliff") as HTMLInputElement).value, "7");
  await click("Release dates");
  assert.equal((document.getElementById(second.id) as HTMLInputElement).value, "12");
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Allow cancellation"]')!;
  await act(async () => toggle.click());
  await fill("vesting-refund", "0x123");
  const refund = document.getElementById("vesting-refund") as HTMLInputElement;
  refund.focus();
  await act(async () => toggle.click());
  assert.equal(document.activeElement, toggle);
  assert.ok(refund.closest("[inert]"));
  await act(async () => toggle.click());
  assert.equal(document.getElementById("vesting-refund"), refund);
  assert.equal(refund.value, "0x123");
});
