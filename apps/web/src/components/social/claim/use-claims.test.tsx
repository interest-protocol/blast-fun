import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { ClaimButton } from "./ClaimButton.tsx";
import { FeedOverlaysProvider } from "../feed-ui/shell-bridge";
import { SocialViewerProvider } from "../SignInGate";
import type { ClaimOutcome, ClaimPath, ClaimTarget } from "./claims";
import { useClaimsController } from "./use-claims";

const target: ClaimTarget = { key: "refund:sale", kind: "claim_refund", presaleId: "sale", done: { title: "Refunded", sub: "Sale" } };
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

test("one shell shares claims across screens, navigation and nested overlays, then resets for another account", async () => {
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  close = async () => { await act(async () => root.unmount()); container.remove(); client.clear(); };
  let answer!: (outcome: ClaimOutcome) => void;
  let signal: AbortSignal | undefined;
  let calls = 0;
  let notifications = 0;
  const path: ClaimPath = (_target, given) => {
    calls++;
    signal = given;
    return new Promise((resolve) => { answer = resolve; });
  };
  function Screen({ label }: Readonly<{ label: string }>) {
    const claims = useClaimsController(path, () => { notifications++; });
    return <div data-screen={label}><ClaimButton claims={claims} label="Claim refund" target={target} /></div>;
  }
  const render = async (owner: string, first = true, next = false) => {
    await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider callsign={owner} signedIn>
      <FeedOverlaysProvider value={{ claimPath: path }}>
        {first ? <Screen label="portfolio" /> : null}
        <FeedOverlaysProvider value={{}}><Screen label={next ? "new page" : "sale"} /></FeedOverlaysProvider>
      </FeedOverlaysProvider>
    </SocialViewerProvider></QueryProvider>));
  };
  await render("alice");
  await act(async () => {
    for (const button of container.querySelectorAll<HTMLButtonElement>("[data-claim]")) button.click();
  });
  assert.equal(calls, 1, "simultaneous presses use one transaction");
  assert.equal(container.querySelectorAll('[aria-busy="true"]').length, 2);
  await render("alice", false);
  assert.equal(signal?.aborted, false, "leaving the initiating screen does not abort the shared claim");
  await act(async () => answer({ status: "confirmed", digest: "digest" }));
  assert.equal(notifications, 1, "only the initiating screen produces a settlement notification");
  assert.equal(container.querySelector("[data-claim]") === null, true);
  await render("alice", true, true);
  assert.equal(container.querySelectorAll("[data-claim-complete]").length, 2, "new screens inherit the confirmation over stale rows");
  await render("bob");
  assert.equal(container.querySelectorAll("[data-claim]").length, 2, "another viewer starts with fresh claim state even if the path is stable");
});

test("claiming from a presale side box completes in place while its private read remains stale", async () => {
  const { fixtureDetail, fixtureViewer, FIXTURE_NOW } = await import("../../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
  const { SideBox } = await import("#web/components/presale-pages/SaleAside.tsx");
  const { queryKeys } = await import("#web/lib/query/keys.ts");
  for (const key of ["hlcn", "kstl"]) {
    await close?.();
    const detail = fixtureDetail(key);
    const sale = detail.presale;
    const entry = { ...fixtureViewer()[sale.presale_id]!, mine: { ...fixtureViewer()[sale.presale_id]!.mine!, claimed: false } };
    const response = { rows: [sale], presales: { [sale.presale_id]: entry } };
    const client = createTestQueryClient({ queries: { staleTime: Infinity, gcTime: Infinity } });
    client.setQueryData([...queryKeys.me.presaleViewerAll, "mine"], response);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    close = async () => { await act(async () => root.unmount()); container.remove(); client.clear(); };
    const path: ClaimPath = async () => ({ status: "confirmed", digest: "digest" });
    function Aside() {
      const claims = useClaimsController(path);
      return <div data-side-box=""><SideBox claims={claims} detail={detail} entry={entry} now={FIXTURE_NOW} /></div>;
    }
    await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider callsign="alice" signedIn>
      <FeedOverlaysProvider value={{ claimPath: path }}><Aside /></FeedOverlaysProvider>
    </SocialViewerProvider></QueryProvider>));
    assert.equal(container.querySelectorAll("[data-claim]").length, 1);
    await act(async () => container.querySelector<HTMLButtonElement>("[data-side-box] [data-claim]")!.click());
    assert.equal(container.querySelector("[data-claim]") === null, true, "the side box removes the completed action");
    assert.match(container.textContent ?? "", key === "hlcn" ? /Refunded/ : /Claimed/);
    assert.equal(response.presales[sale.presale_id]!.mine.claimed, false, "the old indexed response remains unchanged");
  }
});
