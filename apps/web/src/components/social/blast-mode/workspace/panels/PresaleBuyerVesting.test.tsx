import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { ToastProvider } from "#web/components/blast-ui/Toasts.tsx";
import type { CommitKit } from "#web/components/social/commit/commit-kit.ts";
import { createWorkspaceStore } from "../model";
import type { ClaimPath, ClaimTarget } from "../../../claim/claims";
import {
  presaleAsset,
  presaleFacts,
  presaleDetail,
  presaleViewer,
} from "../../../../../../test/fixtures/workspace/presale-fixtures.ts";
import { waitFor } from "../../../../../../test/fixtures/social/test-dom.ts";
import type { SocialPresaleDetail } from "@blast/core/modules/social/contracts/presales.ts";

let PresaleContent: typeof import("./PresaleContent").PresaleContent;
let PresaleSummary: typeof import("./PresaleSummary").PresaleSummary;
let PresaleClaim: typeof import("./PresaleClaim").PresaleClaim;

type BuyerTerms = NonNullable<SocialPresaleDetail["terms"]>["buyer_vesting"];
const vested: BuyerTerms = { duration_ms: "2592000000", cliff_ms: "604800000" };
function detailWithBuyer(buyer: BuyerTerms): SocialPresaleDetail {
  const detail = presaleDetail("trading");
  return { ...detail, terms: { ...detail.terms!, buyer_vesting: buyer } };
}
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

async function mount(children: ReactNode | (() => ReactNode)) {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', {
    url: "https://blast.test", pretendToBeVisual: true,
  });
  Object.assign(dom.window, { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  dom.window.HTMLElement.prototype.getAnimations = () => [];
  dom.window.HTMLElement.prototype.animate = () => ({ cancel() {} }) as unknown as Animation;
  Object.assign(globalThis, {
    window: dom.window, self: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, ResizeObserver: ResizeObserverStub, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  ({ PresaleContent } = await import("./PresaleContent"));
  ({ PresaleSummary } = await import("./PresaleSummary"));
  ({ PresaleClaim } = await import("./PresaleClaim"));
  const client = createTestQueryClient();
  const root = createRoot(document.getElementById("mount")!);
  const render = (next: ReactNode) => act(async () => root.render(<QueryProvider client={client}>{next}</QueryProvider>));
  await render(typeof children === "function" ? children() : children);
  return { render, close: async () => { await act(async () => root.unmount()); client.clear(); dom.window.close(); } };
}
const text = () => document.body.textContent!;
function fact(label: string, scope: ParentNode = document): string | undefined {
  return Array.from(scope.querySelectorAll("dt")).find((node) => node.textContent === label)?.nextElementSibling?.textContent ?? undefined;
}

test("the Sale tab links to the full sale page instead of repeating supply, recipient and vesting terms", async () => {
  const detail = { ...detailWithBuyer(vested), buyer_vesting: { schedules: 2, total: "3000000000", claimed: "1000000000", remaining: "2000000000" } };
  const subject = await mount(() => <><PresaleSummary detail={detail} now={detail.presale.start_ms} /><PresaleContent detail={detail} tab="overview" /></>);
  try {
    const link = Array.from(document.querySelectorAll("a")).find((anchor) => anchor.textContent === "Open sale page");
    assert.ok(link, document.body.innerHTML);
    assert.equal(link.getAttribute("href"), `/presale/${detail.presale.presale_id}`);
    // Buyer vesting stays where it matters before signing: the commit facts and the confirmation (tests below).
    assert.doesNotMatch(text(), /Token recipient|Fully vested after|In buyer schedules|Refresh presale/);
  } finally { await subject.close(); }
});

test("active wallet starts buyer vesting even when another linked wallet already claimed", async () => {
  const detail = detailWithBuyer(vested);
  const targets: ClaimTarget[] = [];
  const digest = "123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const actions = { commit: null, authenticated: true, actor_key: "account:A", signIn() {}, claimPath: (async (target) => { targets.push(target); return { status: "confirmed", digest }; }) as ClaimPath };
  const entry = { ...presaleViewer, mine: { ...presaleViewer.mine!, claimed: true, claim_wallet_claimed: false, claim_wallet_participated: true } };
  const subject = await mount(() => <ToastProvider><PresaleClaim detail={detail} entry={entry} status="ready" retry={() => {}} actions={actions} visible /></ToastProvider>);
  try {
    const button = document.querySelector<HTMLButtonElement>("[data-claim='claim_tokens']");
    assert.equal(button?.textContent, "Start your vesting");
    assert.match(text(), /Initial claim starts vesting/);
    assert.match(text(), /Refunds go to your wallet/);
    assert.equal(fact("Awaiting vesting"), "123.450001 KSTL");
    await act(async () => button!.click());
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.done.title, "Your buyer vesting has started");
    assert.equal(targets[0]!.done.sub, "Kestrel · tokens in your vesting schedule");
    assert.match(text(), /initial presale claim is confirmed/);
    assert.match(text(), /vesting balances are updating/);
    assert.equal(document.querySelector("[data-claim]"), null);
    const toast = await waitFor(() => document.querySelector("[data-sonner-toast]"), "the presale claim toast", 750);
    assert.match(toast.textContent!, /Your buyer vesting has started/);
    assert.equal(toast.querySelector("a")?.getAttribute("href"), `https://suiscan.xyz/mainnet/tx/${digest}`);
  } finally { await subject.close(); }
});

for (const [buyer, expected] of [
  [vested, "Over 1 mo · From your claim · 1 wk cliff"],
  [{ ...vested!, cliff_ms: "0" }, "Over 1 mo · From your claim"],
  [null, "None · full allocation at claim"],
  [undefined, "Unavailable · check the presale page"],
] as const) {
  test(`commit discloses ${expected} in direct facts and the action confirmation`, async () => {
    const base = presaleDetail();
    const detail = { ...base, terms: { ...base.terms!, buyer_vesting: buyer } };
    const facts = presaleFacts(detail);
    const snapshot = { facts, at: Date.now(), loading: false, failed: false };
    let sends = 0;
    const kit: CommitKit = {
      signedIn: true, signIn() {}, deposit() {},
      quotes: { peek: () => snapshot, subscribe: () => () => {}, want() {}, fresh: async () => facts, refresh: async () => facts, dispose() {} },
      quotePayment: async () => ({ status: "error" }),
      send: async () => { sends++; return { status: "refused", message: "Local observer refusal" }; },
    };
    const store = createWorkspaceStore();
    store.add({ panel_id: "A", ...presaleAsset });
    const setup = store.getSnapshot().panels.A!.presale;
    const subject = await mount(null);
    const { PresaleCommit } = await import("./PresaleCommit");
    await subject.render(<PresaleCommit asset={presaleAsset} setup={{ ...setup, commitment: { ...setup.commitment, amount: "100" } }} onSetupChange={() => {}} visible actions={{ authenticated: true, actor_key: "account:A", signIn() {}, confirmation: { status: "ready", enabled: true }, commit: kit }} detail={detail} detail_status="ready" />);
    try {
      assert.equal(fact("Buyer vesting"), expected);
      const submit = document.querySelector<HTMLButtonElement>("[data-presale-submit]")!;
      assert.equal(submit.disabled, false, text());
      await act(async () => submit.click());
      assert.equal(sends, 0);
      const dialog = document.querySelector("[role='dialog']");
      assert.ok(dialog, document.body.innerHTML);
      assert.equal(fact("Buyer vesting", dialog), expected);
      await act(async () => document.querySelector<HTMLButtonElement>("[data-action-cancel]")!.click());
      assert.equal(sends, 0);
    } finally { await subject.close(); }
  });
}

test("buyer schedule takes priority over account claim flags and links remaining or completed balances", async () => {
  const schedule = { schedule_id: `0x${"9".repeat(64)}`, beneficiary: `0x${"8".repeat(64)}`, total: "123450001000", claimed: "23450001000", remaining: "100000000000" };
  const entry = { ...presaleViewer, mine: { ...presaleViewer.mine!, claimed: true, claim_wallet_participated: false, buyer_vesting: schedule } };
  const actions = { commit: null, authenticated: true, actor_key: "account:A", signIn() {} };
  const subject = await mount(() => <PresaleClaim detail={detailWithBuyer(undefined)} entry={entry} status="ready" retry={() => {}} actions={actions} visible />);
  try {
    assert.equal(fact("Claimed to date"), "23.450001 KSTL");
    assert.equal(fact("Unclaimed"), "100 KSTL");
    const link = document.querySelector("a")!;
    assert.equal(link.textContent, "View schedule and claim");
    assert.equal(link.getAttribute("href"), `/vesting/${schedule.schedule_id}`);
    assert.match(text(), /Blast wallet/);
    assert.equal(document.querySelector("[data-claim]"), null);
    await subject.render(<PresaleClaim detail={detailWithBuyer(vested)} entry={{ ...entry, mine: { ...entry.mine, buyer_vesting: { ...schedule, claimed: schedule.total, remaining: "0" } } }} status="ready" retry={() => {}} actions={actions} visible />);
    assert.equal(fact("Unclaimed"), "0 KSTL");
    assert.equal(document.querySelector("a")?.textContent, "View completed schedule");
  } finally { await subject.close(); }
});

test("buyer claim availability respects active-wallet participation, known allocation, and initial claim", async () => {
  const detail = detailWithBuyer(vested);
  const actions = { commit: null, authenticated: true, actor_key: "account:A", signIn() {}, claimPath: (async () => ({ status: "failed", code: "rejected" })) as ClaimPath };
  const view = (mine: NonNullable<typeof presaleViewer.mine>, visible = true) => <PresaleClaim detail={detail} entry={{ ...presaleViewer, mine }} status="ready" retry={() => {}} actions={actions} visible={visible} />;
  const base = { ...presaleViewer.mine!, claim_wallet_participated: false };
  const subject = await mount(() => view(base));
  try {
    assert.match(text(), /backed by another linked wallet/);
    assert.equal(document.querySelector("[data-claim]"), null);
    await subject.render(view({ ...base, claim_wallet_participated: true, claim_wallet_claimed: true }));
    assert.match(text(), /initial presale claim is confirmed/);
    assert.equal(document.querySelector("[data-claim]"), null);
    for (const claimable_tokens of [undefined, null, "0"]) {
      await subject.render(view({ ...base, claim_wallet_participated: true, claimable_tokens }));
      assert.equal(document.querySelector("[data-claim]"), null);
      assert.equal(fact("Awaiting vesting"), claimable_tokens === "0" ? "0 KSTL" : "Unavailable");
    }
    await subject.render(view({ ...base, claim_wallet_participated: true }, false));
    assert.equal(document.querySelector<HTMLButtonElement>("[data-claim]")?.disabled, true);
  } finally { await subject.close(); }
});

test("ordinary liquid claims and cancelled refunds retain their claim target semantics", async () => {
  const targets: ClaimTarget[] = [];
  const actions = { commit: null, authenticated: true, actor_key: "account:A", signIn() {}, claimPath: (async (target) => { targets.push(target); return { status: "failed", code: "rejected" }; }) as ClaimPath };
  const subject = await mount(() => <PresaleClaim detail={detailWithBuyer(null)} entry={presaleViewer} status="ready" retry={() => {}} actions={actions} visible />);
  try {
    assert.match(text(), /Claim your tokens and any presale refund together/);
    await act(async () => document.querySelector<HTMLButtonElement>("[data-claim]")!.click());
    assert.equal(targets[0]!.kind, "claim_tokens");
    assert.match(targets[0]!.done.sub, /now in your wallet/);
    const cancelled = { ...detailWithBuyer(vested), presale: { ...presaleDetail("cancelled").presale } };
    await subject.render(<PresaleClaim detail={cancelled} entry={presaleViewer} status="ready" retry={() => {}} actions={actions} visible />);
    assert.match(text(), /Everything you committed comes back/);
    const button = document.querySelector<HTMLButtonElement>("[data-claim]")!;
    assert.equal(button.textContent, "Claim refund");
    await act(async () => button.click());
    assert.equal(targets[1]!.kind, "claim_refund");
    assert.equal(targets[1]!.done.title, "123.450001 USDC refund claimed");
  } finally { await subject.close(); }
});

test("the claim hides personal schedule balances with shell amount privacy", async () => {
  const detail = { ...detailWithBuyer(vested), buyer_vesting: { schedules: 1, total: "123450001000", claimed: "23450001000", remaining: "100000000000" } };
  const subject = await mount(() => <PresaleContent detail={detail} tab="overview" />);
  try {
    document.querySelector("[data-blast-ui]")!.setAttribute("data-amounts", "hidden");
    const mine = { ...presaleViewer.mine!, buyer_vesting: { schedule_id: `0x${"9".repeat(64)}`, beneficiary: `0x${"8".repeat(64)}`, total: "123450001000", claimed: "23450001000", remaining: "100000000000" } };
    await subject.render(<PresaleClaim detail={detail} entry={{ ...presaleViewer, mine }} status="ready" retry={() => {}} actions={{ commit: null, authenticated: true, actor_key: "account:A", signIn() {} }} visible />);
    assert.equal(fact("Claimed to date"), "••••");
    assert.equal(fact("Unclaimed"), "••••");
  } finally { await subject.close(); }
});
