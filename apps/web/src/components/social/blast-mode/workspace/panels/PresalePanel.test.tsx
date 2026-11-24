import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  fixtureTradeQuote,
  fixtureWallet,
} from "../../../../../../test/fixtures/social/trade/trade-fixtures.ts";
import { PUBLIC_BASE_COINS } from "#web/components/social/coins/coin-model.ts";
import type { ClaimPath, ClaimTarget } from "../../../claim/claims";
import { JSDOM } from "jsdom";
import { act, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { notifyShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import type {
  CommitKit,
  CommitFacts,
} from "#web/components/social/commit/commit-kit.ts";
import type { CommitBlastInput } from "#web/components/social/commit/CommitPanel.tsx";
import { createWorkspaceStore } from "../model";
import { WorkspacePresaleDockContext } from "../presale-dock-context";
import { PresalePanel, type PresalePanelProps } from "./PresalePanel";
import {
  presaleAsset,
  presaleDetail,
  presaleFacts,
  presaleViewer,
} from "../../../../../../test/fixtures/workspace/presale-fixtures.ts";

async function mount(
  options: {
    docked?: boolean;
    focus?: boolean;
    reads?: PresalePanelProps["reads"];
    snapshot?: import("#web/components/social/commit/commit-quote.ts").QuoteSnapshot<CommitFacts>;
    sent?: boolean;
  } = {},
) {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div><div id="context"></div></div>', {
    url: "https://blast.test",
  });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.assign(globalThis, {
    window: dom.window,
    // Next's Link (the sale page link) schedules prefetch work on `self`.
    self: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const client = createTestQueryClient();
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...presaleAsset });
  const panel = store.getSnapshot().panels.A!;
  store.patchPanel("A", {
    presale: {
      ...panel.presale,
      commitment: { ...panel.presale.commitment, amount: "123.450001" },
    },
  });
  let facts: CommitFacts | null = presaleFacts();
  let authenticated = true;
  let visible = true;
  let signIns = 0;
  let claimPath: ClaimPath | undefined;
  const sends: CommitBlastInput[] = [];
  let snapshot = options.snapshot ?? {
    facts,
    at: Date.now(),
    loading: false,
    failed: false,
  };
  const listeners = new Set<() => void>();
  let quotePayment: CommitKit["quotePayment"] = async () => ({
    status: "error",
  });
  let fresh: CommitKit["quotes"]["fresh"] = async () => facts;
  const kit: CommitKit = {
    signedIn: true,
    signIn: () => {
      signIns++;
    },
    deposit: () => {},
    quotes: {
      peek: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      want: () => {},
      fresh: (id) => fresh(id),
      refresh: (id) => fresh(id),
      dispose: () => {},
    },
    quotePayment: (request, signal) => quotePayment(request, signal),
    send: async (_, order) => {
      sends.push(order);
      if (options.sent) return { status: "sent", digest: "d" };
      return {
        status: "refused",
        message: "Observer refusal: wallet declined. Nothing was sent.",
      };
    },
  };
  let reads: PresalePanelProps["reads"] = options.reads ?? {
    detail: async () => presaleDetail(),
    viewer: async () => presaleViewer,
  };
  function Subject() {
    const [active, setActive] = useState<string | null>(null);
    const setup = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    ).panels.A!;
    return (
      <QueryProvider client={client}>
        <WorkspacePresaleDockContext value={options.docked ? { target: document.getElementById("context"), activeId: active, open: setActive, close: () => setActive(null) } : null}>
        <PresalePanel
          focus={options.focus}
          panel_id="A"
          asset={setup}
          presale_setup={setup.presale}
          onSetupChange={(presale) => store.patchPanel("A", { presale })}
          effective_visibility={visible}
          actions={{
            commit: kit,
            authenticated,
            confirmation: { status: "ready", enabled: false },
            actor_key: authenticated ? "account:A" : "guest",
            signIn: kit.signIn,
            claimPath,
          }}
          reads={reads}
        />
        </WorkspacePresaleDockContext>
      </QueryProvider>
    );
  }
  const root = createRoot(document.getElementById("mount")!);
  const render = () => act(async () => root.render(<Subject />));
  await render();
  return {
    store,
    sends,
    kit,
    render,
    root,
    setQuotePayment: (next: typeof quotePayment) => {
      quotePayment = next;
    },
    setFresh: (next: typeof fresh) => {
      fresh = next;
    },
    remount: async () => {
      await act(async () => root.render(null));
      await render();
    },
    setClaimPath: (next: ClaimPath | undefined) => {
      claimPath = next;
    },
    setFacts: (next: CommitFacts | null) => {
      facts = next;
    },
    publish: (next: CommitFacts) => {
      facts = next;
      snapshot = { ...snapshot, facts: next, at: Date.now() };
      for (const listener of listeners) listener();
    },
    setSnapshot: (next: typeof snapshot) => {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    setGuest: () => {
      authenticated = false;
    },
    setVisible: (next: boolean) => {
      visible = next;
    },
    setReads: (next: typeof reads) => {
      reads = next;
    },
    signIns: () => signIns,
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      dom.window.close();
    },
  };
}
const submit = () =>
  document.querySelector<HTMLButtonElement>("[data-presale-submit]")!;

test("a wallet at its cap sees the reason and sale facts while its draft is kept", async () => {
  const base = presaleFacts();
  assert.ok(base.sale);
  const facts = {
    ...base,
    sale: { ...base.sale, allowlisted: true },
    viewer: { ...base.viewer, committed: 25, allowlist: { on: true, cap: 25 } },
  };
  const subject = await mount({ snapshot: { facts, at: Date.now(), loading: false, failed: false } });
  try {
    const button = submit();
    assert.equal(button.textContent, "Wallet limit reached");
    assert.equal(button.disabled, true);
    assert.equal(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent, "You’ve already committed your full allocation.");
    assert.equal(document.querySelector("[data-presale-amount]"), null);
    await act(async () => button.click());
    assert.equal(subject.sends.length, 0);

    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Commit details"]')!.click());
    const details = document.querySelector('[aria-label="Commit facts"]');
    assert.match(details?.textContent ?? "", /Buyer vesting/);
    assert.doesNotMatch(details?.textContent ?? "", /Estimated allocation|Network fee/);
    assert.equal(document.querySelector('[aria-label="Commit why"]'), null);

    await act(async () => subject.publish({
      ...facts,
      viewer: { ...facts.viewer, allowlist: { on: true, cap: 200 } },
    }));
    assert.equal(document.querySelector<HTMLInputElement>("[data-presale-amount]")?.value, "123.450001");
    assert.equal(submit().disabled, false);
  } finally {
    await subject.close();
  }
});

test("presale tabs and remount preserve the exact independent draft and one explicit Commit reaches the shell once", async () => {
  const subject = await mount();
  try {
    assert.ok(document.querySelector('[aria-label^="Inspect full Funding target:"]'));
    assert.ok(document.querySelector('[aria-label*="0.000111111111111111"]'));
    const before = subject.store.getSnapshot().panels.A!.coin;
    // Blast mode's presale views are a fixed pair: Sale and Backers.
    assert.deepEqual(
      Array.from(document.querySelectorAll('[role="tab"]'), (tab) => tab.textContent),
      ["Sale", "Backers"],
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[role="tab"][data-tab="people"]')!
        .click(),
    );
    assert.equal(document.querySelector('[role="tab"][aria-selected="true"]')!.textContent, "Backers");
    assert.equal(
      document.querySelector<HTMLInputElement>('[aria-label="Commit amount"]')!
        .value,
      "123.450001",
    );
    await act(async () => {
      submit().click();
      submit().click();
    });
    assert.equal(subject.sends.length, 1);
    assert.equal(subject.sends[0]!.quoteAtoms, "123450001");
    assert.match(document.body.textContent!, /wallet declined/);
    subject.setVisible(false);
    await subject.render();
    subject.setVisible(true);
    await subject.render();
    await subject.remount();
    assert.equal(
      subject.store.getSnapshot().panels.A!.presale.tabs.selected,
      "people",
    );
    assert.equal(
      subject.store.getSnapshot().panels.A!.presale.commitment.amount,
      "123.450001",
    );
    assert.deepEqual(subject.store.getSnapshot().panels.A!.coin, before);
    subject.setGuest();
    await subject.render();
    // A guest still sees the sale's coin, never a placeholder that cannot resolve.
    assert.match(document.querySelector('[aria-label^="Pay with "]')?.getAttribute("aria-label") ?? "", /^Pay with /);
    await act(async () => submit().click());
    assert.equal(subject.signIns(), 1);
    assert.equal(subject.sends.length, 1);
  } finally {
    await subject.close();
  }
});

test("a refreshed sale with a future start refuses Commit even when an old open quote and target look ready", async () => {
  const subject = await mount();
  try {
    const detail = presaleDetail();
    subject.setFacts(
      presaleFacts({
        ...detail,
        presale: {
          ...detail.presale,
          start_ms: Date.now() + 86400000,
          fill_bps: 20000,
        },
      }),
    );
    await act(async () => submit().click());
    assert.equal(subject.sends.length, 0);
    assert.match(
      document.body.textContent!,
      /not open|not taking commitments/i,
    );
    assert.equal(
      subject.store.getSnapshot().panels.A!.presale.commitment.amount,
      "123.450001",
    );
  } finally {
    await subject.close();
  }
});

test("a changed gas payer requires review and a second explicit press while preserving the draft", async () => {
  const subject = await mount();
  try {
    const facts = presaleFacts();
    subject.setFacts({ ...facts, wallet: { ...facts.wallet!, fee: "wallet" } });
    await act(async () => submit().click());
    assert.equal(subject.sends.length, 0);
    assert.match(document.body.textContent!, /network fee payer changed/);
    assert.match(document.body.textContent!, /Paid from your SUI/);
    await act(async () => submit().click());
    assert.equal(subject.sends.length, 1);
    assert.equal(
      subject.store.getSnapshot().panels.A!.presale.commitment.amount,
      "123.450001",
    );
  } finally {
    await subject.close();
  }
});

test("unreadable and newly closed quotes refuse without losing the draft", async () => {
  const subject = await mount();
  try {
    subject.setFacts(null);
    await act(async () => submit().click());
    assert.equal(subject.sends.length, 0);
    assert.match(document.body.textContent!, /could not load/);
    subject.setFacts(presaleFacts(presaleDetail("funded")));
    await act(async () => submit().click());
    assert.equal(subject.sends.length, 0);
    assert.match(document.body.textContent!, /taking commitments|closed/i);
    assert.equal(
      subject.store.getSnapshot().panels.A!.presale.commitment.amount,
      "123.450001",
    );
  } finally {
    await subject.close();
  }
});

test("read failures and unavailable metadata retain the record and retry without showing confirmed empty content", async () => {
  const subject = await mount();
  try {
    subject.setReads({
      detail: async () => {
        throw new Error("offline");
      },
      viewer: async () => presaleViewer,
    });
    await subject.render();
    assert.match(document.body.textContent!, /Presale could not load/);
    assert.doesNotMatch(document.body.textContent!, /No participants/);
    subject.setReads({
      detail: async () => null,
      viewer: async () => presaleViewer,
    });
    await subject.render();
    assert.match(
      document.body.textContent!,
      /Presale information is unavailable/,
    );
    assert.ok(subject.store.getSnapshot().panels.A);
    subject.setReads({
      detail: async () => presaleDetail(),
      viewer: async () => presaleViewer,
    });
    await subject.render();
    assert.ok(document.querySelector('[aria-label^="Inspect full Funding target:"]'));
    assert.equal(
      subject.store.getSnapshot().panels.A!.presale.commitment.amount,
      "123.450001",
    );
  } finally {
    await subject.close();
  }
});

test("a newer shell quote replaces the facts used by the persistent Commit area", async () => {
  const subject = await mount();
  try {
    await act(async () => submit().click());
    assert.equal(subject.sends.length, 1);
    await act(async () =>
      subject.publish(presaleFacts(presaleDetail("cancelled"))),
    );
    assert.equal(submit().disabled, true);
    assert.match(submit().textContent!, /taking commitments|unavailable/i);
  } finally {
    await subject.close();
  }
});

test("a selected conversion uses the matched route fee payer and sealed exact minimum through the final action", async () => {
  const subject = await mount();
  try {
    subject.setQuotePayment(async (request) => ({
      status: "ok",
      httpStatus: 200,
      body: {
        ...fixtureTradeQuote(request, {
          signedIn: true,
          fee: "wallet",
          nowMs: Date.now(),
          wallet: fixtureWallet(),
        }),
        amount_out: "50000000",
        min_out: "49750000",
        route_label: "Controlled SUI to USDC",
      },
    }));
    const panel = subject.store.getSnapshot().panels.A!;
    await act(async () =>
      subject.store.patchPanel("A", {
        presale: {
          ...panel.presale,
          commitment: {
            ...panel.presale.commitment,
            amount: "25.000000001",
            payment_coin_type: PUBLIC_BASE_COINS.find(
              (coin) => coin.symbol === "SUI",
            )!.coinType,
          },
        },
      }),
    );
    await act(async () => delay(350));
    assert.equal(submit().disabled, false);
    const fees = document.querySelector('[aria-label="Commit facts"]')!;
    assert.doesNotMatch(fees.textContent!, /Paid by Blast/);
    assert.match(fees.textContent!, /Paid from your SUI/);
    assert.match(document.body.textContent!, /Controlled SUI to USDC/);
    assert.match(document.body.textContent!, /Minimum commitment49.75 USDC/);
    await act(async () => submit().click());
    assert.equal(subject.sends.length, 1);
    assert.equal(subject.sends[0]!.quoteAtoms, "49750000");
    assert.equal(subject.sends[0]!.paymentSymbol, "SUI");
    assert.ok(subject.sends[0]!.swapQuoteId);
    await subject.remount();
    assert.equal(
      document.querySelector<HTMLInputElement>('[aria-label="Commit amount"]')!
        .value,
      "25.000000001",
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>('[aria-label^="Pay with "]')!.getAttribute("aria-label"),
      "Pay with SUI",
    );
  } finally {
    await subject.close();
  }
});

test("cancelled refunds and trading token claims use the existing path once and retain a refusal", async () => {
  const subject = await mount();
  const claims: ClaimTarget[] = [];
  const path = Object.assign(
    async (target: ClaimTarget) => {
      claims.push(target);
      return { status: "failed" as const, code: "rejected" };
    },
    { kinds: ["claim_refund" as const, "claim_tokens" as const] },
  );
  try {
    subject.setReads({
      detail: async () => presaleDetail("cancelled"),
      viewer: async () => presaleViewer,
    });
    await subject.render();
    assert.equal(
      document.querySelector<HTMLButtonElement>('[data-claim="claim_refund"]')!
        .disabled,
      true,
    );
    subject.setClaimPath(path);
    await subject.render();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-claim="claim_refund"]')!
        .click();
      document
        .querySelector<HTMLButtonElement>('[data-claim="claim_refund"]')!
        .click();
    });
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.presaleId, presaleAsset.presale_id);
    assert.match(document.body.textContent!, /You declined it in your wallet/);
    subject.setReads({
      detail: async () => presaleDetail("trading"),
      viewer: async () => presaleViewer,
    });
    await subject.render();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[data-claim="claim_tokens"]')!
        .click(),
    );
    assert.equal(claims.length, 2);
    assert.equal(claims[1]!.kind, "claim_tokens");
    assert.equal(subject.sends.length, 0);
  } finally {
    await subject.close();
  }
});

test("hiding the panel during a fresh read blocks a late action and missing terms never infer readiness", async () => {
  const subject = await mount();
  let resolve: (facts: CommitFacts | null) => void = () => {};
  subject.setFresh(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  try {
    await act(async () => submit().click());
    assert.equal(submit().getAttribute("aria-busy"), "true");
    subject.setVisible(false);
    await subject.render();
    await act(async () => resolve(presaleFacts()));
    assert.equal(subject.sends.length, 0);
    subject.setVisible(true);
    subject.setReads({
      detail: async () => ({ ...presaleDetail(), terms: null }),
      viewer: async () => presaleViewer,
    });
    await subject.render();
    assert.equal(submit().disabled, true);
    assert.ok(subject.store.getSnapshot().panels.A);
  } finally {
    await subject.close();
  }
});

test("a fresh read publishing to the shell cache still retains changed payer facts for review", async () => {
  const subject = await mount();
  try {
    const facts = presaleFacts();
    subject.setFresh(async () => {
      subject.publish(facts);
      return { ...facts, wallet: { ...facts.wallet!, fee: "wallet" } };
    });
    await act(async () => submit().click());
    assert.equal(subject.sends.length, 0);
    // The tray's Details facts (not its visible meta line) carry the current fee payer.
    const feeRow = Array.from(document.querySelectorAll('[aria-label="Commit facts"] > div')).find(
      (row) => row.querySelector("dt")?.textContent === "Network fee",
    );
    assert.match(feeRow!.querySelector("dd")!.textContent!, /Paid from your SUI/);
    await act(async () => submit().click());
    assert.equal(subject.sends.length, 1);
  } finally {
    await subject.close();
  }
});

test("long commit amounts keep every digit: the field steps its type down by typed length and keeps the exact text", async () => {
  const subject = await mount();
  try {
    for (const [amount, length] of [
      ["123.45", null],
      ["250000.000001", "mid"],
      ["12,500,000.000001", "long"],
    ] as const) {
      const panel = subject.store.getSnapshot().panels.A!;
      await act(async () =>
        subject.store.patchPanel("A", {
          presale: { ...panel.presale, commitment: { ...panel.presale.commitment, amount } },
        }),
      );
      const input = document.querySelector<HTMLInputElement>('[aria-label="Commit amount"]')!;
      assert.equal(input.value, amount);
      assert.equal(input.parentElement!.getAttribute("data-length"), length);
      const max = document.querySelector('[aria-label="Commit all available USDC"]');
      assert.ok(max);
      assert.equal(input.parentElement!.contains(max), false, "Max does not consume the amount field's width");
    }
  } finally {
    await subject.close();
  }
});

test("invalid commitment amounts retain exact text and explain precision without requesting a quote retry or sending", async () => {
  const subject = await mount();
  try {
    for (const [amount, feedback] of [
      ["123.4500001", /USDC supports up to 6 decimal places/],
      ["", /Enter an amount to commit/],
      ["123.invalid", /Enter a valid amount in USDC/],
    ] as const) {
      const panel = subject.store.getSnapshot().panels.A!;
      await act(async () =>
        subject.store.patchPanel("A", {
          presale: {
            ...panel.presale,
            commitment: { ...panel.presale.commitment, amount },
          },
        }),
      );
      await act(async () => submit().click());
      assert.equal(
        subject.sends.length,
        0,
        "Invalid raw amounts must never reach shell send",
      );
      assert.equal(submit().disabled, true);
      if (amount === "") {
        assert.doesNotMatch(document.body.textContent!, feedback);
        assert.equal(document.querySelector('[aria-label="Commit amount"]')!.getAttribute("aria-invalid"), "false");
      } else {
        assert.match(document.body.textContent!, feedback);
      }
      assert.doesNotMatch(
        document.body.textContent!,
        /Retry quote|quote or payment information is unavailable/,
      );
      assert.equal(
        document.querySelector<HTMLInputElement>(
          '[aria-label="Commit amount"]',
        )!.value,
        amount,
      );
      assert.equal(
        subject.store.getSnapshot().panels.A!.presale.commitment.amount,
        amount,
      );
    }
  } finally {
    await subject.close();
  }
});

test("initial presale and quote reads stay pending until ready or failed without misreporting amount or service errors", async () => {
  for (const outcome of ["ready", "quote-error", "detail-error"] as const) {
    let resolve: (detail: ReturnType<typeof presaleDetail>) => void = () => {};
    let reject: (error: Error) => void = () => {};
    const detail = new Promise<ReturnType<typeof presaleDetail>>(
      (done, fail) => {
        resolve = done;
        reject = fail;
      },
    );
    const subject = await mount({
      reads: { detail: async () => detail, viewer: async () => presaleViewer },
      snapshot: { facts: null, at: null, loading: true, failed: false },
    });
    try {
      assert.ok(document.querySelector('[aria-label="Loading presale"]'));
      assert.ok(
        document.querySelector('[aria-label="Loading commitment quote"]'),
      );
      assert.doesNotMatch(
        document.body.textContent!,
        /quote or payment information is unavailable|Retry quote|Enter an amount/i,
      );
      assert.equal(submit().disabled, true);
      if (outcome === "detail-error") {
        await act(async () => {
          reject(new Error("offline"));
          subject.setSnapshot({
            facts: presaleFacts(),
            at: Date.now(),
            loading: false,
            failed: false,
          });
        });
        assert.match(document.body.textContent!, /Presale could not load/);
        assert.doesNotMatch(document.body.textContent!, /Retry quote/);
      } else {
        await act(async () => resolve(presaleDetail()));
        assert.ok(
          document.querySelector('[aria-label="Loading commitment quote"]'),
        );
        assert.doesNotMatch(document.body.textContent!, /Retry quote/);
        await act(async () =>
          subject.setSnapshot({
            facts: outcome === "ready" ? presaleFacts() : null,
            at: Date.now(),
            loading: false,
            failed: outcome !== "ready",
          }),
        );
        assert.equal(
          document.querySelector('[aria-label="Loading commitment quote"]'),
          null,
        );
        if (outcome === "quote-error") {
          assert.match(
            document.body.textContent!,
            /Commitment quote or payment information is unavailable/,
          );
          assert.match(document.body.textContent!, /Retry quote/);
          assert.equal(submit().disabled, true);
          await act(async () =>
            subject.setSnapshot({
              facts: presaleFacts(),
              at: Date.now(),
              loading: false,
              failed: false,
            }),
          );
        }
        assert.equal(submit().disabled, false);
        assert.doesNotMatch(document.body.textContent!, /Retry quote/);
      }
      assert.equal(subject.sends.length, 0);
      assert.equal(
        subject.store.getSnapshot().panels.A!.presale.commitment.amount,
        "123.450001",
      );
    } finally {
      await subject.close();
    }
  }
});

test("incomplete presale terms recover through public retry on the same mounted panel without changing setup or sending", async () => {
  let available = false;
  let detailReads = 0;
  const reads: PresalePanelProps["reads"] = {
    detail: async () => {
      detailReads++;
      return available ? presaleDetail() : { ...presaleDetail(), terms: null };
    },
    viewer: async () => presaleViewer,
  };
  const subject = await mount({ reads });
  try {
    const panel = subject.store.getSnapshot().panels.A!;
    await act(async () =>
      subject.store.patchPanel("A", {
        presale: {
          ...panel.presale,
          commitment: {
            amount: "123.450001",
            payment_coin_type: PUBLIC_BASE_COINS.find(
              (coin) => coin.symbol === "USDC",
            )!.coinType,
            why: "Keep this exact draft",
          },
          tabs: { ...panel.presale.tabs, selected: "activity" },
          navigation: { ...panel.presale.navigation, scroll_top: 37 },
        },
      }),
    );
    const before = subject.store.getSnapshot().panels.A!.presale;
    assert.equal(submit().disabled, true);
    available = true;
    const retry = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry presale",
    );
    assert.ok(
      retry,
      "Incomplete public terms need a public read retry on every selected tab",
    );
    await act(async () => retry.click());
    assert.equal(detailReads, 2);
    assert.equal(submit().disabled, false);
    assert.deepEqual(subject.store.getSnapshot().panels.A!.presale, before);
    assert.equal(
      document.querySelector<HTMLInputElement>('[aria-label="Commit amount"]')!
        .value,
      "123.450001",
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>('[aria-label^="Pay with "]')!.getAttribute("aria-label"),
      "Pay with USDC",
    );
    // The saved Commits tab is outside Blast mode's pair: it reads as Sale, and the saved setup is not rewritten.
    assert.equal(
      document.querySelector('[role="tab"][aria-selected="true"]')!.textContent,
      "Sale",
    );
    assert.equal(subject.sends.length, 0);
  } finally {
    await subject.close();
  }
});

test("the Sale line labels UTC with zero and nonzero milliseconds while preserving semantic timestamps", async () => {
  for (const [iso, visible] of [
    ["2026-10-20T12:34:56.000Z", "2026-10-20 12:34:56 UTC"],
    ["2026-10-20T12:34:56.297Z", "2026-10-20 12:34:56.297 UTC"],
  ] as const) {
    const at = Date.parse(iso);
    const base = presaleDetail();
    const detail = { ...base, presale: { ...base.presale, end_ms: at } };
    const subject = await mount({
      reads: { detail: async () => detail, viewer: async () => presaleViewer },
    });
    try {
      // The closing time reads a short UTC moment; the exact one, milliseconds included, is in the shared inspector.
      const closing = document.querySelector("time")!;
      assert.equal(closing.dateTime, iso);
      assert.equal(closing.textContent, "20 Oct ’26");
      assert.equal(
        closing.closest("[aria-label]")!.getAttribute("aria-label"),
        `Inspect full scheduled closing time: ${visible}`,
      );
      assert.equal(document.querySelectorAll("time").length, 1);
      assert.equal(subject.sends.length, 0);
    } finally {
      await subject.close();
    }
  }
});


test("inline commitment controller and draft survive view changes and closing the sale", async () => {
  const subject = await mount({ docked: true });
  try {
    const input = document.querySelector<HTMLInputElement>('[aria-label="Commit amount"]')!;
    const controller = submit();
    assert.ok(controller.closest("[data-presale-panel]"), "the primary action is in its card");
    assert.equal(document.querySelector("[data-docked-presale]"), null);
    for (const tab of ["people", "overview"]) {
      await act(async () => document.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)!.click());
      assert.equal(submit(), controller);
      assert.equal(document.querySelector('[aria-label="Commit amount"]'), input);
      assert.equal(input.value, "123.450001");
    }
    subject.setReads({ detail: async () => presaleDetail("closed"), viewer: async () => presaleViewer });
    await subject.render();
    assert.equal(submit(), controller);
    assert.equal(controller.disabled, true, "closed sale cannot commit");
    assert.equal(input.value, "123.450001");
    assert.equal(subject.sends.length, 0);
    assert.equal(document.querySelector('[data-coin-submit]'), null, "presales never expose trading");
  } finally { await subject.close(); }
});


test("terminal allocation labels distinguish linked-wallet totals, active-wallet tokens and historical refunds", async () => {
  const subject = await mount({ focus: true });
  try {
    for (const phase of ["open", "funded", "cancelled", "trading"] as const) {
      subject.setReads({ detail: async () => presaleDetail(phase), viewer: async () => presaleViewer });
      await subject.render();
      const allocation = document.querySelector('[aria-label="Your allocation"]')!;
      assert.match(allocation.textContent!, /Committed · all linked wallets/);
      assert.match(allocation.textContent!, /Unclaimed · active Blast wallet/);
      assert.match(allocation.textContent!, /Already refunded · all linked wallets/);
      assert.equal(allocation.querySelector('[data-claim]'), null);
      assert.equal(document.querySelectorAll('[data-workspace-section="trade"]').length, 1);
      assert.equal(document.querySelectorAll('[data-workspace-section="chart"]').length, 1);
      assert.equal(subject.sends.length, 0);
    }
    subject.setReads({ detail: async () => presaleDetail(), viewer: async () => { throw new Error("Viewer read failed"); } });
    await subject.render();
    assert.match(document.querySelector('[aria-label="Your allocation"]')!.textContent!, /could not load/);
    assert.doesNotMatch(document.querySelector('[aria-label="Your allocation"]')!.textContent!, /haven’t participated/);
  } finally { await subject.close(); }
});

test("presale header distinguishes a known commitment, confirmed zero, pending and unavailable without inventing PnL", async () => {
  const subject = await mount({ focus: true });
  const header = () => document.querySelector('header')!;
  try {
    assert.match(header().textContent!, /Your commitment · all wallets/);
    assert.ok(header().querySelector('[aria-label^="Inspect full Your commitment across linked wallets:"]'));
    assert.doesNotMatch(header().textContent!, /Current PnL/);
    await act(async () => { document.querySelector('[data-blast-ui]')!.setAttribute("data-amounts", "hidden"); notifyShellPrefs(); });
    assert.equal(header().querySelector('[aria-label^="Inspect full Your commitment across linked wallets:"]'), null);
    await act(async () => { document.querySelector('[data-blast-ui]')!.setAttribute("data-amounts", "shown"); notifyShellPrefs(); });
    subject.setReads({ detail: async () => presaleDetail(), viewer: async () => ({ ...presaleViewer, mine: null }) }); await subject.render();
    assert.ok(header().querySelector('[aria-label^="Inspect full Your commitment across linked wallets: 0 "]'));
    subject.setReads({ detail: async () => presaleDetail(), viewer: async () => new Promise<never>(() => {}) }); await subject.render();
    assert.ok(header().querySelector('[aria-label="Loading your commitment"]'));
    subject.setReads({ detail: async () => presaleDetail(), viewer: async () => { throw new Error("unavailable"); } }); await subject.render();
    assert.match(header().textContent!, /Retry allocation/);
    subject.setReads({ detail: async () => presaleDetail(), viewer: async () => null }); await subject.render();
    assert.match(header().textContent!, /Unavailable/);
    subject.setGuest(); await subject.render(); assert.match(header().textContent!, /Sign in/);
    assert.equal(subject.sends.length, 0);
  } finally { await subject.close(); }
});


test("closed presales retain the entered draft without presenting a new commitment allocation", async () => {
  const subject = await mount({ focus: true });
  try {
    await subject.render();
    const draft = subject.store.getSnapshot().panels.A!.presale.commitment.amount;
    for (const phase of ["funded", "cancelled", "trading"] as const) {
      subject.setReads({ detail: async () => presaleDetail(phase), viewer: async () => presaleViewer });
      await subject.render();
      const commit = document.querySelector('section[aria-label="Commit"]')!;
      assert.doesNotMatch(commit.querySelector('button[aria-label="Commit details"]')!.parentElement!.textContent!, /Allocation/);
      assert.equal(subject.store.getSnapshot().panels.A!.presale.commitment.amount, draft);
      assert.match(document.body.textContent!, /Your participation in KSTL/);
      if (phase === "cancelled") {
        assert.match(document.body.textContent!, /scheduled close/);
        assert.equal(document.querySelector('[aria-label^="Inspect full closing time:"]'), null);
      }
    }
    const ended = presaleDetail("cancelled");
    subject.setReads({ detail: async () => ({ ...ended, presale: { ...ended.presale, ended_ms: Date.now() - 60_000 } }), viewer: async () => presaleViewer });
    await subject.render();
    assert.ok(document.querySelector('[aria-label^="Inspect full closing time:"]'));
    assert.doesNotMatch(document.body.textContent!, /scheduled close/);
  } finally { await subject.close(); }
});

test("#1012: a sent commitment leaves an empty box, never the old amount to type into", async () => {
  const subject = await mount({ sent: true });
  try {
    await act(async () => submit().click());
    assert.equal(subject.sends.length, 1);
    assert.match(document.body.textContent!, /Commitment sent/);
    assert.equal(subject.store.getSnapshot().panels.A!.presale.commitment.amount, "");
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Commit amount"]')!.value, "");
  } finally {
    await subject.close();
  }
});
