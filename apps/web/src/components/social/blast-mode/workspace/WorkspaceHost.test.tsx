import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, lazy, StrictMode, Suspense, useContext, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ESCAPE_SETTLE_MS, WorkspaceFrame } from "../WorkspaceFrame";
import { presaleHistory } from "./presale-history";

import type { WorkspaceOwnerResolver } from "./workspace-context";
import type {
  WorkspaceHostProps,
  WorkspaceSlots,
} from "./WorkspaceHost";
import { createWorkspaceStore } from "./model";
import { encodeWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { workspaceJournalKey } from "./journal";

let WorkspaceHost: typeof import("./WorkspaceHost")["WorkspaceHost"];
let useWorkspace: typeof import("./workspace-context")["useWorkspace"];

const guest: WorkspaceOwnerResolver = async () => ({ kind: "guest" });

async function mounted(
  resolveOwner: WorkspaceOwnerResolver = guest,
  saved?: string,
  slots?: WorkspaceSlots,
  storageFor?: (storage: Storage) => Pick<Storage, "getItem" | "setItem">,
  mobile = false,
  onExit = () => {},
  strictMode = false,
) {
  const dom = new JSDOM(
    '<div data-blast-ui><div id="shell"><main id="main"><button id="opener">Open</button></main></div><div id="mount"></div></div>',
    { url: "https://blast.test/presale?status=live#next", pretendToBeVisual: true },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    CSS: { escape: (value: string) => value },
    Node:dom.window.Node,
    AbortController:dom.window.AbortController,
    AbortSignal:dom.window.AbortSignal,
    getComputedStyle:dom.window.getComputedStyle,
    requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // The desktop is the board's 1440 width, where Discover opens by default (1100–1439 shows its rail first).
  Object.assign(dom.window, { innerWidth: mobile ? 407 : 1440, innerHeight: mobile ? 900 : 1120 });
  // JSDOM has no layout observer; sorting geometry itself is covered by panel-sort and trusted browser proof.
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis,{ResizeObserver});
  dom.window.matchMedia = () =>
    ({
      matches: mobile,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.getAnimations=()=>[];
  // React was imported before this per-test DOM; support its legacy input-event fallback.
  Object.assign(dom.window.HTMLElement.prototype,{attachEvent(){},detachEvent(){}});
  dom.window.HTMLElement.prototype.animate=()=>{const animation={cancel(){},onfinish:null as null|(()=>void)};queueMicrotask(()=>animation.onfinish?.());return animation as unknown as Animation;};
  ({ WorkspaceHost } = await import("./WorkspaceHost"));
  ({ useWorkspace } = await import("./workspace-context"));
  if (saved)
    dom.window.localStorage.setItem(
      workspaceJournalKey({
        actor: { kind: "guest" },
        chain: "sui",
        network: "mainnet",
      }),
      saved,
    );
  dom.window.document.getElementById("opener")!.focus();
  const root = createRoot(dom.window.document.getElementById("mount")!);
  let testDispatch: ReturnType<typeof useWorkspace>["dispatch"];
  function TestControls() { const { dispatch } = useWorkspace(); useEffect(() => { testDispatch = dispatch; }, [dispatch]); return slots?.controls; }
  const props: WorkspaceHostProps = {
    resolveOwner,
    ownerKey: "guest",
    entryGeneration: 1,
    onExit,
    storage: storageFor?.(dom.window.localStorage) ?? dom.window.localStorage,
    slots: { ...slots, controls: <TestControls /> },
  };
  async function render(overrides: Partial<WorkspaceHostProps> = {}) {
    const content = (
      <Suspense
        fallback={
          <WorkspaceFrame onExit={onExit}>Opening workspace</WorkspaceFrame>
        }
      >
        <WorkspaceHost {...props} {...overrides} />
      </Suspense>
    );
    await act(async () =>
      root.render(strictMode ? <StrictMode>{content}</StrictMode> : content),
    );
  }
  await render();
  return {
    dom,
    root,
    render,
    async openPicker() { await act(async () => testDispatch!.setDataCollapsed(false)); },
    async closePicker() { await act(async () => testDispatch!.setDataCollapsed(true)); },
    async dispose() {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

test("a mounted confirmed guest starts with left discovery and leaves the underlying page mounted", async () => {
  const page = await mounted();
  try {
    assert.match(
      page.dom.window.document.body.textContent!,
      /No panels/,
    );
    assert.ok(page.dom.window.document.querySelector('[aria-label="Asset browser"]:not([hidden])'));
    await page.openPicker();
    assert.ok(page.dom.window.document.querySelector('[aria-label="Asset browser"]:not([hidden])'));
    assert.ok(page.dom.window.document.getElementById("opener"));
    assert.equal(
      (await menuOptions(page.dom.window.document, 'Data view')).length,
      7,
    );
    assert.doesNotMatch(page.dom.window.document.body.textContent!, /Account workspace|Synced/);
  } finally {
    await page.dispose();
  }
});

test("desktop discovery reflows without remounting the trade field and stays open after market selection", async () => {
  const store = createWorkspaceStore();
  store.setCapacity(2);
  const asset = (id: string) => ({ panel_id: id, chain: "sui" as const, network: "mainnet" as const, coin_type: `0x2::coin::${id}`, presale_id: null });
  store.add(asset("A"), 0);
  store.add(asset("B"), 1);
  store.focus("A");
  function Market() { return <input aria-label="Retained trade amount" defaultValue="125.50" />; }
  function Data() { return <span data-discovery-reader="">Public market reader</span>; }
  function Controls() { const { dispatch } = useWorkspace(); return <button onClick={() => dispatch.add(asset("B"))}>Select market B</button>; }
  const page = await mounted(async () => ({ kind: "account", account_id: "rail", store }), undefined, { panel: Market, data: { Coins: Data }, controls: <Controls /> });
  try {
    const doc = page.dom.window.document;
    const input = doc.querySelector<HTMLInputElement>('[aria-label="Retained trade amount"]');
    assert.ok(input);
    assert.ok(doc.querySelector('[data-discovery-reader]'));
    await page.closePicker();
    assert.equal(doc.querySelector('[data-discovery-reader]'), null, "collapsed discovery releases its read owner");
    assert.equal(doc.querySelector('[aria-label="Retained trade amount"]'), input);
    assert.equal(input.value, "125.50");
    await page.openPicker();
    assert.equal(doc.querySelector('[aria-label="Retained trade amount"]'), input);
    assert.ok(doc.querySelector('[data-discovery-reader]'));
    await act(async () => buttonNamed(doc, "Select market B").click());
    assert.equal(store.getSnapshot().focused_panel_id, "B");
    assert.equal(store.getSnapshot().data.collapsed, false);
    assert.equal(doc.querySelector('[role="dialog"],dialog'), null);
    assert.ok(doc.querySelector('[data-discovery-reader]'));
  } finally { await page.dispose(); }
});

test("document hiding preserves panel controllers and unmounts shown Data while keeping every saved record", async () => {
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", chain: "sui", network: "mainnet", coin_type: "0x2::coin::A", presale_id: null });
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  function Market() { return <span data-market-renderer="">Market read owner</span>; }
  function Data() { return <span data-data-renderer="">Data read owner</span>; }
  const page = await mounted(guest, encoded.bytes, { panel: Market, data: { Coins: Data } });
  try {
    await page.openPicker();
    const doc = page.dom.window.document;
    assert.ok(doc.querySelector("[data-market-renderer]"));
    assert.ok(doc.querySelector("[data-data-renderer]"));
    await act(async () => {
      Object.defineProperty(doc, "visibilityState", { value: "hidden", configurable: true });
      doc.dispatchEvent(new page.dom.window.Event("visibilitychange"));
    });
    assert.equal(!!doc.querySelector("[data-market-renderer]"), true);
    assert.equal(!!doc.querySelector("[data-data-renderer]"), false);
    await act(async () => {
      Object.defineProperty(doc, "visibilityState", { value: "visible", configurable: true });
      doc.dispatchEvent(new page.dom.window.Event("visibilitychange"));
    });
    assert.ok(doc.querySelector("[data-market-renderer]"));
    assert.ok(doc.querySelector("[data-data-renderer]"));
  } finally { await page.dispose(); }
});

test("mounted adapters journal the final input and restore a saved setup with no panels; Discover keeps its fixed tabs", async () => {
  const store = createWorkspaceStore();
  store.add({
    panel_id: "A",
    chain: "sui",
    network: "mainnet",
    coin_type: "0x2::coin::A",
    presale_id: null,
  });
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  const page = await mounted(guest, encoded.bytes, { panel: DraftAdapter });
  try {
    const input = page.dom.window.document.querySelector("input")!;
    await act(async () => {
      input.value = "00042.";
      input.dispatchEvent(
        new page.dom.window.Event("input", { bubbles: true }),
      );
    });
    const key = workspaceJournalKey({
      actor: { kind: "guest" },
      chain: "sui",
      network: "mainnet",
    });
    const saved = JSON.parse(page.dom.window.localStorage.getItem(key)!);
    assert.equal(saved.panels.A.coin.trade.buy.typed, "00042.");
    assert.equal(
      page.dom.window.document.querySelectorAll("[data-panel-id]").length,
      1,
    );
  } finally {
    await page.dispose();
  }
  store.remove("A");
  store.setDataCollapsed(true);
  for (const view of store.getSnapshot().data.enabled_views)
    store.setDataViewEnabled(view, false);
  const empty = encodeWorkspace(store.getSnapshot());
  assert.ok(empty.ok);
  const restored = await mounted(guest, empty.bytes);
  try {
    assert.equal(
      restored.dom.window.document.querySelector('[aria-label="Asset browser"]:not([hidden])'),
      null,
    );
    // Discover's navigation is fixed (audit 06/28): a setup that hid every view still shows the served tabs.
    const tabs = [...restored.dom.window.document.querySelectorAll('[role="tablist"][aria-label="What to discover"] [role="tab"]')].map((tab) => tab.textContent?.trim());
    for (const view of ["Coins", "Presales", "Posts"]) assert.ok(tabs.includes(view), `${view} stays in Discover`);
    assert.equal(
      restored.dom.window.document.querySelectorAll("[data-panel-id]").length,
      0,
    );
  } finally {
    await restored.dispose();
  }
});

test("pending, failed identity and an account without its adapter never read or overwrite guest setup", async () => {
  const cases: WorkspaceOwnerResolver[] = [
    () => new Promise(() => {}),
    async () => {
      throw new Error("me unavailable");
    },
    async () => ({ kind: "account", account_id: "account-1" }),
  ];
  for (const resolve of cases) {
    const page = await mounted(resolve, "precious guest bytes");
    try {
      assert.doesNotMatch(
        page.dom.window.document.body.textContent!,
        /No panels/,
      );
      assert.equal(
        page.dom.window.localStorage.getItem(
          workspaceJournalKey({
            actor: { kind: "guest" },
            chain: "sui",
            network: "mainnet",
          }),
        ),
        "precious guest bytes",
      );
      assert.equal(
        page.dom.window.document.querySelectorAll("[data-panel-id]").length,
        0,
      );
    } finally {
      await page.dispose();
    }
  }
});

test("malformed guest storage shows recovery and retry preserves the exact saved bytes", async () => {
  const page = await mounted(guest, '{"schema_version":900,"future":"keep"}');
  try {
    assert.match(
      page.dom.window.document.body.textContent!,
      /could not be read/,
    );
    assert.doesNotMatch(
      page.dom.window.document.body.textContent!,
      /No panels/,
    );
    await act(async () => page.root.render(null));
    await page.render({ entryGeneration: 2 });
    const retry = Array.from(
      page.dom.window.document.querySelectorAll("button"),
    ).find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    assert.equal(
      page.dom.window.localStorage.getItem(
        workspaceJournalKey({
          actor: { kind: "guest" },
          chain: "sui",
          network: "mainnet",
        }),
      ),
      '{"schema_version":900,"future":"keep"}',
    );
  } finally {
    await page.dispose();
  }
});

test("a StrictMode guest recovers available storage and retains edits through subscription teardown", async () => {
  const store = createWorkspaceStore();
  store.add({
    panel_id: "A",
    chain: "sui",
    network: "mainnet",
    coin_type: "0x2::coin::A",
    presale_id: null,
  });
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  let blocked = true;
  let writes = 0;
  const page = await mounted(
    guest,
    encoded.bytes,
    { panel: DraftAdapter },
    (storage) => ({
      getItem: (key) => {
        if (blocked) throw new Error("storage unavailable");
        return storage.getItem(key);
      },
      setItem: (key, bytes) => {
        writes += 1;
        storage.setItem(key, bytes);
      },
    }),
    false,
    () => {},
    true,
  );
  const doc = page.dom.window.document;
  try {
    assert.match(doc.body.textContent!, /could not be read/);
    assert.equal(writes, 0);
    blocked = false;
    const retry = Array.from(doc.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    )!;
    await act(async () => retry.click());
    assert.doesNotMatch(doc.body.textContent!, /could not be read/);
    const input = doc.querySelector("input")!;
    await act(async () => {
      input.value = "00042.";
      input.dispatchEvent(
        new page.dom.window.Event("input", { bubbles: true }),
      );
    });
    assert.equal(writes, 1);
    await act(async () => page.root.render(null));
    await page.render({ entryGeneration: 2 });
    assert.equal(doc.querySelector("input")!.value, "00042.");
    assert.equal(writes, 1);
    assert.doesNotMatch(doc.body.textContent!, /could not be saved/);
  } finally {
    await page.dispose();
  }
});

test("the mounted host keeps shell overlays interactive and restores focus without losing scroll", async () => {
  const page = await mounted();
  try {
    assert.equal(page.dom.window.document.getElementById("shell")!.inert, true);
    assert.equal(page.dom.window.document.activeElement?.textContent, "Exit Esc");
    const overlay = page.dom.window.document.createElement("div");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = '<button id="sign">Sign in</button>';
    page.dom.window.document.body.append(overlay);
    overlay.querySelector("button")!.focus();
    assert.equal(page.dom.window.document.activeElement?.id, "sign");
    overlay.remove();
    await act(async () => page.root.unmount());
    assert.equal(
      page.dom.window.document.getElementById("shell")!.inert,
      false,
    );
    assert.equal(page.dom.window.document.activeElement?.id, "opener");
  } finally {
    page.dom.window.close();
  }
});

test("Escape closes a subordinate overlay without also exiting when its handler removes the dialog immediately", async () => {
  let exits = 0;
  const page = await mounted(
    guest,
    undefined,
    undefined,
    undefined,
    false,
    () => {
      exits += 1;
    },
  );
  try {
    const doc = page.dom.window.document;
    const overlay = doc.createElement("div");
    overlay.setAttribute("aria-modal", "true");
    const close = doc.createElement("button");
    overlay.append(close);
    doc.body.append(overlay);
    // A delegated overlay handler can unmount its dialog before document listeners.
    doc.addEventListener("keydown", () => overlay.remove(), {
      capture: true,
      once: true,
    });
    close.dispatchEvent(
      new page.dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    assert.equal(overlay.isConnected, false);
    assert.equal(exits, 0);
  } finally {
    await page.dispose();
  }
});

test("B and Backspace exit Blast mode, but never from a field or typing widget, with a modifier, held down or under an open layer", async () => {
  let exits = 0;
  const page = await mounted(guest, undefined, undefined, undefined, false, () => { exits += 1; });
  try {
    const doc = page.dom.window.document;
    const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
      const event = new page.dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    const fields = ["input", "textarea", "select"].map((tag) => doc.body.appendChild(doc.createElement(tag)));
    const widget = doc.body.appendChild(doc.createElement("div"));
    widget.setAttribute("role", "combobox");
    const inner = widget.appendChild(doc.createElement("span"));
    for (const key of ["b", "B", "Backspace"]) {
      for (const field of fields) press(field, key);
      press(inner, key);
      for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) press(doc.body, key, { [modifier]: true });
      press(doc.body, key, { repeat: true });
    }
    assert.equal(exits, 0, "typing, chords and held keys stay in Blast mode");
    const layer = doc.createElement("div");
    layer.setAttribute("role", "menu");
    layer.setAttribute("data-open", "");
    doc.body.append(layer);
    press(doc.body, "b");
    layer.remove();
    const dialog = doc.body.appendChild(doc.createElement("dialog"));
    dialog.setAttribute("open", "");
    press(doc.body, "Backspace");
    dialog.remove();
    assert.equal(exits, 0, "an open menu or dialog owns the key");
    for (const key of ["b", "B", "Backspace"]) assert.equal(press(doc.body, key).defaultPrevented, true, key);
    assert.equal(exits, 3, "b, B (Caps Lock) and Backspace each exit");
  } finally {
    await page.dispose();
  }
});

// Content adapters exercise the public host context, as the asset consumers will.
function DraftAdapter() {
  const { snapshot, dispatch } = useWorkspace();
  const panel = snapshot.panels.A!;
  return (
    <input
      aria-label="Draft amount"
      value={panel.coin.trade.buy.typed}
      onInput={(event) =>
        dispatch.patchPanel("A", {
          coin: {
            ...panel.coin,
            trade: {
              ...panel.coin.trade,
              buy: { typed: event.currentTarget.value, mode: "typed" },
            },
          },
        })
      }
    />
  );
}

test("Data view tabs expose all seven default views (Posts and Bonding included) and label the Data panel", async () => {
  const page = await mounted();
  try {
    await page.openPicker();
    const doc = page.dom.window.document;
    assert.deepEqual(await menuOptions(doc, "Data view"), ["Coins", "Presales", "Bonding", "Posts", "Traders", "Activity", "Portfolio"]);
    await choose(doc, "Data view", "Portfolio");
    // A More view never becomes a fifth tab: More shows it, no tab is selected, and the panel carries its own name.
    assert.equal(doc.querySelector("#workspace-data-tab-Portfolio"), null);
    assert.equal(doc.querySelectorAll('[role="tablist"][aria-label="What to discover"] [role="tab"]').length, 4);
    assert.equal(doc.querySelector('[role="tablist"][aria-label="What to discover"] [aria-selected="true"]'), null);
    assert.equal(doc.querySelector('[aria-label^="More views:"]')!.textContent, "Portfolio", "More names the open view");
    assert.equal(doc.querySelector('[aria-label^="More views:"]')!.getAttribute("data-current"), "true", "and wears the selected look (live audit F33)");
    assert.equal(doc.getElementById("workspace-data-panel")!.getAttribute("aria-labelledby"), null);
    assert.equal(doc.querySelector('#workspace-data-tab-Coins')!.getAttribute("tabindex"), null, "the row stays in the Tab order");
    assert.equal(doc.getElementById("workspace-data-panel")!.getAttribute("aria-label"), "Portfolio", "a More view names the panel itself, not the More select");
    // With no current tab the arrows step from the focused tab: right of Coins is Presales (not Coins itself).
    const coins = doc.querySelector<HTMLButtonElement>("#workspace-data-tab-Coins")!;
    coins.focus();
    await act(async () => { coins.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    assert.equal(doc.querySelector('[role="tablist"][aria-label="What to discover"] [aria-selected="true"]')?.id, "workspace-data-tab-Presales");
    assert.equal(doc.activeElement?.id, "workspace-data-tab-Presales");
  } finally { await page.dispose(); }
});

test("a failed draft write retains current input, exposes retry and preserves the prior saved setup", async () => {
  const store = createWorkspaceStore();
  store.add({
    panel_id: "A",
    chain: "sui",
    network: "mainnet",
    coin_type: "0x2::coin::A",
    presale_id: null,
  });
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  let blocked = true;
  const page = await mounted(
    guest,
    encoded.bytes,
    { panel: DraftAdapter },
    (storage) => ({
      getItem: (key) => storage.getItem(key),
      setItem: (key, bytes) => {
        if (blocked) throw new Error("quota");
        storage.setItem(key, bytes);
      },
    }),
  );
  try {
    const input = page.dom.window.document.querySelector("input")!;
    await act(async () => {
      input.value = "7.000";
      input.dispatchEvent(
        new page.dom.window.Event("input", { bubbles: true }),
      );
    });
    const key = workspaceJournalKey({
      actor: { kind: "guest" },
      chain: "sui",
      network: "mainnet",
    });
    assert.equal(page.dom.window.localStorage.getItem(key), encoded.bytes);
    assert.match(
      page.dom.window.document.body.textContent!,
      /could not be saved/,
    );
    assert.equal(input.value, "7.000");
    blocked = false;
    const retry = Array.from(
      page.dom.window.document.querySelectorAll("button"),
    ).find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    assert.equal(
      JSON.parse(page.dom.window.localStorage.getItem(key)!).panels.A.coin.trade
        .buy.typed,
      "7.000",
    );
    assert.doesNotMatch(
      page.dom.window.document.body.textContent!,
      /could not be saved/,
    );
  } finally {
    await page.dispose();
  }
});

test("a failed draft survives ordinary exit and same-tab re-entry while adapters and UI listeners unmount", async () => {
  const store = createWorkspaceStore();
  store.add({
    panel_id: "A",
    chain: "sui",
    network: "mainnet",
    coin_type: "0x2::coin::A",
    presale_id: null,
  });
  const panel = store.getSnapshot().panels.A!;
  store.patchPanel("A", {
    coin: {
      ...panel.coin,
      trade: { ...panel.coin.trade, buy: { typed: "1.000", mode: "typed" } },
    },
  });
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  let blocked = true;
  let panels = 0;
  let data = 0;
  function Panel() {
    useEffect(() => {
      panels += 1;
      return () => {
        panels -= 1;
      };
    }, []);
    return <DraftAdapter />;
  }
  function Data() {
    useEffect(() => {
      data += 1;
      return () => {
        data -= 1;
      };
    }, []);
    return <p>Simulated Data adapter</p>;
  }
  const page = await mounted(
    guest,
    encoded.bytes,
    { panel: Panel, data: { Coins: Data } },
    (storage) => ({
      getItem: (key) => storage.getItem(key),
      setItem: (key, bytes) => {
        if (blocked)
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        storage.setItem(key, bytes);
      },
    }),
    false,
    () => page.root.render(null),
  );
  const doc = page.dom.window.document;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const add = doc.addEventListener.bind(doc);
  const remove = doc.removeEventListener.bind(doc);
  doc.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "keydown" || type === "visibilitychange")
      listeners.add(listener);
    add(type, listener, options);
  };
  doc.removeEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    listeners.delete(listener);
    remove(type, listener, options);
  };
  const key = workspaceJournalKey({
    actor: { kind: "guest" },
    chain: "sui",
    network: "mainnet",
  });
  try {
    const input = doc.querySelector("input")!;
    assert.equal(input.value, "1.000");
    await act(async () => {
      input.value = "00042.";
      input.dispatchEvent(
        new page.dom.window.Event("input", { bubbles: true }),
      );
    });
    assert.equal(doc.querySelector("input")!.value, "00042.");
    assert.match(doc.body.textContent!, /could not be saved/);
    assert.equal(page.dom.window.localStorage.getItem(key), encoded.bytes);
    await act(async () =>
      doc.querySelector<HTMLButtonElement>("[aria-keyshortcuts~='Escape']")!.click(),
    );
    assert.equal(doc.querySelector("[data-workspace-host]"), null);
    assert.equal(panels, 0);
    assert.equal(data, 0);
    assert.equal(doc.getElementById("shell")!.inert, false);

    await page.render({ entryGeneration: 2 });
    assert.equal(doc.querySelector("input")!.value, "00042.");
    assert.match(doc.body.textContent!, /could not be saved/);
    assert.equal(page.dom.window.localStorage.getItem(key), encoded.bytes);
    assert.equal(panels, 1);
    assert.equal(data, 1, "the saved expanded rail restores on desktop re-entry");
    assert.ok(listeners.size > 0, "re-entry listens again; the Escape below proves the frame hears it");
    blocked = false;
    const retry = Array.from(doc.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    )!;
    await act(async () => retry.click());
    assert.equal(
      JSON.parse(page.dom.window.localStorage.getItem(key)!).panels.A.coin.trade
        .buy.typed,
      "00042.",
    );
    assert.doesNotMatch(doc.body.textContent!, /could not be saved/);
    await act(async () =>
      doc.dispatchEvent(
        new page.dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(panels, 0);
    assert.equal(data, 0);
    assert.equal(listeners.size, 0);
    assert.equal(doc.querySelector("[data-workspace-host]"), null);
    await page.render({ entryGeneration: 3 });
    assert.equal(doc.querySelector("input")!.value, "00042.");
    assert.doesNotMatch(doc.body.textContent!, /could not be saved/);
  } finally {
    await page.dispose();
  }
});

test("retained guest drafts stay separate from other networks, storage sources and account owners", async () => {
  const store = createWorkspaceStore();
  store.add({
    panel_id: "A",
    chain: "sui",
    network: "mainnet",
    coin_type: "0x2::coin::A",
    presale_id: null,
  });
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  let reads = 0;
  let writes = 0;
  const page = await mounted(
    guest,
    encoded.bytes,
    { panel: DraftAdapter },
    (storage) => ({
      getItem: (key) => {
        if (
          key ===
          workspaceJournalKey({
            actor: { kind: "guest" },
            chain: "sui",
            network: "mainnet",
          })
        )
          reads += 1;
        return storage.getItem(key);
      },
      setItem: () => {
        writes += 1;
        throw new Error("quota");
      },
    }),
  );
  const doc = page.dom.window.document;
  try {
    await act(async () => {
      const input = doc.querySelector("input")!;
      input.value = "00042.";
      input.dispatchEvent(
        new page.dom.window.Event("input", { bubbles: true }),
      );
    });
    await page.render({ network: "testnet" });
    assert.match(doc.body.textContent!, /No panels/);
    assert.doesNotMatch(doc.body.textContent!, /could not be saved/);
    await page.render({ network: "mainnet" });
    assert.equal(doc.querySelector("input")!.value, "00042.");
    assert.match(doc.body.textContent!, /could not be saved/);

    await page.render({ storage: page.dom.window.localStorage });
    assert.equal(doc.querySelector("input")!.value, "");
    assert.doesNotMatch(doc.body.textContent!, /could not be saved/);
    const beforeAccount = { reads, writes };
    const account: WorkspaceOwnerResolver = async () => ({
      kind: "account",
      account_id: "account-1",
      store,
    });
    await page.render({ resolveOwner: account, ownerKey: "account-1" });
    assert.equal(doc.querySelector("input")!.value, "");
    assert.doesNotMatch(doc.body.textContent!, /Guest workspace/);
    await page.render({
      resolveOwner: async () => ({ kind: "account", account_id: "account-2" }),
      ownerKey: "account-2",
    });
    assert.match(doc.body.textContent!, /account workspace could not load/);
    assert.equal(doc.querySelector("input"), null);
    assert.deepEqual({ reads, writes }, beforeAccount);
    await page.render({ ownerKey: "guest-return" });
    assert.equal(doc.querySelector("input")!.value, "00042.");
    assert.match(doc.body.textContent!, /could not be saved/);
  } finally {
    await page.dispose();
  }
});

test("the default browser journal retains a failed saved-empty choice across host unmount and retries it", async () => {
  const page = await mounted(guest, undefined, { panel: DraftAdapter });
  const doc = page.dom.window.document;
  const key = workspaceJournalKey({
    actor: { kind: "guest" },
    chain: "sui",
    network: "mainnet",
  });
  const prototype = page.dom.window.Storage.prototype;
  const setItem = prototype.setItem;
  try {
    await page.render({ storage: undefined });
    await page.openPicker();
    prototype.setItem = function (name, bytes) {
      if (name === key)
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      setItem.call(this, name, bytes);
    };
    await act(async () =>
      Array.from(doc.querySelectorAll("button"))
        .find((button) => button.getAttribute("aria-label") === "Collapse discovery")!
        .click(),
    );
    assert.match(doc.body.textContent!, /could not be saved/);
    await act(async () => page.root.render(null));
    prototype.setItem = setItem;
    await page.render({ entryGeneration: 2, storage: undefined });
    assert.equal(
      doc.querySelector('[aria-label="Asset browser"]:not([hidden])'),
      null,
    );
    assert.match(doc.body.textContent!, /could not be saved/);
    await act(async () =>
      Array.from(doc.querySelectorAll("button"))
        .find((button) => button.textContent === "Retry")!
        .click(),
    );
    assert.equal(
      JSON.parse(page.dom.window.localStorage.getItem(key)!).data.collapsed,
      true,
    );
    assert.doesNotMatch(doc.body.textContent!, /could not be saved/);
  } finally {
    prototype.setItem = setItem;
    await page.dispose();
  }
});

test("mobile Data covers the selected panel without unmounting its controller", async () => {
  const store = createWorkspaceStore();
  for (const id of ["A", "B"])
    store.add({
      panel_id: id,
      chain: "sui",
      network: "mainnet",
      coin_type: `0x2::coin::${id}`,
      presale_id: null,
    });
  const saved = encodeWorkspace(store.getSnapshot());
  assert.ok(saved.ok);
  const page = await mounted(guest, saved.bytes, undefined, undefined, true);
  try {
    await page.openPicker();
    assert.equal(
      page.dom.window.document
        .querySelector('[aria-label="Asset panels"]')
        ?.getAttribute("data-covered"),
      "true",
    );
    // Covered cards stay mounted (controllers keep their drafts) behind the Data view.
    assert.equal(
      page.dom.window.document.querySelectorAll("[data-panel-id]").length,
      2,
    );
    const collapse = Array.from(
      page.dom.window.document.querySelectorAll("button"),
    ).find((button) => button.getAttribute("aria-label") === "Close Discover")!;
    await act(async () => collapse.click());
    assert.equal(
      page.dom.window.document
        .querySelector('[aria-label="Asset panels"]')
        ?.getAttribute("data-covered"),
      "false",
    );
    assert.deepEqual(
      Array.from(
        page.dom.window.document.querySelectorAll("[data-panel-id]"),
      ).map((panel) => panel.getAttribute("data-panel-id")),
      ["A", "B"],
    );
    const selected = store.getSnapshot().mobile_panel_id ?? "A";
    assert.equal(page.dom.window.document.querySelector(`[data-panel-chip="${selected}"]`)?.getAttribute("aria-pressed"), "true");
  } finally {
    await page.dispose();
  }
});

test("the named mobile switcher changes the presented asset without changing desktop order or drafts", async () => {
  const store = createWorkspaceStore();
  for (const id of ["A", "B"])
    store.add({
      panel_id: id,
      chain: "sui",
      network: "mainnet",
      coin_type: `0x2::coin::${id}`,
      presale_id: null,
    });
  const panel = store.getSnapshot().panels.A!;
  store.patchPanel("A", {
    coin: {
      ...panel.coin,
      trade: { ...panel.coin.trade, buy: { typed: "00042.", mode: "typed" } },
    },
  });
  store.setDataCollapsed(true);
  const saved = encodeWorkspace(store.getSnapshot());
  assert.ok(saved.ok);
  const page = await mounted(guest, saved.bytes, undefined, undefined, true);
  try {
    const doc = page.dom.window.document;
    assert.deepEqual(await menuOptions(doc, "Selected asset panel"), ["A panel", "B panel"]);
    await choose(doc, "Selected asset panel", "B panel");
    // Phones keep every card mounted in one swipe feed; the chosen card becomes the selected one.
    assert.deepEqual(
      Array.from(doc.querySelectorAll("[data-panel-id]")).map((element) =>
        element.getAttribute("data-panel-id"),
      ),
      ["A", "B"],
    );
    assert.equal(doc.querySelector('[data-panel-chip="B"]')?.getAttribute("aria-pressed"), "true");
    const persisted = JSON.parse(
      page.dom.window.localStorage.getItem(
        workspaceJournalKey({
          actor: { kind: "guest" },
          chain: "sui",
          network: "mainnet",
        }),
      )!,
    );
    assert.deepEqual(persisted.visible_order, ["A", "B"]);
    assert.equal(persisted.mobile_panel_id, "B");
    assert.equal(persisted.desktop_capacity, 4);
    assert.equal(persisted.panels.A.coin.trade.buy.typed, "00042.");
  } finally {
    await page.dispose();
  }
});

test("one-coin workspace keeps saved assets and removes Compare controls", async () => {
  const store = managementSeed().store;
  const before = store.getSnapshot();
  const page = await mounted(async () => ({ kind: "account", account_id: "layout", store }));
  try {
    const doc = page.dom.window.document;
    assert.equal(doc.querySelector('[aria-label="Workspace view"]'), null);
    assert.equal(doc.querySelector('[aria-label^="Tracked asset limit"]'), null);
    assert.equal(doc.querySelectorAll('[data-focus-hidden="false"]').length, 1);
    assert.ok(buttonNamed(doc, "Layout"));
    assert.deepEqual(store.getSnapshot(), before);
  } finally { await page.dispose(); }
});


test("discovery rail collapses without losing the selected view or filters", async () => {
  const store = createWorkspaceStore();
  store.selectDataView("Portfolio");
  store.patchDataControls("Portfolio", { ...store.getSnapshot().data.controls.Portfolio, tab: "presales", coins: { search: "saved search", page: 2, hide_small: true } });
  const controls = store.getSnapshot().data.controls;
  const page = await mounted(async () => ({ kind: "account", account_id: "layout", store }));
  try {
    const doc = page.dom.window.document;
    assert.ok(doc.querySelector('[aria-label="Asset browser"]:not([hidden])'));
    await page.openPicker();
    assert.equal(doc.querySelector('[aria-label^="More views:"]')!.getAttribute("aria-label"), "More views: Portfolio");
    await act(async () => buttonNamed(doc, "Collapse discovery").click());
    await act(async () => new Promise(resolve => setTimeout(resolve, 200)));
    assert.equal(doc.querySelector('[aria-label="Asset browser"]:not([hidden])'), null);
    await page.openPicker();
    assert.equal(doc.querySelector('[aria-label^="More views:"]')!.getAttribute("aria-label"), "More views: Portfolio");
    assert.deepEqual(store.getSnapshot().data.controls, controls);
  } finally { await page.dispose(); }
});

test("Data reopening and view switching restore each view's scroll navigation", async () => {
  const store = createWorkspaceStore();
  const page = await mounted(async () => ({
    kind: "account",
    account_id: "navigation",
    store,
  }));
  try {
    await page.openPicker();
    const doc = page.dom.window.document;
    const body = () => doc.getElementById("workspace-data-panel")!;
    await act(async () => {
      body().scrollTop = 180;
      body().dispatchEvent(
        new page.dom.window.Event("scroll", { bubbles: true }),
      );
    });
    assert.equal(
      store.getSnapshot().data.controls.Coins.navigation.scroll_top,
      180,
    );
    await act(async () => store.selectDataView("Portfolio"));
    assert.equal(body().scrollTop, 0);
    await act(async () => {
      body().scrollTop = 75;
      body().dispatchEvent(
        new page.dom.window.Event("scroll", { bubbles: true }),
      );
    });
    await act(async () => store.setDataCollapsed(true));
    await act(async () => store.setDataCollapsed(false));
    assert.equal(body().scrollTop, 75);
    await act(async () => store.selectDataView("Coins"));
    assert.equal(body().scrollTop, 180);
  } finally {
    await page.dispose();
  }
});

function managementSeed(count = 6) {
  let store = createWorkspaceStore();
  const ids =
    count === 6
      ? ["E", "F", "D", "C", "B", "A"]
      : Array.from({ length: count }, (_, index) => `Asset${index}`);
  for (const id of ids) {
    store.add({
      panel_id: id,
      chain: "sui",
      network: "mainnet",
      coin_type: `0x2::coin::${id}`,
      presale_id: null,
    });
    const panel = store.getSnapshot().panels[id]!;
    store.patchPanel(id, {
      coin: {
        ...panel.coin,
        trade: {
          ...panel.coin.trade,
          buy: { typed: `000${id}.`, mode: "typed" },
        },
      },
    });
  }
  const order=count === 6 ? ["A","B","C","D","F","E"] : [...ids].reverse();
  store=createWorkspaceStore({...store.getSnapshot(),presentation:"compare",visible_order:order.slice(0,4),desktop_slots:order.slice(0,4),retained_order:order.slice(4),focused_panel_id:order[0] ?? null,mobile_panel_id:order[0] ?? null});
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  return { store, bytes: encoded.bytes };
}

function buttonNamed(doc: Document, name: string) {
  const button = Array.from(
    doc.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (element) =>
      (element.getAttribute("aria-label") ?? element.textContent)?.trim() === name ||
      (name.startsWith("Chart ") && element.getAttribute("aria-label")?.startsWith(name + " ·")),
  );
  assert.ok(button, `Missing button: ${name}`);
  return button;
}

/** Segmented controls that replaced the old menus: Data views (tabs), panel capacity (icon buttons), phone panel chips. */
const SEGMENTED: Readonly<Record<string, (doc: Document) => HTMLElement[]>> = {
  "Data view": doc => [...doc.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="What to discover"] [role="tab"]')],
  "Selected asset panel": doc => [...doc.querySelectorAll<HTMLElement>("[data-panel-chip]")],
};
const segmentName = (element: HTMLElement) => (element.getAttribute("aria-label") ?? element.textContent!.trim()).split(" · ")[0]!;
function menuTrigger(doc: Document, label: string) {
  const trigger = doc.querySelector<HTMLButtonElement>(`[aria-label^="${label}:"]`);
  assert.ok(trigger, `Missing menu: ${label}`);
  return trigger;
}
async function menuOptions(doc: Document, label: string): Promise<string[]> {
  if (label === "Data view") return [...[...doc.querySelectorAll('[role="tablist"][aria-label="What to discover"] [role="tab"]')].map(element => element.textContent!.trim()), ...await menuOptions(doc, "More views")];
  const segmented = SEGMENTED[label];
  if (segmented) return segmented(doc).map(segmentName);
  const trigger = menuTrigger(doc, label);
  await act(async () => trigger.click());
  const options = [...doc.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map(item => item.textContent!.replace(/\s*✓\s*$/, "").trim());
  await act(async () => trigger.click());
  return options;
}
async function choose(doc: Document, label: string, value: string) {
  if (label === "Data view" && !doc.querySelector(`#workspace-data-tab-${value}`)) {
    await choose(doc, "More views", value);
    return;
  }
  const segmented = SEGMENTED[label];
  if (segmented) {
    const option = segmented(doc).find(element => segmentName(element) === value);
    assert.ok(option, `Missing ${label} option: ${value}`);
    await act(async () => { option.focus(); option.click(); });
    await settleMenu();
    return;
  }
  await act(async () => { const trigger = menuTrigger(doc, label); trigger.focus(); trigger.click(); });
  const option = [...doc.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent!.replace(/\s*✓\s*$/, "").trim() === value);
  assert.ok(option, `Missing ${label} option: ${value}`);
  await act(async () => option.click());
  await settleMenu();
}
/** A coin card's removal is its own button; a presale card's lives in its options menu with the page link. */
async function removePanel(doc: Document, name: string) {
  const direct = doc.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${name} panel"]`);
  if (direct) {
    await act(async () => { direct.focus(); direct.click(); });
    await settleMenu();
    return;
  }
  await act(async () => { const trigger = buttonNamed(doc, `Options for ${name} panel`); trigger.focus(); trigger.click(); });
  const item = [...doc.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === `Remove ${name} panel`);
  assert.ok(item, `Missing Remove ${name} panel`);
  await act(async () => item.click());
  await settleMenu();
}
async function settleMenu() {
  // Base UI restores focus after React commits the closing state and the next frame.
  await act(async () => { await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))); });
}


const managementKey = workspaceJournalKey({
  actor: { kind: "guest" },
  chain: "sui",
  network: "mainnet",
});

test("More panels pages the complete retained history and promotes one canonical setup without mounting hidden adapters", async () => {
  const seed = managementSeed(35);
  let mounts = 0;
  function Panel() {
    useEffect(() => {
      mounts += 1;
      return () => {
        mounts -= 1;
      };
    }, []);
    return <p>Controlled panel</p>;
  }
  const page = await mounted(guest, seed.bytes, { panel: Panel });
  try {
    const doc = page.dom.window.document;
    await act(async () => buttonNamed(doc, "Recent panels (31)").click());
    assert.equal(mounts, 4);
    assert.equal(doc.querySelectorAll("[data-retained-panel-id]").length, 8);
    for (let i = 0; i < 3; i += 1)
      await act(async () => buttonNamed(doc, "Next recent panels").click());
    assert.ok(doc.querySelector('[data-retained-panel-id="Asset0"]'));
    await act(async () => buttonNamed(doc, "Open Asset0 panel").click());
    await settleMenu();
    assert.equal(doc.querySelector('[aria-labelledby="workspace-replace-title"]'), null);
    const saved = JSON.parse(
      page.dom.window.localStorage.getItem(managementKey)!,
    );
    assert.deepEqual(saved.visible_order, [
      "Asset0",
      "Asset33",
      "Asset32",
      "Asset31",
    ]);
    assert.equal(saved.retained_order.length, 31);
    assert.equal(Object.keys(saved.panels).length, 35);
    assert.equal(saved.panels.Asset0.coin.trade.buy.typed, "000Asset0.");
    assert.equal(doc.activeElement?.closest("[data-panel-id]")?.getAttribute("data-panel-id"), "Asset0");
    assert.equal(mounts, 4);
    await act(async () => buttonNamed(doc, "Recent panels (31)").click());
    assert.equal(
      doc
        .querySelector("[data-retained-panel-id]")
        ?.getAttribute("data-retained-panel-id"),
      "Asset34",
    );
  } finally {
    await page.dispose();
  }
  assert.equal(mounts, 0);
});

test("explicit close leaves its exact slot empty, preserves other focus and shell actions, and restores saved empty", async () => {
  const seed = managementSeed();
  function Panel({ panel }: { panel: import("@blast/core/modules/social/blast-workspace/setup.ts").PanelSetup }) {
    return (
      <button aria-label={`Draft ${panel.panel_id}`}>
        {panel.coin.trade.buy.typed}
      </button>
    );
  }
  const page = await mounted(guest, seed.bytes, { panel: Panel });
  let finalBytes = "";
  try {
    const doc = page.dom.window.document;
    const inputC = doc.querySelector<HTMLButtonElement>(
      '[aria-label="Draft C"]',
    )!;
    await act(async () => inputC.focus());
    await removePanel(doc, "B");
    const saved = JSON.parse(
      page.dom.window.localStorage.getItem(managementKey)!,
    );
    assert.deepEqual(saved.visible_order, ["A", "C", "D"]);
    assert.deepEqual(saved.desktop_slots,["A",null,"C","D"]);
    assert.deepEqual(saved.retained_order, ["F","E"]);
    assert.equal(saved.panels.B, undefined);
    // Removal starts from the card's own menu, so focus moves to the control that refills its slot.
    assert.equal(doc.activeElement, doc.querySelector("[data-add-chart]"));
    assert.ok(inputC.isConnected);
    while (doc.querySelector("[data-panel-id]")) {
      const panel = doc.querySelector("[data-panel-id]")!;
      const id = panel.getAttribute("data-panel-id")!;
      await removePanel(doc, id);
      assert.ok(doc.activeElement?.isConnected);
      assert.notEqual(doc.activeElement, doc.body);
    }
    // Explicit close never promotes hidden history; remove saved entries independently.
    await act(async()=>buttonNamed(doc,"Recent panels (2)").click());
    await act(async()=>buttonNamed(doc,"Remove F from Recent").click());
    await act(async()=>buttonNamed(doc,"Remove E from Recent").click());
    finalBytes = page.dom.window.localStorage.getItem(managementKey)!;
    assert.deepEqual(JSON.parse(finalBytes).panels, {});
    assert.deepEqual(JSON.parse(finalBytes).visible_order, []);
    assert.deepEqual(JSON.parse(finalBytes).retained_order, []);
    assert.ok(doc.activeElement?.isConnected);
  } finally {
    await page.dispose();
  }
  const restored = await mounted(guest, finalBytes);
  try {
    assert.match(
      restored.dom.window.document.body.textContent!,
      /No panels/,
    );
  } finally {
    await restored.dispose();
  }
});



test("rapid Add and promotion use canonical identity, preserve setup, and focus the selected mobile asset", async () => {
  function Controls() {
    const { dispatch } = useWorkspace();
    return (
      <div>
        {["E", "B", "D"].map((id) => (
          <button
            key={id}
            onClick={() =>
              dispatch.add({
                panel_id: `new-${id}`,
                chain: "sui",
                network: "mainnet",
                coin_type: `0x02::coin::${id}`,
                presale_id: null,
              })
            }
          >
            Add {id}
          </button>
        ))}
      </div>
    );
  }
  const seed = managementSeed();
  seed.store.remove("F");
  seed.store.remove("E");
  const original = seed.store.getSnapshot();
  const encoded = encodeWorkspace(original);
  assert.ok(encoded.ok);
  const page = await mounted(
    guest,
    encoded.bytes,
    { controls: <Controls /> },
    undefined,
    true,
  );
  try {
    const doc = page.dom.window.document;
    await act(async () => buttonNamed(doc, "Add E").click());
    let saved = JSON.parse(
      page.dom.window.localStorage.getItem(managementKey)!,
    );
    assert.deepEqual(saved.visible_order, ["new-E", "B", "C", "D"]);
    assert.deepEqual(saved.retained_order, ["A"]);
    assert.equal(saved.focused_panel_id, "new-E");
    await act(async () => {
      for (let i = 0; i < 5; i += 1) buttonNamed(doc, "Add B").click();
    });
    saved = JSON.parse(page.dom.window.localStorage.getItem(managementKey)!);
    assert.deepEqual(saved.visible_order, ["new-E", "B", "C", "D"]);
    assert.equal(Object.keys(saved.panels).length, 5);
    assert.deepEqual(saved.panels.B, original.panels.B);
    assert.equal(saved.mobile_panel_id, "B");
    assert.equal(saved.data.collapsed, true);
    assert.equal(doc.activeElement?.getAttribute("data-panel-id"), "B");
    await act(async () => buttonNamed(doc, "Add D").click());
    saved = JSON.parse(page.dom.window.localStorage.getItem(managementKey)!);
    assert.deepEqual(saved.visible_order, ["new-E", "B", "C", "D"]);
    assert.deepEqual(saved.retained_order, ["A"]);
    assert.deepEqual(saved.panels.D, original.panels.D);
    assert.deepEqual(saved.data.controls, original.data.controls);
  } finally {
    await page.dispose();
  }
});

test("a cold Sell renderer focuses its inline amount when ready without opening a sheet", async () => {
  const ready = Promise.withResolvers<{ default: NonNullable<WorkspaceSlots["panel"]> }>();
  const ColdPanel = lazy(() => ready.promise);
  function Controls() {
    const { dispatch } = useWorkspace();
    return <><button type="button" onClick={() => dispatch.openOnSell({ panel_id: "new-A", chain: "sui", network: "mainnet", coin_type: "0x2::coin::A", presale_id: null })}>Sell A</button><button type="button" onClick={() => dispatch.setCapacity(2)}>Two panels</button></>;
  }
  const ReadyPanel: NonNullable<WorkspaceSlots["panel"]> = ({ panel }) => <label>{panel.coin.trade.side} amount<input aria-label="Trade amount in USD" defaultValue={panel.coin.trade.sell.typed} /></label>;
  const page = await mounted(guest, undefined, { controls: <Controls />, panel: ColdPanel });
  try {
    const doc = page.dom.window.document;
    const sell = buttonNamed(doc, "Sell A");
    sell.focus();
    // JSDOM does not implement native Enter activation; click is its button activation seam.
    await act(async () => sell.click());
    const pendingDialog = doc.activeElement?.closest('[role="dialog"],dialog');
    const pendingPanel = doc.querySelector('[data-panel-id="new-A"]');
    const pendingStatus = pendingPanel?.querySelector('[role="status"]');
    await act(async () => buttonNamed(doc, "Two panels").click());
    await act(async () => ready.resolve({ default: ReadyPanel }));
    assert.equal(doc.activeElement === doc.querySelector('[data-panel-id="new-A"] input'), true, "readiness focuses the newly mounted active amount, never Exit or another coin");
    assert.equal(pendingDialog, null, "Sell does not open an empty trade sheet");
    assert.ok(pendingStatus, "loading is local to the selected panel");
    assert.equal(doc.querySelector('[data-panel-id="new-A"]'), pendingPanel);
    assert.equal(doc.querySelectorAll('[data-panel-id="new-A"]').length, 1);
    assert.match(doc.querySelector('[data-panel-id="new-A"]')!.textContent!, /sell amount/);
    assert.equal(doc.querySelector<HTMLInputElement>('[data-panel-id="new-A"] input')!.value, "");
    assert.ok(doc.querySelector('[aria-label="Asset browser"]:not([hidden])'));
  } finally {
    ready.resolve({ default: ReadyPanel });
    await page.dispose();
  }
});

test("deleting a middle retained row focuses the next row's Open control", async () => {
  const seed = managementSeed(35);
  const page = await mounted(guest, seed.bytes);
  try {
    const doc = page.dom.window.document;
    await act(async () => buttonNamed(doc, "Recent panels (31)").click());
    const remove = buttonNamed(doc, "Remove Asset28 from Recent");
    remove.focus();
    await act(async () => remove.click());
    assert.equal(
      doc.activeElement?.getAttribute("aria-label"),
      "Open Asset27 panel",
    );
    assert.equal(doc.querySelector('[data-retained-panel-id="Asset28"]'), null);
  } finally {
    await page.dispose();
  }
});

test("deleting the only retained row on the final page focuses Open on the preceding page", async () => {
  const seed = managementSeed(13);
  const page = await mounted(guest, seed.bytes);
  try {
    const doc = page.dom.window.document;
    await act(async () => buttonNamed(doc, "Recent panels (9)").click());
    await act(async () => buttonNamed(doc, "Next recent panels").click());
    const remove = buttonNamed(doc, "Remove Asset0 from Recent");
    remove.focus();
    await act(async () => remove.click());
    assert.equal(
      doc.activeElement?.getAttribute("aria-label"),
      "Open Asset8 panel",
    );
    assert.equal(doc.querySelectorAll("[data-retained-panel-id]").length, 8);
    // Eight rows fit one page, so the pager leaves rather than showing two dead arrows.
    assert.equal(doc.querySelector('[aria-label="Recent panel pages"]'), null);
  } finally {
    await page.dispose();
  }
});

test("retained deletion recovers keyboard focus and a failed history write keeps all saved bytes for Retry", async () => {
  const seed = managementSeed(35);
  let blocked = true;
  const page = await mounted(guest, seed.bytes, undefined, (storage) => ({
    getItem: (key) => storage.getItem(key),
    setItem: (key, bytes) => {
      if (blocked) throw new DOMException("quota", "QuotaExceededError");
      storage.setItem(key, bytes);
    },
  }));
  try {
    const doc = page.dom.window.document;
    await act(async () => buttonNamed(doc, "Recent panels (31)").click());
    const remove = buttonNamed(doc, "Remove Asset30 from Recent");
    remove.focus();
    await act(async () => remove.click());
    assert.notEqual(doc.activeElement, doc.body);
    assert.ok(doc.activeElement?.closest('[aria-label="Recent panels"]'));
    assert.equal(
      page.dom.window.localStorage.getItem(managementKey),
      seed.bytes,
    );
    assert.match(doc.body.textContent!, /could not be saved/);
    assert.equal(doc.querySelectorAll("[data-retained-panel-id]").length, 8);
    blocked = false;
    await act(async () => buttonNamed(doc, "Retry").click());
    const saved = JSON.parse(
      page.dom.window.localStorage.getItem(managementKey)!,
    );
    assert.equal(saved.retained_order.length, 30);
    assert.equal(Object.keys(saved.panels).length, 34);
    assert.equal(saved.panels.Asset30, undefined);
    assert.deepEqual(
      saved.panels.Asset0,
      seed.store.getSnapshot().panels.Asset0,
    );
    assert.doesNotMatch(doc.body.textContent!, /could not be saved/);
  } finally {
    await page.dispose();
  }
});

test("Escape from the open history trigger closes history and keeps the workspace open", async () => {
  const seed = managementSeed();
  let exits = 0;
  const page = await mounted(
    guest,
    seed.bytes,
    undefined,
    undefined,
    false,
    () => {
      exits += 1;
    },
  );
  try {
    const doc = page.dom.window.document;
    const trigger = buttonNamed(doc, "Recent panels (2)");
    trigger.focus();
    await act(async () => trigger.click());
    await act(async () =>
      trigger.dispatchEvent(
        new page.dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(exits, 0);
    assert.equal(doc.activeElement, trigger);
  } finally {
    await page.dispose();
  }
});

test("account host loads its private saved empty setup without persistent status copy or reading the guest journal", async () => {
  const original = globalThis.fetch;
  let puts = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PUT") puts++;
    return Response.json({
      account_id: "account-private",
      revision: "2",
      saved_at_ms: 1,
      workspace: createWorkspaceStore().getSnapshot(),
    });
  };
  const page = await mounted(
    async () => ({ kind: "account", account_id: "account-private" }),
    "guest bytes preserved",
  );
  try {
    await act(async () => {
      for (let n = 0; n < 15; n++) await Promise.resolve();
    });
    assert.doesNotMatch(
      page.dom.window.document.body.textContent!,
      /Account workspace|Synced|Saving|could not be saved/,
    );
    assert.match(
      page.dom.window.document.body.textContent!,
      /No panels/,
    );
    assert.equal(puts, 0);
    assert.equal(
      page.dom.window.localStorage.getItem(managementKey),
      "guest bytes preserved",
    );
  } finally {
    await page.dispose();
    globalThis.fetch = original;
  }
});

test("a committed token source refresh preserves the active account store and retries the exact queued write with fresh auth", async (t) => {
  const original = globalThis.fetch;
  const writes: import("@blast/core/modules/social/blast-workspace/codec.ts").WorkspaceWriteEnvelope[] = [];
  const requests: { url: string; token: string | null }[] = [];
  const stores: import("./model").WorkspaceStore[] = [];
  function Probe() {
    stores.push(useWorkspace().dispatch);
    return null;
  }
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), token: new Headers(init?.headers).get("authorization") });
    if (url === "/api/social/me") return Response.json({ account: { account_id: "token-owner" } });
    if (init?.method !== "PUT") return Response.json({ account_id: "token-owner", revision: "1", saved_at_ms: 1, workspace: createWorkspaceStore().getSnapshot() });
    const write = JSON.parse(String(init.body));
    writes.push(write);
    if (writes.length === 1) return Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "Retry-After": "10" } });
    return Response.json({ account_id: "token-owner", sequence: write.sequence, revision: "2", saved_at_ms: 2 });
  };
  const page = await mounted(async () => ({ kind: "account", account_id: "token-owner" }), undefined, { controls: <Probe /> });
  async function tick(ms: number) {
    await act(async () => {
      t.mock.timers.tick(ms);
      for (let n = 0; n < 30; n++) await Promise.resolve();
    });
  }
  try {
    await page.openPicker();
    await page.render({ getAccessToken: async () => "old-token" });
    const store = stores.at(-1)!;
    assert.ok(store);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
    await act(async () => store.setDataCollapsed(true));
    await tick(500);
    assert.equal(writes.length, 1);
    assert.equal(requests.at(-1)!.token, "Bearer old-token");
    await page.render({ getAccessToken: async () => "fresh-token" });
    assert.equal(stores.at(-1)!.getSnapshot, store.getSnapshot, "refreshing auth keeps the same active layout and controller");
    await tick(10_000);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1], writes[0], "refreshing auth cannot change writer, sequence or payload");
    assert.equal(requests.at(-1)!.token, "Bearer fresh-token");
    assert.equal(requests.at(-2)!.token, "Bearer fresh-token", "owner preflight also uses current auth");
    assert.equal(requests.filter(({ url }) => url.endsWith("blast-workspace")).length, 3, "auth refresh never reloads the active account layout");
  } finally {
    await page.dispose();
    t.mock.timers.reset();
    globalThis.fetch = original;
  }
});

test("account journal failure warns that latest edits will be lost on reload or close and Retry recovers them", async () => {
  const original = globalThis.fetch;
  const store = createWorkspaceStore();
  let blocked = false;
  globalThis.fetch = async (url, init) =>
    Response.json(
      url === "/api/social/me"
        ? { account: { account_id: "quota-account" } }
        : init?.method === "PUT"
          ? {
              account_id: "quota-account",
              sequence: JSON.parse(String(init.body)).sequence,
              revision: "2",
              saved_at_ms: 2,
            }
          : {
              account_id: "quota-account",
              revision: "1",
              saved_at_ms: 1,
              workspace: store.getSnapshot(),
            },
    );
  const page = await mounted(
    async () => ({ kind: "account", account_id: "quota-account" }),
    undefined,
    { controls: <button onClick={() => {}}>Fixture</button> },
    (storage) => ({
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => {
        if (blocked) throw new DOMException("quota", "QuotaExceededError");
        storage.setItem(key, value);
      },
    }),
  );
  try {
    await page.openPicker();
    const doc = page.dom.window.document;
    const before = { ...page.dom.window.localStorage };
    blocked = true;
    await act(async () => buttonNamed(doc, "Collapse discovery").click());
    assert.match(
      doc.querySelector('[role="alert"]')!.textContent!,
      /latest changes will not survive (?:reloading or closing|closing or reloading)/i,
    );
    assert.equal(doc.querySelector('[aria-label="Asset browser"]:not([hidden])'), null);
    assert.deepEqual({ ...page.dom.window.localStorage }, before);
    blocked = false;
    await act(async () => buttonNamed(doc, "Retry").click());
    assert.equal(doc.querySelector('[role="alert"]'), null);
    const key = workspaceJournalKey({
      actor: { kind: "account", account_id: "quota-account" },
      chain: "sui",
      network: "mainnet",
    });
    assert.equal(
      JSON.parse(page.dom.window.localStorage.getItem(key)!).data.collapsed,
      true,
    );
  } finally {
    await page.dispose();
    globalThis.fetch = original;
  }
});

test("account save recovery keeps its deadline and write identity through document hiding and mode reentry", async (t) => {
  const original = globalThis.fetch;
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", chain: "sui", network: "mainnet", coin_type: "0x2::coin::A", presale_id: null });
  const writes: import("@blast/core/modules/social/blast-workspace/codec.ts").WorkspaceWriteEnvelope[] = [];
  globalThis.fetch = async (url, init) => {
    if (url === "/api/social/me") return Response.json({ account: { account_id: "live-save-owner" } });
    if (init?.method !== "PUT") return Response.json({ account_id: "live-save-owner", revision: "1", saved_at_ms: 1, workspace: store.getSnapshot() });
    const write = JSON.parse(String(init.body));
    writes.push(write);
    if (writes.length === 1) return Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "Retry-After": "10" } });
    return Response.json({ account_id: "live-save-owner", sequence: write.sequence, revision: "2", saved_at_ms: Date.now() });
  };
  const page = await mounted(async () => ({ kind: "account", account_id: "live-save-owner" }), undefined, { panel: DraftAdapter });
  async function tick(ms: number) {
    await act(async () => {
      t.mock.timers.tick(ms);
      for (let n = 0; n < 30; n++) await Promise.resolve();
    });
  }
  try {
    const doc = page.dom.window.document;
    assert.ok(doc.querySelector("input"));
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
    await act(async () => {
      const input = doc.querySelector("input")!;
      input.value = "00042.";
      input.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
      Object.defineProperty(doc, "visibilityState", { value: "hidden", configurable: true });
      doc.dispatchEvent(new page.dom.window.Event("visibilitychange"));
    });
    assert.equal(!!doc.querySelector("input"), true, "hidden documents preserve mounted draft controllers");
    await tick(500);
    assert.equal(writes.length, 1, "the hidden document preserves the independent save owner");
    assert.equal(writes[0]!.workspace.panels.A!.coin.trade.buy.typed, "00042.");
    await tick(5000);
    await act(async () => page.root.render(null));
    assert.equal(writes.length, 1, "exit flush cannot bypass the server deadline");
    await page.render({ entryGeneration: 2 });
    await tick(4999);
    assert.equal(writes.length, 1, "reentry preserves the bounded outbox deadline");
    await tick(1);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1], writes[0], "the original account retries the exact uncertain write");
    assert.doesNotMatch(doc.body.textContent!, /Account workspace|Synced|Saving|could not be saved/);
    await tick(60_000);
    assert.equal(writes.length, 2, "a settled save does not become recurring display work");
  } finally {
    await page.dispose();
    t.mock.timers.reset();
    globalThis.fetch = original;
  }
});

test("closing a chart compacts the visible grid and Add panel refills the preserved logical slot", async () => {
  const store = createWorkspaceStore();
  for (const id of ["A", "B", "C", "D"]) store.add({panel_id:id,chain:"sui",network:"mainnet",coin_type:`0x2::coin::${id}`,presale_id:null});
  function Data() { const {dispatch}=useWorkspace(); return <button onClick={()=>dispatch.add({panel_id:"E",chain:"sui",network:"mainnet",coin_type:"0x2::coin::E",presale_id:null})}>Choose E</button>; }
  const page=await mounted(async()=>({kind:"account",account_id:"slots",store}),undefined,{data:{Coins:Data}});
  try {
    const doc=page.dom.window.document;
    await removePanel(doc,"B");
    const add=doc.querySelector<HTMLButtonElement>('[data-add-chart]');
    assert.deepEqual(store.getSnapshot().desktop_slots,["A",null,"C","D"]);
    assert.equal(doc.querySelectorAll("[data-panel-id]").length,3);
    assert.ok(add);
    assert.equal(doc.activeElement,add);
    await act(async()=>add.click());
    await act(async()=>[...doc.querySelectorAll('button')].find(b=>b.textContent==='Choose E')!.click());
    assert.deepEqual(store.getSnapshot().desktop_slots,["A","E","C","D"]);
  } finally {await page.dispose();}
});


test("opening a new coin replaces the selected slot and retains its draft", async () => {
  const store = managementSeed(4).store;
  const before = store.getSnapshot();
  function Data() { const { dispatch } = useWorkspace(); return <button onClick={() => dispatch.add({ panel_id: "new", chain: "sui", network: "mainnet", coin_type: "0x2::coin::NEW", presale_id: null })}>Choose new</button>; }
  const page = await mounted(async () => ({ kind: "account", account_id: "replacement-life", store }), undefined, { data: { Coins: Data } });
  try {
    await page.openPicker();
    const doc = page.dom.window.document;
    await act(async () => buttonNamed(doc, "Choose new").click());
    assert.equal(doc.querySelector('[aria-labelledby="workspace-replace-title"]'), null);
    assert.equal(store.getSnapshot().focused_panel_id, "new");
    assert.deepEqual(store.getSnapshot().panels[before.focused_panel_id!], before.panels[before.focused_panel_id!]);
    assert.ok(store.getSnapshot().retained_order.includes(before.focused_panel_id!));
  } finally { await page.dispose(); }
});


test("selected coin persists durably through account exit and cold restore", async () => {
 const seeded=createWorkspaceStore();
 seeded.setPresentation("compare");
 for(const id of ["A","B","C","D"])seeded.add({panel_id:id,chain:"sui",network:"mainnet",coin_type:`0x2::coin::${id}`,presale_id:null});
 let remote=structuredClone(seeded.getSnapshot());let puts=0;
 const original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{
  if(String(url)==="/api/social/me")return Response.json({account:{account_id:"a"}});
  if(init?.method==="PUT") {const body=JSON.parse(String(init.body));remote=body.workspace;puts++;return Response.json({account_id:"a",sequence:body.sequence,revision:String(puts+1),saved_at_ms:1800000000000});}
  return Response.json({account_id:"a",workspace:remote,revision:"1",saved_at_ms:1800000000000});
 };
 function Data(){const {dispatch}=useWorkspace();return <button onClick={()=>dispatch.add({panel_id:"new",chain:"sui",network:"mainnet",coin_type:"0x2::coin::NEW",presale_id:null})}>Choose new</button>;}
 const page=await mounted(async()=>({kind:"account",account_id:"a"}),undefined,{data:{Coins:Data}});
 try {
    await page.openPicker();
  // The account API needs auth; the test-only token is local and never sent outside mocked fetch.
  await page.render({getAccessToken:async()=>"synthetic-token"});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
  const choose=[...page.dom.window.document.querySelectorAll('button')].find(b=>b.textContent==="Choose new");assert.ok(choose);
  await act(async()=>choose.click());
  assert.equal(page.dom.window.document.querySelector('[aria-labelledby="workspace-replace-title"]'), null);
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,650));});
  await act(async()=>page.root.render(null));
  assert.equal(remote.focused_panel_id,"new");
  assert.equal(createWorkspaceStore(remote).getSnapshot().focused_panel_id,"new");
  assert.ok(remote.panels.A, "previous coin draft remains saved");
  assert.equal(puts,1);
 } finally {await page.dispose();globalThis.fetch=original;}
});


test("opening a saved coin focuses it without a replacement dialog", async () => {
 const store = managementSeed().store;
 const page = await mounted(async () => ({ kind: "account", account_id: "history-focus", store }));
 try {
  const doc = page.dom.window.document;
  await act(async () => buttonNamed(doc, "Recent panels (2)").click());
  await act(async () => buttonNamed(doc, "Open F panel").click());
  await settleMenu();
  assert.equal(store.getSnapshot().focused_panel_id, "F");
  assert.equal(doc.activeElement?.closest("[data-panel-id]")?.getAttribute("data-panel-id"), "F");
  assert.equal(doc.querySelector('[aria-labelledby="workspace-replace-title"]'), null);
 } finally { await page.dispose(); }
});




function historyStageSeed() {
  const store=createWorkspaceStore();
  store.setPresentation("compare");
  for(const id of ["A","B","C","D"])store.add({panel_id:id,chain:"sui",network:"mainnet",coin_type:`0x2::coin::${id}`,presale_id:null});
  store.add({panel_id:"H",chain:"sui",network:"mainnet",coin_type:"0x2::coin::H",presale_id:"sale-h"},null);
  presaleHistory(store).add("H");
  presaleHistory(store).add("A");
  return store;
}

test("opening retained presale history preserves intent until the user selects Coin", async () => {
  const store = historyStageSeed();
  let dispatch: ReturnType<typeof useWorkspace>["dispatch"];
  function Data() { const value = useWorkspace().dispatch; useEffect(() => { dispatch = value; }, [value]); return <p>History fixture</p>; }
  const page = await mounted(async () => ({ kind: "account", account_id: "history-intent", store }), undefined, { data: { Coins: Data } });
  try {
    await page.openPicker();
    const before = store.getSnapshot();
    await act(async () => dispatch!.add(before.panels.H!));
    assert.equal(store.getSnapshot().focused_panel_id, "H");
    assert.equal(store.getSnapshot().panels.H!.active_namespace, "presale");
    assert.equal(presaleHistory(store).has("H"), true);
    await act(async () => dispatch!.patchPanel("H", { active_namespace: "coin" }));
    assert.equal(store.getSnapshot().panels.H!.active_namespace, "coin");
    assert.equal(presaleHistory(store).has("H"), false);
    assert.equal(presaleHistory(store).has("A"), true);
    assert.deepEqual(store.getSnapshot().panels.A, before.panels.A);
  } finally { await page.dispose(); }
});

test("inline panels keep independent inputs while responsive selection and order change", async () => {
  const store=createWorkspaceStore();
  for(const id of ["A","B"])store.add({panel_id:id,chain:"sui",network:"mainnet",coin_type:`0x2::coin::${id}`,presale_id:null});
  store.focus("A");store.selectMobile("A");store.setDataCollapsed(true);
  const saved=encodeWorkspace(store.getSnapshot());assert.ok(saved.ok);
  let currentDispatch:import("./model").WorkspaceStore|undefined;
  function Panel({panel}:Readonly<{panel:import("@blast/core/modules/social/blast-workspace/setup.ts").PanelSetup}>){
    const {dispatch,presentation}=useWorkspace();
    useEffect(()=>{currentDispatch=dispatch;},[dispatch]);
    return <input data-visible={presentation.visible_panel_ids.includes(panel.panel_id)} aria-label={`Trade ${panel.panel_id}`} defaultValue={panel.panel_id}/>;
  }
  for(const mobile of [false,true]){
    const page=await mounted(guest,saved.bytes,{panel:Panel},undefined,mobile);
    try{
      const doc=page.dom.window.document;
      if(mobile) await choose(doc,"Selected asset panel","B panel");
      else await act(async()=>doc.querySelector<HTMLElement>('[aria-label="Remove B panel"]')!.focus());
      assert.equal(doc.querySelector('[data-panel-id="B"]')?.getAttribute('data-active'),"true");
      const input=doc.querySelector<HTMLInputElement>('[aria-label="Trade B"]')!;
      assert.ok(input);
      assert.equal(doc.querySelector('[role="dialog"],dialog'),null);
      if(mobile){
        await act(async()=>currentDispatch!.setDataCollapsed(false));
        assert.equal(input.dataset.visible,"false");
        await act(async()=>currentDispatch!.setDataCollapsed(true));
        assert.equal(input.dataset.visible,"true");
      }
      await act(async()=>currentDispatch!.reorder(["B","A"]));
      assert.ok(input === doc.querySelector('[aria-label="Trade B"]'));
      await act(async()=>currentDispatch!.remove("A"));
      assert.equal(input.value,"B");
      await act(async()=>currentDispatch!.remove("B"));
      assert.equal(doc.querySelector('[aria-label="Trade B"]'),null);
    }finally{await page.dispose();}
  }
});

test("the board never rearranges: Layout offers no moving, and its splitters resize within 15% of the board and persist", async () => {
  const { CoinWorkspaceLayout } = await import("./WorkspaceLayout");
  const store = managementSeed(4).store;
  function Panel() { return <CoinWorkspaceLayout sections={{ chart: <p>Chart</p>, trade: <input aria-label="Draft" defaultValue="42." />, activity: <p>Activity</p>, details: <p>Details</p> }} />; }
  const page = await mounted(async () => ({ kind: "account", account_id: "layout", store }), undefined, { panel: Panel });
  try {
    const doc = page.dom.window.document;
    // The approved board's viewport (1440x1156): the holders card's default is the board's 350.
    Object.defineProperty(page.dom.window, "innerHeight", { value: 1156, configurable: true });
    await act(async () => { page.dom.window.dispatchEvent(new page.dom.window.Event("resize")); });
    const key = async (element: Element, name: string) => { await act(async () => { element.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: name, bubbles: true })); }); };
    const menuItems = () => [...doc.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemcheckbox"]')];
    await act(async () => { const trigger = buttonNamed(doc, "Layout"); trigger.focus(); trigger.click(); });
    await settleMenu();
    // Owner, 2026-10-27: components never move; Layout keeps the holders card and the sizes.
    // Live audit F36: Restore shows only once something was resized.
    assert.deepEqual(menuItems().map(item => item.textContent!.replace(/\s+/g, " ").trim()), ["Holders and activity", "Keyboard shortcuts ?"]);
    await key(doc.activeElement ?? doc.body, "Escape");
    await settleMenu();
    assert.equal(doc.querySelector('[data-section-handle], [aria-label^="Move Trade"], [aria-label^="Move Chart"]'), null, "no section can be moved");
    assert.deepEqual([...doc.querySelectorAll("[data-workspace-section]")].map(section => section.getAttribute("data-workspace-section")).slice(0, 3), ["chart", "trade", "activity"]);
    const ticket = doc.querySelector<HTMLElement>('[data-board-splitter="ticket"]')!;
    const holders = doc.querySelector<HTMLElement>('[data-board-splitter="holders"]')!;
    assert.deepEqual([ticket.getAttribute("role"), ticket.getAttribute("aria-orientation"), ticket.getAttribute("aria-valuenow"), ticket.getAttribute("aria-valuemin"), ticket.getAttribute("aria-valuemax")], ["separator", "vertical", "340", "289", "391"]);
    assert.deepEqual([holders.getAttribute("aria-orientation"), holders.getAttribute("aria-valuenow"), holders.getAttribute("aria-valuemin"), holders.getAttribute("aria-valuemax")], ["horizontal", "350", "298", "402"]);
    const draft = doc.querySelector('input[aria-label="Draft"]');
    await key(ticket, "ArrowLeft");
    assert.equal(store.getSnapshot().layout?.heights?.trade, 348, "left widens the ticket column");
    await key(ticket, "End");
    assert.equal(store.getSnapshot().layout?.heights?.trade, 391);
    await key(doc.querySelector('[data-board-splitter="ticket"]')!, "ArrowLeft");
    assert.equal(store.getSnapshot().layout?.heights?.trade, 391, "never wider than 15% over the board");
    await key(doc.querySelector('[data-board-splitter="ticket"]')!, "Home");
    assert.equal(store.getSnapshot().layout?.heights?.trade, 289);
    await key(doc.querySelector('[data-board-splitter="holders"]')!, "ArrowUp");
    assert.equal(store.getSnapshot().layout?.heights?.activity, 358, "up raises the holders card");
    assert.equal(doc.querySelector('input[aria-label="Draft"]'), draft, "resizing keeps the sections mounted");
    assert.equal(doc.querySelector('[data-board-splitter="holders"]')!.getAttribute("aria-valuenow"), "358");
    await act(async () => buttonNamed(doc, "Layout").click());
    await act(async () => menuItems().find(item => item.textContent === "Restore default sizes")!.click());
    await settleMenu();
    assert.equal(store.getSnapshot().layout?.heights, undefined, "the board's sizes are not stored");
    assert.equal(doc.querySelector('[data-board-splitter="ticket"]')!.getAttribute("aria-valuenow"), "340");
    await act(async () => buttonNamed(doc, "Layout").click());
    await act(async () => menuItems().find(item => item.textContent!.includes("Holders and activity"))!.click());
    await settleMenu();
    assert.deepEqual(store.getSnapshot().layout?.hidden, ["activity"]);
    assert.equal(doc.querySelector('[data-board-splitter="holders"]'), null, "no holders card, no holders splitter");
  } finally { await page.dispose(); }
});

test("the holders card's default follows the viewport: the board's 350 on its 1156px viewport, room for a laptop's plot below", async () => {
  const { boardBands } = await import("./workspace-board");
  assert.equal(boardBands(1400).holders.default, 350, "never taller than the board's");
  assert.equal(boardBands(900).holders.default, 254);
  assert.equal(boardBands(740).holders.default, 224, "never under 200; the short-screen floor tapers to it");
  assert.equal(boardBands(600).holders.default, 280, "a board that scrolls anyway keeps two holdings in view");
  // The splitter's band is 15% either side of the default; the ticket's stays around the board's 340.
  assert.deepEqual(boardBands(1156), { ticket: { default: 340, min: 289, max: 391 }, holders: { default: 350, min: 298, max: 402 } });
  assert.deepEqual(boardBands(800).holders, { default: 216, min: 184, max: 248 });
});

test("the focus board's expand shows the chart card alone over the whole page; the other sections keep their place", async () => {
  const { CoinWorkspaceLayout } = await import("./WorkspaceLayout");
  const { PanelHeaderSlotContext } = await import("./panels/panel-context");
  const store = managementSeed(4).store;
  function Panel() {
    const slot = useContext(PanelHeaderSlotContext);
    return <CoinWorkspaceLayout sections={{ chart: <section><div data-panel-header-slot="" ref={slot} /></section>, trade: <p>Trade</p>, activity: <p>Activity</p>, details: null }} />;
  }
  const page = await mounted(async () => ({ kind: "account", account_id: "expand", store }), undefined, { panel: Panel });
  try {
    const doc = page.dom.window.document;
    const panel = doc.querySelector<HTMLElement>('[data-panel-id="Asset0"]')!;
    assert.equal(panel.getAttribute("data-expand"), "chart", "the header lives in the chart card");
    await act(async () => buttonNamed(doc, "Expand Asset0 panel").click());
    assert.equal(panel.getAttribute("data-expanded"), "true");
    assert.ok(panel.querySelector('[data-workspace-section="chart"] [aria-label="Restore Asset0 panel"]'), "Restore sits in the chart card's header");
    await act(async () => { panel.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(panel.getAttribute("data-expanded"), "false", "Escape restores it");
  } finally { await page.dispose(); }
});


test("switching the current coin preserves mounted drafts and synchronizes desktop and mobile", async () => {
  const store = managementSeed().store;
  store.setDataCollapsed(true);
  const before = store.getSnapshot();
  const Panel: NonNullable<WorkspaceSlots["panel"]> = ({panel}) => <input aria-label={`Draft ${panel.panel_id}`} defaultValue={panel.coin.trade.buy.typed}/>;
  const page = await mounted(async () => ({kind:"account",account_id:"focus",store}), undefined, {panel:Panel});
  try {
    const doc = page.dom.window.document;
    const input = doc.querySelector<HTMLInputElement>('[aria-label="Draft A"]')!;
    assert.equal(store.getSnapshot().presentation, "focus");
    assert.equal(doc.querySelectorAll('[data-focus-hidden="false"]').length, 1);
    assert.equal(doc.querySelector('[aria-label="Draft A"]'), input);
    await act(async () => doc.querySelector<HTMLButtonElement>('[data-panel-chip="B"]')!.click());
    assert.equal(store.getSnapshot().focused_panel_id, "B");
    assert.equal(store.getSnapshot().mobile_panel_id, "B");
    assert.deepEqual(store.getSnapshot().desktop_slots, before.desktop_slots);
    assert.deepEqual(store.getSnapshot().retained_order, before.retained_order);
    assert.deepEqual(store.getSnapshot().panels, before.panels);
    assert.equal(doc.querySelector('[aria-label="Draft A"]'), input);
  } finally { await page.dispose(); }
});


test("Escape in Discover's search clears the text and keeps Discover open, the next Escape closes it; a checkbox and a closed select close at once; an IME Escape does nothing", async () => {
  const store = managementSeed().store;
  store.selectDataView("Coins");
  store.setDataCollapsed(false);
  function Coins() {
    const [search, setSearch] = useState("pepe");
    return <><input aria-label="Search coins" type="search" value={search} onChange={event => setSearch(event.currentTarget.value)} /><input aria-label="Hide small" type="checkbox" /><select aria-label="Sort"><option>New</option></select></>;
  }
  let exits = 0;
  const page = await mounted(async () => ({ kind: "account", account_id: "focus-escape", store }), undefined, { data: { Coins } }, undefined, false, () => { exits += 1; });
  try {
    const doc = page.dom.window.document;
    assert.equal(store.getSnapshot().presentation, "focus");
    const escape = async (label: string, init: KeyboardEventInit = {}) => {
      const field = doc.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
      field.focus();
      await act(async () => { field.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init })); });
    };
    // Safari's IME Escape (keyCode 229, isComposing already false) cancels the candidate only: no clear, no collapse, no exit.
    await escape("Search coins", { keyCode: 229 });
    assert.equal(doc.querySelector<HTMLInputElement>('[aria-label="Search coins"]')!.value, "pepe");
    assert.equal(store.getSnapshot().data.collapsed, false);
    assert.equal(exits, 0, "an IME Escape never reaches the frame's exit");
    await escape("Search coins");
    assert.equal(doc.querySelector<HTMLInputElement>('[aria-label="Search coins"]')!.value, "");
    assert.equal(store.getSnapshot().data.collapsed, false, "the first Escape only clears the search");
    await escape("Search coins");
    assert.equal(store.getSnapshot().data.collapsed, true, "the second Escape closes Discover");
    await act(async () => store.setDataCollapsed(false));
    await escape("Hide small");
    assert.equal(store.getSnapshot().data.collapsed, true, "a checkbox is not a field with text");
    await act(async () => store.setDataCollapsed(false));
    await escape("Sort");
    assert.equal(store.getSnapshot().data.collapsed, true, "a closed select closes Discover, not all of Blast mode");
    assert.equal(exits, 0, "no Escape in Discover left Blast mode");
  } finally { await page.dispose(); }
});

test("Recent shows each coin's contract inline with its copy; one Escape closes Recent and a quick second Escape stays in Blast mode", async () => {
  const seed = managementSeed();
  let exits = 0;
  const page = await mounted(guest, seed.bytes, undefined, undefined, false, () => { exits += 1; });
  try {
    const doc = page.dom.window.document;
    // The frame compares Escape timestamps, so the second press is stamped just inside the settle window, not left to the host's speed.
    const escape = async (timeStamp?: number) => act(async () => {
      const event = new page.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      if (timeStamp !== undefined) Object.defineProperty(event, "timeStamp", { value: timeStamp });
      (doc.activeElement ?? doc.body).dispatchEvent(event);
      return event.timeStamp;
    });
    const trigger = buttonNamed(doc, "Recent panels (2)");
    await act(async () => trigger.click());
    await settleMenu();
    const rows = [...doc.querySelectorAll("[data-retained-panel-id]")];
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.match(row.textContent ?? "", /0x\w{4}…\w{4}/, "the short contract is in the row");
      assert.ok(row.querySelector('button[aria-label^="Copy "][aria-label$=" coin type"]'), "the row copies its own coin type");
    }
    const first = await escape();
    await settleMenu();
    assert.equal(trigger.getAttribute("aria-expanded"), "false", "one Escape closes Recent");
    await escape(first + ESCAPE_SETTLE_MS - 1);
    assert.equal(exits, 0, "an Escape right after a layer closed never exits");
  } finally {
    await page.dispose();
  }
});

test("Escape while picking a coin for a chart cancels the pick: Discover returns to how it was and focus returns to Change coin", async () => {
  const { PanelAssetContext } = await import("./panels/panel-context");
  function Panel() {
    const change = useContext(PanelAssetContext);
    return <button type="button" onClick={() => change?.()}>Change coin</button>;
  }
  function Coins() { return <input aria-label="Search coins" type="search" defaultValue="" />; }
  // Every snapshot opens in focus (Compare is retired); Discover open or closed before, and with text typed in the search first.
  const rows = [{ collapsed: false }, { collapsed: true }, { collapsed: false, text: "kstl" }] as const;
  for (const row of rows) {
    const { collapsed } = row;
    const store = managementSeed().store;
    store.selectDataView("Coins");
    store.setDataCollapsed(collapsed);
    let exits = 0;
    const page = await mounted(async () => ({ kind: "account", account_id: `pick-escape-${collapsed}-${"text" in row}`, store }), undefined, { panel: Panel, data: { Coins } }, undefined, false, () => { exits += 1; });
    try {
      const doc = page.dom.window.document;
      const label = `${"text" in row ? "with text, " : ""}Discover ${collapsed ? "closed" : "open"} before`;
      const notice = () => /Choose an asset/.test(doc.querySelector("#workspace-data")!.textContent ?? "");
      const frame = () => act(async () => { await new Promise(resolve => page.dom.window.requestAnimationFrame(resolve)); });
      const trigger = [...doc.querySelectorAll<HTMLButtonElement>("[data-panel-id] button")].find(button => button.textContent === "Change coin")!;
      trigger.focus();
      await act(async () => trigger.click());
      await frame();
      assert.equal(store.getSnapshot().data.collapsed, false, `${label}: the pick opens Discover`);
      assert.ok(notice(), `${label}: the pick shows its notice`);
      const search = doc.querySelector<HTMLInputElement>('[aria-label="Search coins"]')!;
      search.focus();
      const escape = () => act(async () => { search.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
      if ("text" in row) {
        search.value = row.text;
        await escape();
        assert.equal(search.value, "", `${label}: the first Escape clears the text`);
        assert.ok(notice(), `${label}: the first Escape keeps the pick`);
        assert.equal(doc.activeElement, search);
      }
      await escape();
      await frame();
      assert.equal(notice(), false, `${label}: the pick is cancelled`);
      assert.equal(store.getSnapshot().presentation, "focus", `${label}: the layout is unchanged`);
      assert.equal(store.getSnapshot().focused_panel_id, "A", `${label}: the same coin stays in focus`);
      assert.equal(store.getSnapshot().data.collapsed, collapsed, `${label}: Discover is as it was`);
      assert.equal(doc.activeElement, trigger, `${label}: focus returns to Change coin`);
      assert.equal(exits, 0, `${label}: Blast mode stays open`);
    } finally { await page.dispose(); }
  }
});

test("removing the final saved panel keeps the empty shell open and restores valid focus", async () => {
  const store = managementSeed().store;
  const page = await mounted(async () => ({ kind: "account", account_id: "saved-empty", store }));
  try {
    const doc = page.dom.window.document;
    await act(async () => buttonNamed(doc, "Recent panels (2)").click());
    for (const name of ["F", "E"]) {
      await act(async () => { const remove = buttonNamed(doc, `Remove ${name} from Recent`); remove.focus(); remove.click(); });
      await settleMenu();
    }
    assert.match(doc.body.textContent!, /No recent panels/);
    assert.equal(doc.activeElement, buttonNamed(doc, "Close recent panels"));
    await act(async () => buttonNamed(doc, "Close recent panels").click());
    await settleMenu();
    assert.notEqual(doc.activeElement, doc.body);
    assert.ok(doc.activeElement?.isConnected);
  } finally { await page.dispose(); }
});

test("an expanded panel follows inserted and removed activity without a layout resize", async () => {
  const store = managementSeed().store;
  const page = await mounted(async () => ({ kind: "account", account_id: "expanded-offset", store }));
  try {
    const doc = page.dom.window.document;
    const panel = doc.querySelector<HTMLElement>('[data-panel-id="A"]')!;
    const layout = panel.closest<HTMLElement>("[data-data-open]")!;
    let top = 72;
    layout.getBoundingClientRect = () => new page.dom.window.DOMRect(0, top, 800, 400);
    await act(async () => buttonNamed(doc, "Expand A panel").click());
    assert.equal(panel.style.getPropertyValue("--expanded-top"), "72px");
    const activity = doc.createElement("header");
    activity.textContent = "Following activity";
    await act(async () => {
      top = 124;
      layout.before(activity);
      await Promise.resolve();
    });
    assert.equal(panel.style.getPropertyValue("--expanded-top"), "124px");
    await act(async () => {
      top = 72;
      activity.remove();
      await Promise.resolve();
    });
    assert.equal(panel.style.getPropertyValue("--expanded-top"), "72px");
  } finally { await page.dispose(); }
});
