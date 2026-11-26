import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ProfileInvitesCardView } = await import("./ProfileInvites");

test("the own profile's Invites card shows who joined, copies the link and leads to Invites", async (t) => {
  const writeText = t.mock.fn<(text: string) => Promise<void>>(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<ProfileInvitesCardView callsign="kai_9" loading={false} summary={{ invited: 3, volume_usd: "4820.00", unvalued_trades: 0 }} />));
  assert.equal(container.querySelector("h3")!.textContent, "Invites");
  // Legacy summaries remain supported during rollout.
  assert.match(container.textContent!, /Joined3/);
  assert.match(container.textContent!, /Referred volume\$4,820\.00/);
  assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="Your invite link"]')!.value, `${window.location.host}/?ref=kai_9`);
  assert.equal(container.querySelector('a[href="/invites"]')!.textContent, "See all");
  assert.ok([...container.querySelectorAll("button")].some((button) => button.textContent === "Share invite link" && button.dataset.uiVariant === "primary"));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy your invite link"]')!.click());
  assert.equal(writeText.mock.calls[0].arguments[0], new URL("/?ref=kai_9", window.location.origin).href);
  await act(async () => root.render(<ProfileInvitesCardView callsign="kai_9" loading />));
  assert.equal(container.querySelector('[aria-busy="true"]')?.textContent?.includes("Joined"), true);
  await act(async () => root.render(<ProfileInvitesCardView callsign="kai_9" loading={false} />));
  assert.doesNotMatch(container.textContent!, /Joined/, "a failed count is omitted, not guessed");
  assert.ok(container.querySelector('a[href="/invites"]'));
});

test("reserved link stays bound to the X identity and exact 60% lifetime earnings are visible", async (t) => {
  const writeText = t.mock.fn<(text: string) => Promise<void>>(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const summary = {
    invited: 1,
    volume_usd: "0.00",
    unvalued_trades: 0,
    referral_code: "irenezhao_",
    accounting: {
      assets: [
        {
          coin_type: "0x2::sui::SUI",
          symbol: "SUI",
          decimals: 9,
          volume_atoms: "100000000000",
          revenue_atoms: "1000000000",
          earnings_atoms: "600000000",
        },
      ],
      share_bps: 6000 as const,
      as_of_ms: 1790000000000,
      pending_events: 1,
    },
  };
  await act(async () =>
    root.render(
      <ProfileInvitesCardView
        callsign="irene_changed"
        loading={false}
        summary={summary}
      />,
    ),
  );
  assert.match(container.textContent!, /Referred volume100 SUI/);
  assert.match(container.textContent!, /Blast revenue1 SUI/);
  assert.match(container.textContent!, /Earnings0.6 SUI/);
  assert.match(container.textContent!, /Current referral rate 60%/);
  assert.match(
    container.textContent!,
    /Manual payments each month/,
  );
  assert.match(container.textContent!, /Totals exclude activity under review/);
  const totalsDate = container.querySelector("time")!;
  assert.equal(totalsDate.closest("button"), null);
  assert.equal(totalsDate.getAttribute("title"), null);
  assert.match(totalsDate.parentElement!.textContent!, /^Lifetime totals through /);
  assert.ok(totalsDate.parentElement!.textContent!.trim().split(/\s+/).length <= 6);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Copy your invite link"]')!
      .click(),
  );
  assert.equal(
    writeText.mock.calls[0].arguments[0],
    new URL("/?ref=irenezhao_", window.location.origin).href,
  );
  const tiny = {
    ...summary,
    accounting: {
      ...summary.accounting,
      assets: [{ ...summary.accounting.assets[0], earnings_atoms: "1" }],
    },
  };
  await act(async () =>
    root.render(
      <ProfileInvitesCardView
        callsign="irene_changed"
        loading={false}
        summary={tiny}
      />,
    ),
  );
  assert.match(container.textContent!, /0.000000001 SUI/);
  await act(async () =>
    root.render(
      <ProfileInvitesCardView
        callsign="irene_changed"
        loading={false}
        summary={{
          ...summary,
          accounting: { ...summary.accounting, as_of_ms: null, assets: [] },
        }}
      />,
    ),
  );
  assert.match(container.textContent!, /Updating referral earnings/);
  assert.doesNotMatch(container.textContent!, /Blast revenue0/);
  for (const [pending_events, message] of [[0, "No referral earnings yet"], [1, "Checking referral earnings"]] as const) {
    await act(async () => root.render(<ProfileInvitesCardView
      callsign="irene_changed"
      loading={false}
      summary={{ ...summary, accounting: { ...summary.accounting, assets: [], pending_events } }}
    />));
    assert.ok(container.textContent!.includes(message));
    assert.equal(container.textContent!.includes("Earn from trade and presale fees."), pending_events === 0);
    assert.doesNotMatch(container.textContent!, /Totals exclude activity under review/);
  }
});
