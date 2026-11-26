import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
import { useQuery } from "@tanstack/react-query";
import type { SocialRewardsPage } from "@blast/core/web/contracts/rewards.ts";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { rewardsSummaryQuery } from "../queries";

const noToken = async () => null;

test("an account switch never hands the new account the old account's payouts, even for one render", async () => {
  const client = createTestQueryClient({ queries: { staleTime: Infinity, gcTime: Infinity } });
  const alicePage = { coins: [], payouts: [], next_cursor: null } as unknown as SocialRewardsPage;
  client.setQueryData(rewardsSummaryQuery(noToken, "alice").queryKey, alicePage);
  const seen: { callsign: string; page: SocialRewardsPage | undefined }[] = [];
  // The payout toasts read the summary under the viewer they key their "seen" mark by.
  function Probe({ callsign }: Readonly<{ callsign: string }>) {
    const read = useQuery({ ...rewardsSummaryQuery(noToken, callsign), enabled: false }, client);
    seen.push({ callsign, page: read.data });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<QueryProvider client={client}><Probe callsign="alice" /></QueryProvider>));
  await act(async () => root.render(<QueryProvider client={client}><Probe callsign="bob" /></QueryProvider>));
  assert.equal(seen.find((render) => render.callsign === "alice")?.page, alicePage);
  assert.deepEqual(seen.filter((render) => render.callsign === "bob" && render.page !== undefined), []);
  await act(async () => root.unmount());
  container.remove();
  client.clear();
});
