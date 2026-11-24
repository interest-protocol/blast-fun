import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, waitFor } from "../../../test/fixtures/social/test-dom.ts";
import { QueryClient } from "@tanstack/react-query";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";
import { presaleViewerQuery } from "#web/components/social/queries.ts";
import { useViewerPresalesRead } from "./presales-client";
import { ViewerPositionFeedback } from "./ViewerPositionFeedback";
installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const token = async () => null;
const id = `0x${"4".repeat(64)}`;
function Probe() { const read = useViewerPresalesRead([id]); return <ViewerPositionFeedback read={read} />; }

test("personal position exposes pending, error, retry, successful empty and failed cached refresh", async (t) => {
  const response = Promise.withResolvers<Response>();
  let fail = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => String(input).includes("/presales/viewer") ? fail ? Response.json({ error: { code: "service_unavailable" } }, { status: 503 }) : response.promise : Response.json({});
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider signedIn accountId="fixture"><Probe /></SocialViewerProvider></QueryProvider>));
  assert.ok(host.querySelector('[aria-label="Loading your position"]'));
  await act(async () => response.resolve(Response.json({ error: { code: "service_unavailable" } }, { status: 503 })));
  await waitFor(() => /Your position could not load/.test(host.textContent!), "the load error");
  globalThis.fetch = async () => Response.json({ presales: { [id]: { following: [], following_total_usd: "0.00", following_total_atoms: "0", mine: null } }, rows: null });
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  await waitFor(() => host.textContent === "" && !host.querySelector('[aria-label="Loading your position"]'), "the successful empty position after Retry");
  fail = true;
  globalThis.fetch = async () => Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
  await act(async () => client.refetchQueries({ queryKey: presaleViewerQuery(token, [id]).queryKey, exact: true }));
  await waitFor(() => /could not refresh. Showing previous details/.test(host.textContent!), "the failed refresh over cached details");
});
