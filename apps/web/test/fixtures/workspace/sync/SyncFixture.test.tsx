import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { installTestDom } from "../../social/test-dom.ts";

const dom = installTestDom();
dom.window.scrollTo = () => {};
const { act, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith("#web/") ? new URL(`../../../../src/${specifier.slice(5)}`, import.meta.url).href : specifier, context);
} });
const { SyncFixture } = await import("./SyncFixture");
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

test("sync fixture cancels superseded startup reads and ignores an old principal response", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const original = globalThis.fetch;
  const reads: string[] = [];
  const pending = new Map<string, (response: Response) => void>();
  const token = (sub: string) => `header.${btoa(JSON.stringify({ sub }))}.signature`;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/social/me");
    const authorization = new Headers(init?.headers).get("authorization")!;
    reads.push(authorization);
    return new Promise((resolve) => pending.set(authorization, resolve));
  };
  async function answer(sub: string) {
    const resolve = pending.get(`Bearer ${token(sub)}`);
    assert.ok(resolve);
    await act(async () => resolve(Response.json({ account: { account_id: sub, callsign: sub, wallets: [] } })));
  }
  try {
    sessionStorage.setItem("t013-token", token("A"));
    await act(async () => root.render(
      <StrictMode><AppRouterContext value={router as never}><PathnameContext value="/"><SyncFixture /></PathnameContext></AppRouterContext></StrictMode>,
    ));
    assert.deepEqual(reads, [`Bearer ${token("A")}`], "StrictMode cleanup cancels the first deferred startup read");
    sessionStorage.setItem("t013-token", token("B"));
    await act(async () => window.dispatchEvent(new dom.window.Event("t013-auth-refresh")));
    assert.equal(reads.length, 2);
    await answer("B");
    assert.match(container.querySelector('[aria-label="Fixture identity"]')!.textContent!, /ready · B/);
    await answer("A");
    assert.match(container.querySelector('[aria-label="Fixture identity"]')!.textContent!, /ready · B/, "late A cannot replace the active principal");
    sessionStorage.setItem("t013-token", token("C"));
    await act(async () => window.dispatchEvent(new dom.window.Event("t013-auth-refresh")));
    const refused = pending.get(`Bearer ${token("C")}`)!;
    await act(async () => refused(Response.json({ error: "refused" }, { status: 401 })));
    assert.equal(container.querySelector('[aria-label="Fixture identity"]')!.textContent!, "error · guest",
      "A refused active read must remain an error and expose no authenticated account");
  } finally {
    await act(async () => root.unmount());
    sessionStorage.clear();
    globalThis.fetch = original;
    container.remove();
  }
});
