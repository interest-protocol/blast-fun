import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, settleQueries } = await import("#web/lib/query/test-client.ts");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { SocialViewerProvider } = await import("#web/components/social/SignInGate.tsx");
const { FollowedTape } = await import("./FollowedTape.tsx");

test("the tape reads once, after the callsign arrives", async (t) => {
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return Response.json({ error: "unavailable" }, { status: 503 });
  });
  const token = async () => "token";
  const render = async (callsign: string | null) => {
    await act(async () => {
      root.render(<QueryProvider client={client}><SocialViewerProvider signedIn callsign={callsign} getAccessToken={token}><FollowedTape window="24h" nowMs={1} /></SocialViewerProvider></QueryProvider>);
      await settleQueries(client);
    });
  };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });
  await render(null);
  assert.equal(calls.length, 0);
  await render("kai");
  assert.equal(calls.length, 1);
  await render("kai");
  assert.equal(calls.length, 1);
});
