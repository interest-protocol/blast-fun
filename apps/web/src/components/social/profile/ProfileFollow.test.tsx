import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { SocialViewerProvider } = await import("../SignInGate");
const { ViewerStateStore } = await import("../viewer-state-store");
const { ProfileFollow } = await import("./IdentityCard");
const { PostFollow } = await import("../post/PostFollow");
const { ToastProvider } = await import("#web/components/blast-ui/Toasts.tsx");
const { toast } = await import("sonner");

for (const Follow of [ProfileFollow, PostFollow]) {
  test(`${Follow.name}: successful follow and unfollow update the button without toasts`, async (t) => {
    let following = false;
    t.mock.method(ViewerStateStore.prototype, "want", () => undefined);
    t.mock.method(ViewerStateStore.prototype, "following", () => following);
    const write = t.mock.method(ViewerStateStore.prototype, "setFollowing", async (_target: Parameters<typeof ViewerStateStore.prototype.setFollowing>[0], next: boolean) => {
      following = next;
      return { status: "ok" as const };
    });
    const showToast = t.mock.method(toast, "custom", () => 0);
    const client = createTestQueryClient();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    });
    await act(async () => root.render(
      <QueryProvider client={client}>
        <ToastProvider>
          <SocialViewerProvider callsign="nova" signedIn><Follow callsign="kai" /></SocialViewerProvider>
        </ToastProvider>
      </QueryProvider>,
    ));
    const button = container.querySelector("button")!;
    assert.equal(button.getAttribute("aria-pressed"), "false");
    for (const next of [true, false]) {
      await act(async () => button.click());
      assert.equal(write.mock.calls.at(-1)!.arguments[1], next);
      assert.equal(button.getAttribute("aria-pressed"), String(next));
      assert.equal(button.getAttribute("aria-busy"), null);
      assert.equal(showToast.mock.callCount(), 0);
    }
  });
}

test("a rejected follow clears busy and lets the user retry", async (t) => {
  t.mock.method(ViewerStateStore.prototype, "following", () => false);
  const original = ViewerStateStore.prototype.setFollowing;
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  ViewerStateStore.prototype.setFollowing = async () => { attempts++; throw new Error("offline"); };
  globalThis.fetch = async () => new Response(null, { status: 503 });
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<QueryProvider client={client}>
      <SocialViewerProvider callsign="nova" signedIn><ProfileFollow callsign="kai" /></SocialViewerProvider>
    </QueryProvider>));
    const button = container.querySelector("button")!;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await act(async () => button.click());
      assert.equal(attempts, attempt);
      assert.equal(button.getAttribute("aria-busy"), null);
      assert.match(container.querySelector('[role="alert"]')!.textContent, /Try again/);
    }
  } finally {
    await act(async () => root.unmount());
    client.clear(); container.parentNode?.removeChild(container);
    ViewerStateStore.prototype.setFollowing = original; globalThis.fetch = originalFetch;
  }
});

test("an unknown relationship cannot write; a failed read retries only the status", async (t) => {
  let resolveRead!: (response: Response) => void;
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    return new Promise<Response>(resolve => { resolveRead = resolve; });
  });
  const write = t.mock.method(ViewerStateStore.prototype, "setFollowing", async () => ({ status: "ok" as const }));
  const client = createTestQueryClient();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider callsign="nova" signedIn getAccessToken={async () => "test-token"}><ProfileFollow callsign="kai" /></SocialViewerProvider></QueryProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  let button = container.querySelector("button")!;
  assert.equal(button.disabled, true);
  assert.match(button.getAttribute("aria-label")!, /Checking follow status/);
  await act(async () => button.click());
  assert.equal(write.mock.callCount(), 0);
  await act(async () => resolveRead(Response.json({ error: { code: "service_unavailable" } }, { status: 503 })));
  button = container.querySelector("button")!;
  assert.equal(button.disabled, false);
  assert.match(button.textContent!, /Retry status/);
  await act(async () => button.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.equal(reads, 2);
  assert.equal(write.mock.callCount(), 0);
  await act(async () => resolveRead(Response.json({ reactions: {}, follows: { accounts: { kai: true }, presales: {} }, follows_you: {}, backers: {} })));
  button = container.querySelector("button")!;
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.match(button.textContent!, /Following/);
});

test("session restoration never offers a sign-in follow link", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<SocialViewerProvider signedIn={false} sessionPending><ProfileFollow callsign="kai" /></SocialViewerProvider>));
  assert.equal(container.querySelector("a"), null);
  assert.equal(container.querySelector("button")!.disabled, true);
});
