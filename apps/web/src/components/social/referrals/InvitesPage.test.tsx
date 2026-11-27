import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, waitFor } from "../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { createTestQueryClient, settleQueries } = await import("#web/lib/query/test-client.ts");
const { SocialViewerProvider } = await import("../SignInGate");
const { InvitesPage } = await import("./InvitesPage");
const { ReferralAccounting } = await import("./ReferralAccounting");
test("referral amounts hide unavailable figures and copy readable amounts with the full coin type", async (t) => {
  const coinType = `0x${"a".repeat(64)}::usd::USD`;
  const usd = { coin_type: coinType, symbol: "USD", decimals: 6, volume_atoms: "1234567", revenue_atoms: "123", earnings_atoms: "47" };
  const other = { ...usd, coin_type: `0x${"b".repeat(64)}::usd::USD`, symbol: "usd" };
  const missing = { ...usd, coin_type: `0x${"c".repeat(64)}::other::OTHER`, symbol: "OTHER", decimals: null, volume_atoms: "999999999" };
  const copied: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { copied.push(value); } },
  });
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
  const accounting = { assets: [usd, other, missing], as_of_ms: 1, share_bps: 3000 as const, pending_events: 0 };
  await act(async () => root.render(<ReferralAccounting accounting={accounting} compact />));
  const first = container.querySelector<HTMLButtonElement>('button[aria-label="Inspect 1.234567 USD. 0xaaaa…aaaa::usd::USD"]')!;
  assert.ok(first);
  assert.ok(container.querySelector('button[aria-label="Inspect 1.234567 usd. 0xbbbb…bbbb::usd::USD"]'));
  await act(async () => first.click());
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.doesNotMatch(dialog.textContent!, new RegExp(coinType));
  const copy = dialog.querySelector<HTMLButtonElement>('button[aria-label="Copy full amount"]')!;
  await act(async () => copy.click());
  assert.deepEqual(copied, [`1.234567 USD\n${coinType}`]);
  const unavailable = [...container.querySelectorAll("dd")].filter((cell) => cell.textContent === "Amount unavailable");
  assert.equal(unavailable.length, 3);
  assert.ok(unavailable.every((cell) => cell.querySelector("button") === null));
  assert.doesNotMatch(container.innerHTML, /999999999| atoms/);
  for (const button of container.querySelectorAll("button[aria-label]")) {
    assert.ok(button.getAttribute("aria-label")!.split(/\s+/).length <= 6);
  }
  assert.doesNotMatch(container.textContent!, /Current referral rate/);
  await act(async () => root.render(<ReferralAccounting accounting={accounting} />));
  assert.match(container.textContent!, /Current referral rate 30%/);
  await act(async () => root.render(<ReferralAccounting accounting={{ ...accounting, share_bps: 6000 }} />));
  assert.match(container.textContent!, /Current referral rate 60%/);
  assert.ok([...container.querySelectorAll("dt")].some((label) => label.textContent === "Earnings"));
});

test("the private referral page renders one entry per month and links only confirmed SUI payments", async (t) => {
  const digest = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
  const reads: string[] = [];
  let failed = true;
  let empty = false;
  let holdRetry = false;
  const pendingRetry = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request) => {
    reads.push(String(path));
    if (holdRetry) return pendingRetry.promise;
    if (failed) return Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
    if (empty) return Response.json({ months: [] });
    return Response.json({
      months: [
        { month: "2026-12", revenue_atoms: null, earnings_atoms: null, share_bps: null, payment: null },
        { month: "2026-11", revenue_atoms: "21", earnings_atoms: "7", share_bps: 3429, payment: null },
        { month: "2026-10", revenue_atoms: "1000000000", earnings_atoms: "300000000", share_bps: 3000, payment: { amount_atoms: "500000000", digest } },
        { month: "2026-09", revenue_atoms: "0", earnings_atoms: "0", share_bps: 6000, payment: null },
      ],
    });
  });
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  const render = (signedIn: boolean, sessionPending = false) => (
    <QueryProvider client={client}>
      <SocialViewerProvider signedIn={signedIn} callsign={signedIn ? "kai_9" : null} sessionPending={sessionPending}>
        <InvitesPage />
      </SocialViewerProvider>
    </QueryProvider>
  );

  await act(async () => root.render(render(false, true)));
  assert.ok(container.querySelector('[aria-label="Loading referral payments"]'));
  assert.equal(reads.length, 0);
  await act(async () => root.render(render(true)));
  await act(async () => settleQueries(client));
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /Referral payments couldn’t load/);
  assert.match(container.querySelector(".err-code")!.textContent!, /service_unavailable/);
  failed = false;
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")!.click();
    await settleQueries(client);
  });
  const statement = container.querySelector('[aria-label="Monthly referral payments"]')!;
  const months = [...statement.querySelectorAll("li")];
  const fields = months.map((row) => [...row.querySelectorAll("h2, p, dt, dd")].map((field) => {
    const value = field.querySelector("[data-amount-fit] > span") ?? field;
    return value.textContent?.trim().replaceAll("\u00a0", " ");
  }));
  assert.deepEqual(fields, [
    ["December 2026", "Not yet paid", "SUI contributed", "—", "Your share", "—"],
    ["November 2026", "Not yet paid", "SUI contributed", "0.000000021 SUI", "Your share · 34.29%", "0.000000007 SUI"],
    ["October 2026", "Paid", "SUI contributed", "1 SUI", "Your share · 30%", "0.3 SUI", "0.5 SUI received"],
    ["September 2026", "No payout due", "SUI contributed", "0 SUI", "Your share · 60%", "0 SUI"],
  ]);
  const links = statement.querySelectorAll("a");
  assert.equal(links.length, 1);
  assert.equal(links[0].textContent?.trim(), "Transaction");
  assert.equal(links[0].getAttribute("href"), `https://suiscan.xyz/mainnet/tx/${digest}`);
  assert.equal(container.querySelector("h1")?.textContent, "Invites");
  assert.equal(container.querySelector('[data-back-bar] a')?.getAttribute("href"), "/@kai_9");
  assert.ok(reads.every((url) => url.endsWith("/me/referrals?view=monthly")));
  assert.doesNotMatch(container.textContent!, /People you invited|4,820/);

  const refresh = () => act(async () => {
    await client.refetchQueries({ queryKey: queryKeys.me.referralMonths("kai_9") });
    await settleQueries(client);
  });
  empty = true;
  await refresh();
  assert.match(container.textContent!, /No referral payments yet/);
  failed = true;
  await refresh();
  assert.doesNotMatch(container.textContent!, /No referral payments yet/);
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /Referral payments couldn’t load/);
  const retry = container.querySelector<HTMLButtonElement>('[role="alert"] button')!;
  assert.equal(retry.textContent, "Try again");
  holdRetry = true;
  await act(async () => retry.click());
  await waitFor(() => retry.getAttribute("aria-busy") === "true", "the retry to be marked busy");
  assert.equal(retry.disabled, true);
  await act(async () => {
    pendingRetry.resolve(Response.json({ months: [] }));
    await settleQueries(client);
  });
  assert.match(container.textContent!, /No referral payments yet/);

  await act(async () => root.render(render(false)));
  assert.equal(container.querySelector('[aria-label="Monthly referral payments"]'), null);
  assert.match(container.textContent!, /Sign in to see your invites/);
});
