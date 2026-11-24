import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";
import { createWorkspaceStore } from "../model";
import type { ActionPreference } from "../ActionConfirmation";
import type { CoinPanelProps } from "./CoinPanel";
import {
  FIXTURE_SUI,
  FIXTURE_USDC,
  fixtureCoinType,
  fixtureTradeQuote,
  fixtureWallet,
} from "../../../../../../test/fixtures/social/trade/trade-fixtures.ts";

const coinAccessToken = async () => "fixture-token";

async function mountCoin(side: "buy" | "sell" = "buy", listHoldings = true) {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', {
    url: "https://blast.test",
    pretendToBeVisual: true,
  });
  const media = () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  });
  Object.assign(dom.window, { matchMedia: media });
  dom.window.HTMLElement.prototype.getAnimations = () => [];
  dom.window.HTMLElement.prototype.animate = () => {
    const animation = { cancel() {}, onfinish: null as null | (() => void) };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { CoinTrade } = await import("./CoinTrade");
  const client = createTestQueryClient();
  const store = createWorkspaceStore();
  store.add({
    panel_id: "A",
    chain: "sui",
    network: "mainnet",
    coin_type: fixtureCoinType("KSTL"),
    presale_id: null,
  });
  const p = store.getSnapshot().panels.A!;
  store.patchPanel("A", {
    coin: {
      ...p.coin,
      trade: {
        ...p.coin.trade,
        side,
        buy: { typed: "100", mode: "typed" },
        sell: { typed: "1", mode: "typed" },
      },
    },
  });
  let preference: ActionPreference = { status: "ready", enabled: true };
  let actor = "account:A";
  let visible = true;
  let wallet = {...fixtureWallet(),as_of_ms:Date.now()};
  let sends = 0;
  let quoteMode = "ok";
  const requests: Parameters<typeof fixtureTradeQuote>[0][] = [];
  const balances = fixtureWallet().coins!;
  let readBalance = async (coinType: string): Promise<string> => balances.find((entry) => entry.coin_type === coinType)?.atoms ?? "0";
  const exactReads: string[] = [];
  let listingReads = 0;
  const fetchFallback = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "https://blast.test");
    if (url.pathname !== "/api/social/me/wallet") return fetchFallback(input, init);
    if (url.searchParams.get("identity") === "1") return Response.json({ ...wallet, coins: null });
    if (url.searchParams.has("page")) return Response.json({ ...wallet, listing: { page: 1, total: wallet.coins?.length ?? 0, page_size: 20, value_usd: null, extra_coins: [] } });
    const coinType = url.searchParams.get("balance_coin");
    if (coinType === null) throw new Error("Unexpected wallet query");
    exactReads.push(coinType);
    return Response.json({ address: wallet.address, coin_type: coinType, atoms: await readBalance(coinType), as_of_ms: Date.now() });
  };
  let send: NonNullable<CoinPanelProps["actions"]["trade"]>["send"] | null =
    null;
  const kit: NonNullable<CoinPanelProps["actions"]["trade"]> = {
    signedIn: true,
    signIn() {},
    wallet: async () => { listingReads += 1; return listHoldings ? wallet : null; },
    quote: async (request) => {
      requests.push(request);
      if (quoteMode === "missing") return { status: "error" };
      const quote = fixtureTradeQuote(request, {
        signedIn: true,
        fee: "blast",
        nowMs: Date.now(),
        wallet,
      });
      return {
        status: "ok",
        quote:
          quoteMode === "changed"
            ? { ...quote, amount_out: "1", min_out: "1" }
            : quoteMode === "nudged"
              ? { ...quote, amount_out: (BigInt(quote.amount_out!) * 9_991n / 10_000n).toString() }
            : quoteMode === "expired"
              ? { ...quote, expires_at_ms: 1 }
            : quoteMode === "refused"
              // The server's shape (`unavailableQuote`): no amounts at all.
              ? { ...quote, quote_id: null, expires_at_ms: null, amount_in: null, amount_out: null, min_out: null, unavailable_reason: "dry_run_failed" as const }
              : quote,
      };
    },
    send: async (...args) => {
      assert.equal(args[0].walletAddress, wallet.address, "the exact balance wallet is bound to the trade");
      sends++;
      if (send) return send(...args);
      return {
        status: "refused",
        code: "wallet_refused",
        message: "Wallet declined; draft kept",
      };
    },
  };
  function Subject() {
    const panel = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    ).panels.A!;
    return (
      <QueryProvider client={client}>
        <SocialViewerProvider signedIn getAccessToken={coinAccessToken}>
        <CoinTrade
          asset={panel}
          coin_setup={panel.coin}
          onSetupChange={(coin) => store.patchPanel("A", { coin })}
          effective_visibility={visible}
          actions={{
            trade: kit,
            authenticated: true,
            actor_key: actor,
            confirmation: preference,
            signIn: kit.signIn,
          }}
          coin={{
            coin_type: panel.coin_type,
            symbol: "KSTL",
            name: "Kestrel",
            decimals: 9,
            price_usd: "0.0021",
          }}
        />
        </SocialViewerProvider>
      </QueryProvider>
    );
  }
  const root = createRoot(document.getElementById("mount")!);
  const render = () => act(async () => root.render(<Subject />));
  await render();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
  return {
    store,
    kit,
    requests,
    render,
    setQuoteMode: (value: string) => {
      quoteMode = value;
    },
    exactReads,
    listingReads: () => listingReads,
    setBalanceRead: (read: typeof readBalance) => {
      readBalance = read;
    },
    setSend: (value: typeof send) => {
      send = value;
    },
    sends: () => sends,
    setPreference: (next: typeof preference) => {
      preference = next;
    },
    setActor: (next: string) => {
      actor = next;
    },
    setVisible: (next: boolean) => {
      visible = next;
    },
    setWallet: (next: typeof wallet) => {
      wallet = next;
    },
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      globalThis.fetch = fetchFallback;
      dom.window.close();
    },
  };
}
const submit = () =>
  document.querySelector<HTMLButtonElement>("[data-coin-submit]")!;
const confirm = () =>
  document.querySelector<HTMLButtonElement>("[data-action-confirm]")!;
const cancel = () =>
  document.querySelector<HTMLButtonElement>("[data-action-cancel]")!;

for (const side of ["buy", "sell"] as const) {
  test(`${side} confirmation sends nothing on first press or cancel, keeps draft and confirms once`, async () => {
    const subject = await mountCoin(side);
    try {
      const before = subject.store.getSnapshot();
      assert.equal(submit().disabled, false, document.body.innerHTML);
      await act(async () => submit().click());
      assert.equal(subject.sends(), 0);
      assert.ok(
        document.querySelector("[data-action-confirm]"),
        document.body.innerHTML,
      );
      assert.match(
        document.querySelector('dialog[open], [role="dialog"]')!.textContent!,
        /KSTL/,
      );
      await act(async () => cancel().click());
      assert.equal(subject.sends(), 0);
      assert.deepEqual(subject.store.getSnapshot(), before);
      await act(async () => submit().click());
      await act(async () => {
        confirm().click();
        confirm()?.click();
      });
      assert.equal(subject.sends(), 1);
      assert.match(document.body.textContent!, /Wallet declined/);
      subject.setPreference({ status: "ready", enabled: false });
      await subject.render();
      await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
      await act(async () => submit().click());
      assert.equal(
        subject.sends(),
        2,
        "off enters existing send without a second app review",
      );
    } finally {
      await subject.close();
    }
  });
}

test("the exact paying balance enables a trade while the holdings listing is unavailable", async () => {
  const subject = await mountCoin("buy", false);
  try {
    assert.equal(submit().disabled, false);
    assert.match(document.querySelector('[aria-label="Available trade balance"]')?.textContent ?? "", /860 USDC/);
    assert.deepEqual(subject.exactReads, [FIXTURE_USDC]);
    const max = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Buy amount presets"] button')].find((button) => button.textContent === "Max")!;
    assert.equal(max.disabled, false);
    await act(async () => max.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    assert.equal(subject.requests.at(-1)?.amount_in, "860000000");
  } finally {
    await subject.close();
  }
});

test("final coin confirmation checks the exact payment coin before sending", async () => {
  const subject = await mountCoin();
  try {
    await act(async () => submit().click());
    const listings = subject.listingReads();
    subject.setBalanceRead(async () => "0");
    await act(async () => confirm().click());
    assert.equal(subject.sends(), 0);
    assert.ok(subject.exactReads.length >= 2 && subject.exactReads.every((coinType) => coinType === FIXTURE_USDC));
    assert.equal(subject.listingReads(), listings);
    assert.match(document.body.textContent!, /balance|facts changed/i);
  } finally {
    await subject.close();
  }
});

async function mountCommit() {
  // Reuse the same DOM boundary before importing the shared Sheet.
  const coin = await mountCoin();
  await coin.close();
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', {
    url: "https://blast.test",
    pretendToBeVisual: true,
  });
  dom.window.matchMedia = () =>
    ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  dom.window.HTMLElement.prototype.getAnimations = () => [];
  dom.window.HTMLElement.prototype.animate = () =>
    ({ cancel() {} }) as unknown as Animation;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  const { PresaleCommit } = await import("./PresaleCommit");
  const { presaleAsset, presaleDetail, presaleFacts } = await import(
    "../../../../../../test/fixtures/workspace/presale-fixtures.ts"
  );
  const client = createTestQueryClient();
  const store = createWorkspaceStore();
  store.add({ panel_id: "P", ...presaleAsset });
  const p = store.getSnapshot().panels.P!;
  store.patchPanel("P", {
    presale: {
      ...p.presale,
      commitment: { ...p.presale.commitment, amount: "123.450001" },
    },
  });
  const facts = presaleFacts();
  const snapshot = { facts, at: Date.now(), loading: false, failed: false };
  let fresh = facts;
  let preference: ActionPreference = { status: "ready", enabled: true };
  let sends = 0;
  const kit = {
    signedIn: true,
    signIn() {},
    deposit() {},
    quotes: {
      peek: () => snapshot,
      subscribe: () => () => {},
      want() {},
      fresh: async () => fresh,
      refresh: async () => fresh,
      dispose() {},
    },
    quotePayment: async () => ({ status: "error" as const }),
    send: async () => {
      sends++;
      return { status: "refused" as const, message: "Observer wallet refusal" };
    },
  };
  function Subject() {
    const panel = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    ).panels.P!;
    return (
      <QueryProvider client={client}>
        <PresaleCommit
          asset={panel}
          setup={panel.presale}
          onSetupChange={(presale) => store.patchPanel("P", { presale })}
          visible
          actions={{
            commit: kit,
            authenticated: true,
            actor_key: "account:A",
            confirmation: preference,
            signIn() {},
          }}
          detail={presaleDetail()}
          detail_status="ready"
        />
      </QueryProvider>
    );
  }
  const root = createRoot(document.getElementById("mount")!);
  const render = () => act(async () => root.render(<Subject />));
  await render();
  return {
    store,
    render,
    sends: () => sends,
    setPreference: (next: ActionPreference) => {
      preference = next;
    },
    setFresh: (next: typeof fresh) => {
      fresh = next;
    },
    facts,
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      dom.window.close();
    },
  };
}
test("commit confirmation identifies the current network, retains draft on cancel, sends once and preserves immediate opt-out", async () => {
  const subject = await mountCommit();
  try {
    const button = () =>
      document.querySelector<HTMLButtonElement>("[data-presale-submit]")!;
    const before = subject.store.getSnapshot();
    await act(async () => button().click());
    assert.equal(subject.sends(), 0);
    assert.match(
      document.querySelector("[data-action-confirm]")!.textContent!,
      /Confirm Commit/,
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent!, /Network: mainnet/);
    assert.equal(dialog.closest('[aria-hidden="true"]'), null);
    await act(async () => cancel().click());
    assert.equal(subject.sends(), 0);
    assert.deepEqual(subject.store.getSnapshot(), before);
    await act(async () => button().click());
    await act(async () => {
      confirm().click();
      confirm()?.click();
    });
    assert.equal(subject.sends(), 1);
    subject.setPreference({ status: "ready", enabled: false });
    await subject.render();
    await act(async () => button().click());
    assert.equal(subject.sends(), 2);
  } finally {
    await subject.close();
  }
});
test("commit confirmation refuses changed financial terms before sending", async () => {
  const subject = await mountCommit();
  try {
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>("[data-presale-submit]")!
        .click(),
    );
    subject.setFresh({
      ...subject.facts,
      sale: {
        ...subject.facts.sale!,
        presalePrice: subject.facts.sale!.presalePrice! * 2,
      },
    });
    await act(async () => confirm().click());
    assert.equal(subject.sends(), 0);
    assert.match(document.body.textContent!, /terms changed/i);
  } finally {
    await subject.close();
  }
});

test("coin confirmation sends a sealed quote at most 10 bp below the shown one on the same press", async () => {
  const subject = await mountCoin();
  try {
    await act(async () => submit().click());
    subject.setQuoteMode("nudged");
    await act(async () => confirm().click());
    assert.equal(subject.sends(), 1, "0.09% below: within the tolerance, no second press");
    assert.doesNotMatch(document.body.textContent!, /price moved/i);
  } finally {
    await subject.close();
  }
});
for (const mode of ["changed", "missing", "expired", "refused"])
  test(`coin confirmation refuses ${mode} final quote`, async () => {
    const subject = await mountCoin();
    try {
      await act(async () => submit().click());
      subject.setQuoteMode(mode);
      await act(async () => confirm().click());
      assert.equal(subject.sends(), 0);
      const said = { changed: /price moved.*press again.*Nothing was sent/i, missing: /could not be confirmed.*Nothing was sent.*try again/i, expired: /quote.*changed|route changed/i, refused: /wouldn’t go through right now/ }[mode]!;
      assert.match(document.body.textContent!, said);
      if (mode === "missing" || mode === "refused") {
        // Nothing asks the server again on its own: the next press is the retry.
        const asked = subject.requests.length;
        await act(async () => new Promise((resolve) => setTimeout(resolve, 5_500)));
        assert.equal(subject.requests.length, asked);
        assert.match(document.body.textContent!, said, "the line stays");
        assert.equal(submit().disabled, false, "the estimate stands: the next press asks again");
      }
      if (mode === "changed") {
        // The lower sealed number is now on screen; the next press sends exactly it, without sealing again.
        const asked = subject.requests.length;
        let sent: Readonly<{ amountOut: string | null; asked: number }> | null = null;
        subject.setSend(async (input) => {
          sent = { amountOut: input.quote.amount_out, asked: subject.requests.length };
          return { status: "refused", code: "wallet_refused", message: "Wallet declined; draft kept" };
        });
        await act(async () => submit().click());
        await act(async () => confirm().click());
        assert.equal(subject.sends(), 1);
        assert.deepEqual(sent, { amountOut: "1", asked }, "the shown sealed quote is sent as it is, with no new seal");
      }
    } finally {
      await subject.close();
    }
  });
for (const preference of [{ status: "pending" }, { status: "error" }] as const)
  test(`unknown ${preference.status} preference blocks both coin sides`, async () => {
    const subject = await mountCoin();
    try {
      subject.setPreference(preference);
      await subject.render();
      assert.equal(submit().disabled, true);
      await act(async () => submit().click());
      assert.equal(subject.sends(), 0);
      assert.match(
        document.body.textContent!,
        preference.status === "pending"
          ? /Loading action preference/
          : /preference could not load/,
      );
    } finally {
      await subject.close();
    }
  });
test("actor transition during final preflight cancels old authorization", async () => {
  const subject = await mountCoin();
  try {
    await act(async () => submit().click());
    let resolve!: (atoms: string) => void;
    subject.setBalanceRead(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => confirm().click());
    subject.setActor("account:B");
    subject.setPreference({ status: "pending" });
    await subject.render();
    await act(async () => resolve("860000000"));
    assert.equal(subject.sends(), 0);
  } finally {
    await subject.close();
  }
});
test("gas fallback still requires explicit wallet fee consent after app review", async () => {
  const subject = await mountCoin();
  try {
    subject.setSend(async () => ({
      status: "fee_required",
      feeMist: "1000",
      payable: true,
      message: "Review payment from your SUI",
    }));
    await act(async () => submit().click());
    await act(async () => confirm().click());
    assert.equal(subject.sends(), 1);
    assert.equal(submit().disabled, true);
    assert.ok(
      document.querySelector('input[type="checkbox"]'),
      document.body.innerHTML,
    );
    assert.equal(
      (document.querySelector('input[type="checkbox"]') as HTMLInputElement)
        .checked,
      false,
    );
  } finally {
    await subject.close();
  }
});
test("already-started send retains its kit while current actor changes", async () => {
  const subject = await mountCoin();
  try {
    let resolve!: (result: {
      status: "refused";
      code: string;
      message: string;
    }) => void;
    subject.setSend(
      async () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => submit().click());
    await act(async () => confirm().click());
    assert.equal(subject.sends(), 1);
    subject.setActor("account:B");
    subject.setPreference({ status: "pending" });
    await subject.render();
    await act(async () =>
      resolve({
        status: "refused",
        code: "wallet_refused",
        message: "Original wallet refused",
      }),
    );
    assert.equal(subject.sends(), 1);
  } finally {
    await subject.close();
  }
});

test("live auth preference bridge scopes caches by principal and blocks stale opt-out during fetch", async () => {
  const base = await mountCoin();
  await base.close();
  const dom = new JSDOM('<div id="mount"></div>', {
    url: "https://blast.test",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });
  const { BlastActionProvider, useCurrentBlastActions } = await import(
    "../BlastActionProvider"
  );
  const { DEFAULT_NOTIFICATION_PREFERENCES } = await import(
    "@blast/core/modules/social/contracts/settings.ts"
  );
  const { queryKeys } = await import("#web/lib/query/keys.ts");
  const client = createTestQueryClient();
  const settings = {
    privacy: "public",
    sharing_since_ms: 1,
    commit_too_coin_type: null,
    public_portfolio: false,
    explorer: "suiscan",
    sound: false,
    notifications: DEFAULT_NOTIFICATION_PREFERENCES,
    blast_mode_confirm_actions: false,
  };
  client.setQueryData(queryKeys.me.settings("A"), settings);
  let identity = "A";
  let status: "ready" | "loading" | "error" = "ready";
  let resolve!: (response: Response) => void;
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    new Promise((done) => {
      resolve = done;
    })) as typeof fetch;
  let observed: ReturnType<typeof useCurrentBlastActions>;
  function Probe() {
    observed = useCurrentBlastActions();
    return <p>{JSON.stringify(observed)}</p>;
  }
  function Subject() {
    return (
      <QueryProvider client={client}>
        <BlastActionProvider
          accountState={{
            status,
            account: { account_id: identity } as never,
            sessionStatus: status === "loading" ? "pending" : "authenticated",
            sessionIdentity: identity,
          }}
          getAccessToken={async () => "fixture"}
        >
          <Probe />
        </BlastActionProvider>
      </QueryProvider>
    );
  }
  const root = createRoot(document.getElementById("mount")!);
  const render = () => act(async () => root.render(<Subject />));
  try {
    await render();
    assert.equal(observed!.confirmation.status, "pending");
    await act(async () =>
      resolve(Response.json({ ...settings, blast_mode_confirm_actions: true })),
    );
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    assert.deepEqual(observed!.confirmation, {
      status: "ready",
      enabled: true,
    });
    status = "loading";
    identity = "B";
    await render();
    assert.equal(observed!.confirmation.status, "pending");
    status = "ready";
    await render();
    assert.match(observed!.actor_key, /account:B/);
    assert.equal(observed!.confirmation.status, "pending");
    await act(async () =>
      resolve(
        Response.json({ error: { code: "unavailable" } }, { status: 503 }),
      ),
    );
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    assert.equal(observed!.confirmation.status, "error");
    status = "error";
    await render();
    assert.equal(observed!.authenticated, false);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = original;
    dom.window.close();
  }
});


test("counter picker changes the actual pair, invalidates an open review and preserves independent USD drafts", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({coins:[],next_cursor:null}),{status:200,headers:{"content-type":"application/json"}});
  const subject = await mountCoin();
  try {
    subject.setWallet({...fixtureWallet(),as_of_ms:Date.now()});
    await subject.render();
    await act(async () => submit().click());
    const oldConfirm = confirm();
    assert.ok(oldConfirm);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Pay with USDC"]')!.click());
    await act(async () => new Promise(resolve=>setTimeout(resolve,50)));
    const sui = Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label="Quick choices"] button')).find(button=>button.textContent?.trim() === "SUI");
    assert.ok(sui,document.body.innerHTML);
    await act(async () => sui.click());
    await act(async () => new Promise(resolve=>setTimeout(resolve,450)));
    assert.equal(confirm(),null,"the USDC review must be discarded on pair selection");
    await act(async () => oldConfirm.click());
    assert.equal(subject.sends(),0,"an old detached confirmation cannot execute");
    assert.equal(subject.requests.at(-1)?.in_coin,FIXTURE_SUI);
    assert.equal(subject.requests.at(-1)?.out_coin,fixtureCoinType("KSTL"));
    assert.equal(subject.requests.at(-1)?.amount_in,"29239766081");
    assert.equal(subject.store.getSnapshot().panels.A!.coin.trade.buy.typed,"100");
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent === "Sell")!.click());
    assert.ok(document.querySelector('button[aria-label="Receive USDC"]'),"Sell keeps its own default counterasset");
    assert.equal(subject.store.getSnapshot().panels.A!.coin.trade.sell.typed,"1");
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Receive USDC"]')!.click());
    await act(async () => new Promise(resolve=>setTimeout(resolve,50)));
    const lumn=Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(option=>option.textContent?.includes("LUMN"));
    assert.ok(lumn,document.body.innerHTML);
    await act(async () => lumn.click());
    await act(async () => new Promise(resolve=>setTimeout(resolve,450)));
    assert.ok(document.querySelector('button[aria-label="Receive LUMN"]'));
    assert.equal(subject.requests.at(-1)?.side,"buy","two nonbase coins follow the route's pair-side contract");
    assert.equal(subject.requests.at(-1)?.in_coin,fixtureCoinType("KSTL"));
    assert.equal(subject.requests.at(-1)?.out_coin,fixtureCoinType("LUMN"));
    await act(async()=>submit().click());
    assert.match(document.querySelector('[data-action-confirm]')?.closest('[role="dialog"]')?.textContent ?? document.body.textContent!,/LUMN/);
    await act(async()=>cancel().click());
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent === "Buy")!.click());
    assert.ok(document.querySelector('button[aria-label="Pay with SUI"]'));
  } finally {
    await subject.close();
    globalThis.fetch=previousFetch;
  }
});
