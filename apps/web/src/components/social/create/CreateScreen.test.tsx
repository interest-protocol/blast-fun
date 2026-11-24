import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { installTestDom, recordAnimations, setInputValue, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import type { SocialMeAccount } from "@blast/core/modules/social/contracts/me.ts";
import { CREATE_DEFAULT_FEE_POLICY } from "@blast/core/modules/social/create/model.ts";
import { CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE, SOCIAL_CREATE_DRAFTS_PATH, type CreateDraftResponse } from "@blast/core/modules/social/contracts/create.ts";
import { socialPricesPath } from "@blast/core/modules/social/contracts/prices.ts";
import { GUEST_DRAFT_KEY, RETAINED_GUEST_DRAFT_KEY, GUEST_DRAFT_SCHEMA, GUEST_DRAFT_ACKNOWLEDGED_KEY, guestSourceDigest } from "./guest-draft-storage.ts";

const dom = installTestDom();
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SocialViewerProvider } = await import("../SignInGate");
const { SocialAccountContext } = await import("../use-social-account");
const { ShellActionsProvider, useShellAction } = await import("../../blast-ui/shell-actions");
const { CreateForm } = await import("./CreateForm");
const { CreateScreen } = await import("./CreateScreen");
const { CreateView } = await import("./CreateView");
const { filledSample } = await import("../../../../../../packages/core/test/fixtures/social/create/create-fixtures.ts");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch: async () => {},
  hmrRefresh() {},
  bfcacheId: "test",
};
const { createStore } = await import("./create-store");
const { getQueryClient } = await import("#web/lib/query/client.ts");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("#web/lib/query/test-client.ts");

const account: SocialMeAccount = {
  account_id: "new-owner", kind: "new", callsign: "pilot", display_name: null, avatar_url: null,
  x_handle: null, verified: false, onboarding: { shown: true, completed: true }, privacy: "private",
  sharing_since_ms: null, wallets: [],
};
// The list producer always includes this saved-draft summary beside its ID.
const draftSummaryFields = { version: 1, name: "Saved draft", symbol: "SAVE", target: 1000, logo_url: null, updated_at_ms: 2 };
const publish = { available: false, reasons: ["presale_not_deployed"] } as const;
// The page keeps its step in the URL hash; each test starts without one.
beforeEach(() => dom.window.history.replaceState(null, "", "/"));
after(() => getQueryClient().clear());

test("Create updates the target check when the selected coin’s price arrives", async () => {
  const previousFetch = globalThis.fetch;
  const price = Promise.withResolvers<Response>();
  globalThis.fetch = async (input) => {
    assert.equal(String(input), socialPricesPath({ coins: [CREATE_SUI_QUOTE_TYPE], window: "1h" }));
    return price.promise;
  };
  const client = createTestQueryClient();
  const quotes = [CREATE_TEST_SUI_QUOTE_TYPE];
  createStore.reset({ quotes, draft: { ...filledSample(), quote_type: CREATE_TEST_SUI_QUOTE_TYPE, target: 499.99 }, step: "raise", tried: true, dirty: true });
  dom.window.sessionStorage.clear();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const message = () => container.querySelector("#cr-error-target")?.textContent;
  try {
    await act(async () => root.render(withQueryClient(client, <AppRouterContext value={router}>
      <SocialAccountContext value={{ status: "signed_out", account: null, refresh() {} }}>
        <SocialViewerProvider signedIn={false}>
          <CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={{ available: true }} quotes={quotes} suiPrice={null} />
        </SocialViewerProvider>
      </SocialAccountContext>
    </AppRouterContext>)));
    assert.match(message() ?? "", /Wait for a price or choose another raise coin/);
    const now = Date.now();
    await act(async () => {
      price.resolve(Response.json({
        window: "1h", clock_ms: now, as_of: { checkpoint: 1, timestamp_ms: now, lag_ms: 0 },
        prices: [{
          presale_id: null, coin_type: CREATE_SUI_QUOTE_TYPE, tier: "5m", from_ms: 0, points: [],
          price_usd: "2", price_as_of_ms: now, price_24h_usd: null, change_24h_bps: null, day_open_usd: null, day_open_ms: null,
        }],
      }));
      await settleQueries(client);
    });
    assert.match(message() ?? "", /Set a target of at least 500\sTSUI/);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    createStore.reset();
    dom.window.sessionStorage.clear();
    globalThis.fetch = previousFetch;
  }
});

test("guest recovery file selection rejects an unrelated receipt and requires explicit adoption of a verified import", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("guest recovery must not contact an account or chain service");
  createStore.reset(); dom.window.sessionStorage.clear();
  const source = "  retained source bytes\n";
  dom.window.sessionStorage.setItem(RETAINED_GUEST_DRAFT_KEY, source);
  const container = dom.document.createElement("div"); dom.document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<AppRouterContext value={router}><SocialAccountContext value={{ status: "signed_out", account: null, refresh() {} }}><SocialViewerProvider signedIn={false} getAccessToken={async () => null}><CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={[filledSample().quote_type]} suiPrice={null} /></SocialViewerProvider></SocialAccountContext></AppRouterContext>));
    const recovered = { ...filledSample(), name: "Verified recovered draft" };
    const select = async (receipt: string) => {
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = new File([JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: recovered, recovered_from: receipt })], "recovered.json", { type: "application/json" });
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      await act(async () => { input.dispatchEvent(testEvent("change")); await new Promise((resolve) => setTimeout(resolve, 0)); });
    };
    await select(guestSourceDigest("unrelated source"));
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /valid canonical recovery file/);
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), source);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), null);
    assert.equal(createStore.get().draft.name, "");
    const validFile = JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: { ...recovered, name: "INVALID_BYTE_MARKER" }, recovered_from: guestSourceDigest(source) });
    const damaged = Buffer.concat([Buffer.from(validFile.split("INVALID_BYTE_MARKER")[0]!), Buffer.from([0xff]), Buffer.from(validFile.split("INVALID_BYTE_MARKER")[1]!)]);
    const damagedInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(damagedInput, "files", { value: [new File([damaged], "damaged.json", { type: "application/json" })], configurable: true });
    await act(async () => { damagedInput.dispatchEvent(testEvent("change")); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), null, "invalid UTF-8 must not become replacement characters in an adopted draft");
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /valid canonical recovery file/);
    await select(guestSourceDigest(source));
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.equal(createStore.get().draft.name, "", "file selection and readback do not adopt a draft");
    const use = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use recovered draft")!;
    await act(async () => use.click());
    assert.equal(createStore.get().draft.name, recovered.name);
    assert.equal(createStore.get().ownerId, null);
    assert.equal(createStore.get().draftId, null);
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), source, "guest adoption retains backup before any account save");
  } finally { await act(async () => root.unmount()); container.remove(); createStore.reset(); dom.window.sessionStorage.clear(); globalThis.fetch = previousFetch; }
});

test("an adopted guest stays editable through in-page sign-in and a pending or failed first save", async () => {
  const previousFetch = globalThis.fetch;
  const pending = Promise.withResolvers<Response>();
  const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, "PUT", "the adopted guest must not load or replace an existing account draft");
    writes.push(String(input));
    return pending.promise;
  };
  createStore.reset(); dom.window.sessionStorage.clear();
  const source = "retained adopted guest before sign-in";
  const recovered = { ...filledSample(), name: "Guest becoming account draft" };
  const canonical = JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: recovered, recovered_from: guestSourceDigest(source) });
  dom.window.sessionStorage.setItem(RETAINED_GUEST_DRAFT_KEY, source);
  dom.window.sessionStorage.setItem(GUEST_DRAFT_KEY, canonical);
  const container = dom.document.createElement("div"); dom.document.body.append(container); const root = createRoot(container);
  const render = async (signedIn: boolean) => act(async () => root.render(<AppRouterContext value={router}><SocialAccountContext value={{ status: signedIn ? "ready" : "signed_out", account: signedIn ? account : null, refresh() {} }}><SocialViewerProvider signedIn={signedIn} getAccessToken={async () => signedIn ? "token" : null}><CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={[filledSample().quote_type]} suiPrice={null} /></SocialViewerProvider></SocialAccountContext></AppRouterContext>));
  try {
    await render(false);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use recovered draft")!.click());
    assert.equal(createStore.get().ownerId, null);
    const adoptedCanonical = dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY);
    assert.equal(JSON.parse(adoptedCanonical!).recovered_from, guestSourceDigest(source));
    await render(true);
    assert.equal(container.querySelector("[data-guest-recovery]") === null, true, "sign-in must carry the adopted choice into account-backed editing");
    assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Name"]')!.value, recovered.name);
    const adoptedId = createStore.get().draftId;
    assert.ok(adoptedId);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 850)));
    assert.equal(writes.length, 1);
    assert.equal(container.querySelector("[data-guest-recovery]") === null, true, "the pending first save must not hide the adopted draft");
    await act(async () => pending.resolve(Response.json({ error: { code: "draft_limit", message: "Synthetic draft limit" } }, { status: 409 })));
    assert.equal(container.querySelector("[data-guest-recovery]") === null, true, "a refused first save must leave the guest editable");
    assert.equal(createStore.get().draftId, adoptedId);
    assert.equal(createStore.get().dirty, true);
    const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
    await act(async () => { setInputValue(input, "Editable after refusal"); input.dispatchEvent(testEvent("input")); });
    assert.equal(createStore.get().draft.name, "Editable after refusal");
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), source);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), adoptedCanonical);
  } finally { await act(async () => root.unmount()); container.remove(); createStore.reset(); dom.window.sessionStorage.clear(); globalThis.fetch = previousFetch; }
});

test("recovered adoption waits for publish and uploads, then clears only the previous draft's transient UI", async () => {
  const previousFetch = globalThis.fetch;
  const originalId = "00000000-0000-4000-8000-000000000095";
  const original = { created_at_ms: 1, updated_at_ms: 2, published_presale_id: null, issues: [], draft_id: originalId, version: 7, draft: { ...filledSample(), name: "Original account draft" }, logo_url: null, cover: null, allowlist: null, fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [filledSample().quote_type], sui_price: null };
  globalThis.fetch = async (input, init) => {
    assert.notEqual(init?.method, "PUT", "blocked adoption must not start a save");
    assert.ok(String(input).startsWith(SOCIAL_CREATE_DRAFTS_PATH), "the recovery fixture must never reach a chain or hosted service");
    return String(input).endsWith("resume=true") ? Response.json({ next_cursor: null, items: [{ ...draftSummaryFields, draft_id: originalId }] }) : Response.json(original);
  };
  createStore.reset(); dom.window.sessionStorage.clear();
  const source = "retained while account work is active";
  const recovered = { ...filledSample(), name: "Recovered separate draft" };
  const canonical = JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: recovered, recovered_from: guestSourceDigest(source) });
  dom.window.sessionStorage.setItem(RETAINED_GUEST_DRAFT_KEY, source);
  dom.window.sessionStorage.setItem(GUEST_DRAFT_KEY, canonical);
  const container = dom.document.createElement("div"); dom.document.body.append(container); const root = createRoot(container);
  const adoptionButton = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use as a separate draft")!;
  try {
    await act(async () => root.render(<AppRouterContext value={router}><SocialAccountContext value={{ status: "ready", account, refresh() {} }}><SocialViewerProvider signedIn getAccessToken={async () => "token"}><CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={original.quotes} suiPrice={null} /></SocialViewerProvider></SocialAccountContext></AppRouterContext>));
    const idle = { publishLocked: false, publishProgress: null, logoPreview: null, coverPreview: null, allowlistUploading: false };
    for (const active of [{ publishLocked: true, publishProgress: "Register currency" }, { logoPreview: "blob:pending-logo" }, { coverPreview: "blob:pending-cover" }, { allowlistUploading: true }]) {
      await act(async () => createStore.set({ ...idle, ...active }));
      const before = createStore.get();
      assert.equal(adoptionButton().disabled, true, "active publishing or upload must disable recovered adoption");
      await act(async () => adoptionButton().click());
      assert.equal(createStore.get(), before);
      assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), source);
      assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), canonical);
    }
    await act(async () => createStore.set({ ...idle, reviewOpen: true, publishProgress: "Old failed step", publishError: "Old publish error", touched: new Set(["symbol"]), tried: true, quoteOpen: true, flash: { section: "identity", path: "symbol", nonce: 1 } }));
    assert.equal(adoptionButton().disabled, false);
    await act(async () => adoptionButton().click());
    const adopted = createStore.get();
    assert.notEqual(adopted.draftId, originalId);
    assert.equal(adopted.draft.name, recovered.name);
    assert.equal(adopted.ownerId, account.account_id);
    assert.equal(adopted.version, 0);
    assert.equal(adopted.reviewOpen, false);
    assert.equal(adopted.publishLocked, false);
    assert.equal(adopted.publishProgress, null);
    assert.equal(adopted.publishError, null);
    assert.equal(adopted.logoPreview, null);
    assert.equal(adopted.coverPreview, null);
    assert.equal(adopted.allowlistUploading, false);
    assert.equal(adopted.touched.size, 0);
    assert.equal(adopted.tried, false);
    assert.equal(adopted.quoteOpen, false);
    assert.equal(adopted.flash, null);
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), source);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), canonical);
  } finally { await act(async () => root.unmount()); container.remove(); createStore.reset(); dom.window.sessionStorage.clear(); globalThis.fetch = previousFetch; }
});

test("continuing separately with unavailable browser storage preserves guest edits through sign-in and saves only to the account", async () => {
  const storageDescriptor = Object.getOwnPropertyDescriptor(dom.window, "sessionStorage");
  const previousFetch = globalThis.fetch;
  const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, "PUT", "continuing must not replace a loaded account draft or contact another service");
    writes.push(String(input));
    const body = JSON.parse(String(init?.body));
    return Response.json({ created_at_ms: 1, updated_at_ms: 2, published_presale_id: null, issues: [], draft_id: String(input).split("/").at(-1), version: 1, draft: body.draft, logo_url: null, cover: null, allowlist: null, fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [filledSample().quote_type], sui_price: null });
  };
  createStore.reset(); dom.window.sessionStorage.clear();
  Object.defineProperty(dom.window, "sessionStorage", { configurable: true, get() { throw new Error("Synthetic browser storage unavailable"); } });
  const container = dom.document.createElement("div"); dom.document.body.append(container); const root = createRoot(container);
  const render = async (signedIn: boolean) => act(async () => root.render(<AppRouterContext value={router}><SocialAccountContext value={{ status: signedIn ? "ready" : "signed_out", account: signedIn ? account : null, refresh() {} }}><SocialViewerProvider signedIn={signedIn} getAccessToken={async () => signedIn ? "token" : null}><CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={[filledSample().quote_type]} suiPrice={null} /></SocialViewerProvider></SocialAccountContext></AppRouterContext>));
  try {
    await render(false);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Continue with a separate draft")!.click());
    assert.equal(container.querySelector("[data-guest-recovery]") === null, true);
    assert.match(container.querySelector('[role="status"]')!.textContent!, /not saved in this browser/);
    assert.equal(dom.document.activeElement?.textContent, "Create a presale", "leaving recovery must focus the visible page heading");
    const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
    await act(async () => { setInputValue(input, "Separate account-bound draft"); input.dispatchEvent(testEvent("input")); });
    assert.equal(createStore.get().draft.name, "Separate account-bound draft");
    assert.equal(writes.length, 0);
    await render(true);
    assert.equal(container.querySelector("[data-guest-recovery]") === null, true);
    assert.equal(createStore.get().draft.name, "Separate account-bound draft");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 850)));
    assert.equal(writes.length, 1);
    assert.equal(createStore.get().version, 1);
    assert.equal(createStore.get().ownerId, account.account_id);
    assert.match(container.querySelector('[role="status"]')!.textContent!, /saves to your account/);
  } finally {
    await act(async () => root.unmount()); container.remove(); createStore.reset(); globalThis.fetch = previousFetch;
    if (storageDescriptor) Object.defineProperty(dom.window, "sessionStorage", storageDescriptor);
    else delete (dom.window as unknown as { sessionStorage?: Storage }).sessionStorage;
    dom.window.sessionStorage.clear();
  }
});

test("a successful adopted account save reports browser acknowledgement failure without claiming that the account save failed", async () => {
  const previousFetch = globalThis.fetch;
  const pending = Promise.withResolvers<Response>();
  const originalId = "00000000-0000-4000-8000-000000000096";
  const saved = { created_at_ms: 1, updated_at_ms: 2, published_presale_id: null, issues: [], draft_id: originalId, version: 7, draft: filledSample(), logo_url: null, cover: null, allowlist: null, fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [filledSample().quote_type], sui_price: null };
  globalThis.fetch = async (input, init) => init?.method === "PUT" ? pending.promise : String(input).endsWith("resume=true") ? Response.json({ next_cursor: null, items: [{ ...draftSummaryFields, draft_id: originalId }] }) : Response.json(saved);
  createStore.reset(); dom.window.sessionStorage.clear();
  const storage = dom.window.sessionStorage;
  const setItem = storage.setItem;
  const storagePrototype = Object.getPrototypeOf(storage);
  const descriptor = Object.getOwnPropertyDescriptor(storagePrototype, "setItem")!;
  let refusedAcknowledgements = 0;
  const source = "source kept when durable acknowledgement is unavailable";
  const canonical = JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: { ...filledSample(), name: "Saved recovered body" }, recovered_from: guestSourceDigest(source) });
  storage.setItem(RETAINED_GUEST_DRAFT_KEY, source); storage.setItem(GUEST_DRAFT_KEY, canonical);
  const container = dom.document.createElement("div"); dom.document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<AppRouterContext value={router}><SocialAccountContext value={{ status: "ready", account, refresh() {} }}><SocialViewerProvider signedIn getAccessToken={async () => "token"}><CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={saved.quotes} suiPrice={null} /></SocialViewerProvider></SocialAccountContext></AppRouterContext>));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use as a separate draft")!.click());
    const adoptedId = createStore.get().draftId;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 850)));
    Object.defineProperty(storagePrototype, "setItem", { configurable: true, value(this: Storage, key: string, value: string) {
      if (key === GUEST_DRAFT_ACKNOWLEDGED_KEY) {
        refusedAcknowledgements += 1;
        throw new Error("Synthetic acknowledgement write refusal");
      }
      setItem.call(this, key, value);
    } });
    await act(async () => pending.resolve(Response.json({ ...saved, draft_id: adoptedId, version: 1, draft: { ...filledSample(), name: "Saved recovered body" } })));
    assert.equal(refusedAcknowledgements, 1, "the fault must intercept the actual durable acknowledgement write");
    assert.equal(createStore.get().version, 1);
    assert.equal(createStore.get().dirty, false);
    assert.equal(container.querySelector("[data-guest-recovery]") === null, true);
    assert.equal([...container.querySelectorAll('[role="status"]')].some((message) => message.textContent?.includes("account saved this draft, but browser backup cleanup could not finish")), true, "the successful account save must be distinguished from browser cleanup refusal");
    assert.equal(storage.getItem(RETAINED_GUEST_DRAFT_KEY), source);
    assert.equal(storage.getItem(GUEST_DRAFT_KEY), canonical);
    assert.equal(storage.getItem(GUEST_DRAFT_ACKNOWLEDGED_KEY), null);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Review browser draft")!.click());
    assert.equal(container.querySelector("h1")?.textContent, "This browser draft was already saved", "Opus N6 remembers successful account adoption even when its durable marker write was refused");
    assert.equal([...container.querySelectorAll("button")].some((button) => button.textContent?.startsWith("Use ")), false, "the same account-saved copies cannot be re-adopted in this draft lifetime");
    assert.equal(storage.getItem(RETAINED_GUEST_DRAFT_KEY), source);
    assert.equal(storage.getItem(GUEST_DRAFT_KEY), canonical);
  } finally {
    await act(async () => root.unmount()); container.remove(); createStore.reset(); globalThis.fetch = previousFetch;
    Object.defineProperty(storagePrototype, "setItem", descriptor);
    storage.clear();
  }
});

for (const failedBeforeSwitch of [false, true]) test(`a ${failedBeforeSwitch ? "failed" : "pending"} recovered save for account A cannot clear backups when account B loads its saved draft`, async () => {
  const previousFetch = globalThis.fetch;
  const response = Promise.withResolvers<Response>();
  const aId = "00000000-0000-4000-8000-000000000081";
  const bId = "00000000-0000-4000-8000-000000000082";
  const saved = (draft_id: string) => ({ created_at_ms: 1, updated_at_ms: 2, published_presale_id: null, issues: [], draft_id, version: 7, draft: { ...filledSample(), name: draft_id === aId ? "Account A saved draft" : "Account B saved draft" }, logo_url: null, cover: null, allowlist: null, fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [filledSample().quote_type], sui_price: null });
  let currentAccount = "A";
  const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method === "PUT") { writes.push(path); return response.promise; }
    const draftId = currentAccount === "A" ? aId : bId;
    return path.endsWith("resume=true") ? Response.json({ next_cursor: null, items: [{ ...draftSummaryFields, draft_id: draftId }] }) : Response.json(saved(draftId));
  };
  createStore.reset(); dom.window.sessionStorage.clear();
  const source = "retained before account switch";
  const canonical = JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: { ...filledSample(), name: "Recovered guest" }, recovered_from: guestSourceDigest(source) });
  dom.window.sessionStorage.setItem(RETAINED_GUEST_DRAFT_KEY, source);
  dom.window.sessionStorage.setItem(GUEST_DRAFT_KEY, canonical);
  const container = dom.document.createElement("div"); dom.document.body.append(container); const root = createRoot(container);
  const render = (identity: typeof account) => act(async () => root.render(<AppRouterContext value={router}><SocialAccountContext value={{ status: "ready", account: identity, refresh() {} }}><SocialViewerProvider signedIn getAccessToken={async () => "token"}><CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={[filledSample().quote_type]} suiPrice={null} /></SocialViewerProvider></SocialAccountContext></AppRouterContext>));
  try {
    await render(account);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use as a separate draft")!.click());
    const pendingId = createStore.get().draftId;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 850)));
    assert.equal(writes.length, 1);
    if (failedBeforeSwitch) {
      await act(async () => response.resolve(Response.json({ error: { code: "unavailable", message: "Synthetic failure" } }, { status: 503 })));
      assert.equal(createStore.get().dirty, true);
      assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), source);
      assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), canonical);
    }
    currentAccount = "B";
    await render({ ...account, account_id: "second-existing-account", callsign: "second" });
    assert.equal(createStore.get().draftId, bId);
    assert.equal(createStore.get().draft.name, "Account B saved draft");
    const accountBUse = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use as a separate draft")!;
    assert.equal(accountBUse().disabled, false, "an aborted account A save cannot keep account B's recovery control busy");
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), source);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), canonical);
    if (!failedBeforeSwitch) await act(async () => response.resolve(Response.json({ ...saved(pendingId!), version: 1, draft: { ...filledSample(), name: "Recovered guest" } })));
    assert.equal(createStore.get().draftId, bId);
    assert.equal(createStore.get().ownerId, "second-existing-account");
    assert.equal(accountBUse().disabled, false, "a late account A response cannot change account B's recovery choice");
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), source);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), canonical);
    assert.equal(writes.length, 1);
  } finally { await act(async () => root.unmount()); container.remove(); createStore.reset(); dom.window.sessionStorage.clear(); globalThis.fetch = previousFetch; }
});

test("unresolved guest bytes do not block account loading or overwrite its draft; explicit keep-current preserves the backup", async () => {
  const previousFetch = globalThis.fetch;
  const draftId = "00000000-0000-4000-8000-000000000071";
  const saved = { created_at_ms: 1, updated_at_ms: 2, published_presale_id: null, issues: [], draft_id: draftId, version: 7, draft: { ...filledSample(), name: "Saved account draft" }, logo_url: null, cover: null, allowlist: null, fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [filledSample().quote_type], sui_price: null };
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.notEqual(init?.method, "PUT", "unresolved guest data must not autosave a blank replacement");
    const path = String(input); calls.push(path);
    return path.endsWith("resume=true") ? Response.json({ next_cursor: null, items: [{ ...draftSummaryFields, draft_id: draftId }] }) : Response.json(saved);
  };
  createStore.reset(); dom.window.sessionStorage.clear();
  const raw = "  { retained bytes\n";
  dom.window.sessionStorage.setItem(RETAINED_GUEST_DRAFT_KEY, raw);
  const container = dom.document.createElement("div"); dom.document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<AppRouterContext value={router}><SocialAccountContext value={{ status: "ready", account, refresh() {} }}><SocialViewerProvider signedIn getAccessToken={async () => "token"}><CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={saved.quotes} suiPrice={null} /></SocialViewerProvider></SocialAccountContext></AppRouterContext>));
    assert.equal(createStore.get().draftId, draftId);
    assert.equal(createStore.get().draft.name, "Saved account draft");
    assert.equal(createStore.get().version, 7);
    assert.equal(calls.length, 2);
    assert.ok(container.querySelector("[data-guest-recovery]"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 850)));
    const keep = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Keep editing my account draft")!;
    const accountDraftBeforeKeep = createStore.get();
    let storeChanges = 0;
    const unsubscribe = createStore.subscribe(() => storeChanges++);
    await act(async () => keep.click());
    unsubscribe();
    assert.equal(storeChanges, 0, "the recovery choice must rerender without an unrelated account-store event");
    assert.equal(createStore.get(), accountDraftBeforeKeep);
    assert.equal(container.querySelector("[data-guest-recovery]") === null, true);
    assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Name"]')!.value, "Saved account draft");
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), raw);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), null);
  } finally { await act(async () => root.unmount()); container.remove(); createStore.reset(); dom.window.sessionStorage.clear(); globalThis.fetch = previousFetch; }
});

test("recovered guest adoption creates a separate draft and clears matching backups only after acknowledged save", async () => {
  const previousFetch = globalThis.fetch;
  const originalId = "00000000-0000-4000-8000-000000000072";
  const original = { created_at_ms: 1, updated_at_ms: 2, published_presale_id: null, issues: [], draft_id: originalId, version: 7, draft: { ...filledSample(), name: "Original saved draft" }, logo_url: null, cover: null, allowlist: null, fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [filledSample().quote_type], sui_price: null };
  const response = Promise.withResolvers<Response>();
  const writes: { path: string; body: { draft: typeof original.draft; version: number } }[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method === "PUT") { writes.push({ path, body: JSON.parse(String(init.body)) }); return response.promise; }
    return path.endsWith("resume=true") ? Response.json({ next_cursor: null, items: [{ ...draftSummaryFields, draft_id: originalId }] }) : Response.json(original);
  };
  createStore.reset(); dom.window.sessionStorage.clear();
  const raw = "  { retained original bytes\n";
  const recovered = { ...filledSample(), name: "Recovered token" };
  dom.window.sessionStorage.setItem(RETAINED_GUEST_DRAFT_KEY, raw);
  dom.window.sessionStorage.setItem(GUEST_DRAFT_KEY, JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: recovered, recovered_from: guestSourceDigest(raw) }));
  const container = dom.document.createElement("div"); dom.document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<AppRouterContext value={router}><SocialAccountContext value={{ status: "ready", account, refresh() {} }}><SocialViewerProvider signedIn getAccessToken={async () => "token"}><CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={original.quotes} suiPrice={null} /></SocialViewerProvider></SocialAccountContext></AppRouterContext>));
    assert.equal(createStore.get().draftId, originalId, "imported file does not silently adopt over the account draft");
    assert.equal(createStore.get().draft.name, "Original saved draft");
    const use = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use as a separate draft")!;
    await act(async () => use.click());
    const newId = createStore.get().draftId;
    assert.notEqual(newId, originalId);
    assert.equal(createStore.get().ownerId, account.account_id);
    assert.equal(createStore.get().draft.name, "Recovered token");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 850)));
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.path, `${SOCIAL_CREATE_DRAFTS_PATH}/${newId}`);
    assert.equal(writes[0]!.body.version, 0);
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), raw, "in-flight save does not clear retained source");
    await act(async () => response.resolve(Response.json({ ...original, draft_id: newId, version: 1, draft: recovered })));
    assert.equal(createStore.get().draftId, newId);
    assert.equal(createStore.get().version, 1);
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), null);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), null);
    assert.equal(original.version, 7);
    assert.equal(original.draft.name, "Original saved draft");
  } finally { await act(async () => root.unmount()); container.remove(); createStore.reset(); dom.window.sessionStorage.clear(); globalThis.fetch = previousFetch; }
});

test("keeping an account draft is an owner-scoped UI choice and never dismisses recovery for another session", async () => {
  const previousFetch = globalThis.fetch;
  let active = "A";
  globalThis.fetch = async (input, init) => {
    assert.notEqual(init?.method, "PUT");
    const draft_id = active === "A" ? "00000000-0000-4000-8000-000000000091" : "00000000-0000-4000-8000-000000000092";
    return String(input).endsWith("resume=true") ? Response.json({ next_cursor: null, items: [{ ...draftSummaryFields, draft_id }] }) : Response.json({ created_at_ms: 1, updated_at_ms: 2, published_presale_id: null, issues: [], draft_id, version: 7, draft: { ...filledSample(), name: `Account ${active} draft` }, logo_url: null, cover: null, allowlist: null, fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [filledSample().quote_type], sui_price: null });
  };
  createStore.reset(); dom.window.sessionStorage.clear();
  const raw = "retained across account choices";
  dom.window.sessionStorage.setItem(RETAINED_GUEST_DRAFT_KEY, raw);
  const container = dom.document.createElement("div"); dom.document.body.append(container); const root = createRoot(container);
  const render = async (owner: "A" | "B") => {
    active = owner;
    const identity = owner === "A" ? account : { ...account, account_id: "second-existing-account", callsign: "second" };
    await act(async () => root.render(<AppRouterContext value={router}><SocialAccountContext value={{ status: "ready", account: identity, refresh() {} }}><SocialViewerProvider signedIn getAccessToken={async () => "token"}><CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={[filledSample().quote_type]} suiPrice={null} /></SocialViewerProvider></SocialAccountContext></AppRouterContext>));
  };
  try {
    for (const owner of ["A", "B", "A"] as const) {
      await render(owner);
      assert.ok(container.querySelector("[data-guest-recovery]"), "each owner transition requires an explicit new recovery choice");
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Keep editing my account draft")!.click());
      assert.equal(container.querySelector("[data-guest-recovery]") === null, true);
      assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Name"]')!.value, `Account ${owner} draft`);
      assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), raw);
      assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), null);
    }
  } finally { await act(async () => root.unmount()); container.remove(); createStore.reset(); dom.window.sessionStorage.clear(); globalThis.fetch = previousFetch; }
});

test("launch timing can be changed independently of wallet limits", async () => {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const draft = filledSample();
  createStore.reset({ phase: "ready", draft, step: "raise" });
  const render = () => act(async () => root.render(<CreateForm state={createStore.get()} issues={[]} onLogo={() => {}} onList={() => {}} />));
  try {
    await render();
    const buttons = container.querySelectorAll<HTMLButtonElement>('#cr-launch [aria-label="Launch timing"] button');
    assert.equal(buttons.length, 2);
    await act(async () => buttons[0]!.click());
    assert.deepEqual(createStore.get().draft, { ...draft, launch_when_filled: true });
    await render();
    assert.equal(buttons[0]!.getAttribute("aria-pressed"), "true");
    const helpers = container.querySelectorAll(".cr-timing-help");
    assert.equal(helpers.length, 3);
    for (const helper of helpers) {
      assert.equal(helper.children[0]!.getAttribute("aria-hidden"), "false");
      assert.equal(helper.children[1]!.getAttribute("aria-hidden"), "true");
    }
    assert.equal(buttons[1]!.getAttribute("aria-pressed"), "false");
    await act(async () => buttons[1]!.click());
    assert.deepEqual(createStore.get().draft, draft);
    await render();
    assert.equal(buttons[0]!.getAttribute("aria-pressed"), "false");
    assert.equal(buttons[1]!.getAttribute("aria-pressed"), "true");
    for (const helper of helpers) {
      assert.equal(helper.children[0]!.getAttribute("aria-hidden"), "true");
      assert.equal(helper.children[1]!.getAttribute("aria-hidden"), "false");
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    createStore.reset();
  }
});

test("Review's Publish starts on one press for a ready draft and stays blocked during publishing", async () => {
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  let publications = 0;
  createStore.reset({ phase: "ready", draft: filledSample(), publish: { available: true }, step: "review", networkFees: "blast", bluefinOptions: { status: "ready", min_tick: -443_636, max_tick: 443_636 } });
  const render = () =>
    act(async () =>
      root.render(
        <SocialViewerProvider signedIn getAccessToken={async () => "token"}>
          <CreateView
            state={createStore.get()}
            onLogo={() => undefined}
            onList={() => undefined}
            onRetry={() => undefined}
            signIn={null}
            onPublish={() => {
              publications++;
            }}
          />
        </SocialViewerProvider>,
      ),
    );
  try {
    await render();
    const button = () => container.querySelector<HTMLButtonElement>(".cr-publish-btn")!;
    assert.equal(container.querySelector('input[type="checkbox"]'), null, "no acknowledgement box");
    assert.equal(button().disabled, false);
    assert.equal(container.querySelector(".cr-cost")?.textContent, "Publishing moves no coins and locks the sale’s terms. Blast pays the network fees.");
    await act(async () => button().click());
    assert.equal(publications, 1);
    createStore.set({ publishLocked: true, publishProgress: "2 of 4 · Register currency" });
    await render();
    assert.equal(button().disabled, true);
    createStore.set({ publishLocked: false, publishProgress: null, logoPreview: "blob:uploading" });
    await render();
    assert.equal(button().disabled, true);
    createStore.set({ logoPreview: null, allowlistUploading: true });
    await render();
    assert.equal(button().disabled, true);
    createStore.set({ allowlistUploading: false });
    await render();
    assert.equal(button().disabled, false);
    // Incomplete drafts stay on Review and cannot publish.
    createStore.set({ draft: { ...filledSample(), name: "" } });
    await render();
    await act(async () => button().click());
    assert.equal(publications, 1);
    assert.equal(button().disabled, true);
    assert.equal(createStore.get().step, "review");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    createStore.reset();
  }
});

test("Create keeps typed fields through sign-in, creates a new draft, and ignores a save that finishes after sign-out", async () => {
  const fetch = globalThis.fetch;
  const pending = Promise.withResolvers<Response>();
  const reads: string[] = [];
  const writes: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.startsWith(SOCIAL_CREATE_DRAFTS_PATH)) {
      if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return pending.promise; }
      reads.push(path);
    }
    return Response.json({}, { status: 404 });
  };
  createStore.reset();
  dom.window.sessionStorage.clear();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const render = async (status: "loading" | "signed_out" | "ready") => {
    const signedIn = status === "ready";
    await act(async () => root.render(
      <AppRouterContext value={router}>
      <SocialAccountContext value={{ status, account: signedIn ? account : null, refresh: () => undefined }}>
        <SocialViewerProvider signedIn={signedIn} sessionPending={status === "loading"} callsign={signedIn ? account.callsign : null} getAccessToken={async () => "token"}>
          <CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={[]} suiPrice={null} />
        </SocialViewerProvider>
      </SocialAccountContext>
      </AppRouterContext>,
    ));
  };
  try {
    await render("signed_out");
    const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
    await act(async () => { setInputValue(input, "Keep my token"); input.dispatchEvent(testEvent("input")); });
    assert.equal(createStore.get().draft.name, "Keep my token");
    await render("loading");
    assert.equal(input.value, "Keep my token");
    assert.equal(container.querySelector('[aria-label="Name"]'), input);
    assert.doesNotMatch(container.textContent ?? "", /Sign in to save|Sign in to create/);
    await render("ready");
    assert.equal(input.value, "Keep my token");
    assert.equal(createStore.get().ownerId, account.account_id);
    assert.ok(createStore.get().draftId);
    assert.deepEqual(reads, [], "a guest's draft never overwrites or loads the account's old draft");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)); });
    assert.equal(writes.length, 1);
    const sent = createStore.get();
    await render("signed_out");
    await act(async () => pending.resolve(Response.json({ created_at_ms: 1, updated_at_ms: 2, published_presale_id: null, issues: [], draft_id: sent.draftId, version: 1, draft: sent.draft, logo_url: null, cover: null, allowlist: null, fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: sent.quotes, sui_price: null })));
    assert.equal(createStore.get().phase, "visitor");
    assert.equal(createStore.get().ownerId, null);
    assert.equal(createStore.get().draft.name, "", "private account drafts clear on sign-out");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = fetch;
    createStore.reset();
    dom.window.sessionStorage.clear();
  }
});

test("Try again reloads the same saved draft after a refused read, without autosaving a replacement", async () => {
  const originalFetch = globalThis.fetch;
  const draftId = "00000000-0000-4000-8000-000000000001";
  const saved: CreateDraftResponse = {
    draft_id: draftId, version: 7, created_at_ms: 1, updated_at_ms: 2,
    draft: { ...filledSample(), name: "Saved presale", token_recipients: [{ ...filledSample().token_recipients[0]!, vest: false, cliff: 3, cliff_unit: "minutes" }] },
    logo_url: "https://assets.example/logo.png", cover: null, published_presale_id: null,
    allowlist: null, issues: [], fee_policy: CREATE_DEFAULT_FEE_POLICY,
    quotes: [filledSample().quote_type], sui_price: null,
  };
  let reads = 0;
  let lists = 0;
  const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method === "PUT") {
      writes.push(path);
      return Response.json(saved, { status: 201 });
    }
    if (path === `${SOCIAL_CREATE_DRAFTS_PATH}?limit=1&resume=true`) {
      lists++;
      return Response.json({ next_cursor: null, items: [{ ...draftSummaryFields, draft_id: lists === 1 ? draftId : "00000000-0000-4000-8000-000000000099" }] });
    }
    assert.equal(path, `${SOCIAL_CREATE_DRAFTS_PATH}/${draftId}`);
    reads++;
    return reads < 3
      ? Response.json({ error: { code: reads === 1 ? "invalid_request" : "unavailable", message: "secret backend payload", field: "token_recipients.0" } }, { status: reads === 1 ? 400 : 503, headers: { "X-Request-ID": "draft-read-213" } })
      : Response.json(saved);
  };
  createStore.reset();
  dom.window.sessionStorage.clear();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <AppRouterContext value={router}>
        <SocialAccountContext value={{ status: "ready", account, refresh: () => undefined }}>
          <SocialViewerProvider signedIn getAccessToken={async () => "token"}>
            <CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={saved.quotes} suiPrice={null} />
          </SocialViewerProvider>
        </SocialAccountContext>
      </AppRouterContext>,
    ));
    assert.equal(createStore.get().phase, "error");
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /Code: invalid_request/);
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /Reference: draft-read-213/);
    assert.doesNotMatch(container.textContent!, /secret backend payload/);
    // The error card replaces the step: there is no blank form to fill in or continue from.
    assert.equal(container.querySelector('[aria-label="Name"]'), null);
    assert.equal(container.querySelector("fieldset"), null);
    const retry = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Try again")!;
    await act(async () => retry().click());
    assert.equal(reads, 2, "retry must read the saved draft instead of creating one from placeholder edits");
    assert.equal(createStore.get().phase, "error");
    assert.equal(createStore.get().draftId, draftId);
    await act(async () => retry().click());
    assert.equal(reads, 3);
    assert.equal(lists, 1, "retry must keep the draft selected before the failed read");
    assert.equal(createStore.get().draftId, draftId);
    assert.equal(createStore.get().version, 7);
    assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Name"]')!.value, "Saved presale");
    assert.deepEqual(createStore.get().draft, saved.draft);
    assert.equal(createStore.get().logoUrl, saved.logo_url);
    assert.equal(createStore.get().dirty, false);
    assert.equal(container.querySelector('[role="alert"]'), null);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 900)));
    assert.deepEqual(writes, []);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    createStore.reset();
    globalThis.fetch = originalFetch;
  }
});

test("the logo, cover and allowlist upload buttons gate the picker and preserve guest fields", async () => {
  createStore.reset({ phase: "visitor", draft: { ...createStore.get().draft, name: "Unsigned token", eligibility: "allowlist" } });
  const draft = createStore.get().draft;
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  let signIns = 0;
  let pickers = 0;
  function Actions() {
    useShellAction("openSignIn", () => { signIns++; });
    return null;
  }
  const steps = ["token", "raise", "details"] as const;
  const render = async (phase: "visitor" | "loading" | "error" | "ready", step: (typeof steps)[number]) => {
    createStore.set({ phase, draft, step });
    await act(async () => root.render(<ShellActionsProvider><Actions /><CreateForm state={createStore.get()} issues={[]} onLogo={() => undefined} onList={() => undefined} /></ShellActionsProvider>));
  };
  try {
    container.addEventListener("click", (event) => { if (event.target instanceof HTMLInputElement && event.target.type === "file") pickers++; });
    let uploads = 0;
    for (const step of steps) {
      await render("visitor", step);
      for (const button of container.querySelectorAll<HTMLButtonElement>("[data-cr-upload]")) {
        uploads++;
        // A press on the logo badge's icon or on a plain Upload button (no glyph, KA-5) opens the picker.
        await act(async () => { (button.querySelector("svg") ?? button).dispatchEvent(testEvent("click")); });
      }
    }
    assert.equal(uploads, 3, "the logo (Token), the allowlist (Raise) and the cover (Details)");
    assert.equal(signIns, 3);
    assert.equal(pickers, 0);
    await render("visitor", "token");
    assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Name"]')!.value, "Unsigned token");
    await render("loading", "token");
    await act(async () => { container.querySelector("[data-cr-upload]")!.dispatchEvent(testEvent("click")); });
    assert.equal(signIns, 3, "restoration never opens sign-in");
    await render("error", "token");
    await act(async () => { container.querySelector("[data-cr-upload]")!.dispatchEvent(testEvent("keydown", { key: "Enter" })); });
    assert.equal(signIns, 3, "an account failure uses the retry control instead of reopening sign-in");
    assert.equal(pickers, 0);
    for (const step of steps) {
      await render("ready", step);
      for (const button of container.querySelectorAll<HTMLButtonElement>("[data-cr-upload]")) await act(async () => { button.dispatchEvent(testEvent("click")); });
    }
    assert.equal(pickers, 3);
    assert.equal(signIns, 3);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    createStore.reset();
  }
});

test("checklist fixes open the field's step, focus it and expose its error, including folded links", async () => {
  const { Readiness } = await import("./CreatePreview");
  const { useCreateState, issuesOf } = await import("./create-store");
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  function Draft() {
    const state = useCreateState();
    // The checklist as Details' right column draws it, kept on screen while the fixes open other steps.
    return <SocialViewerProvider signedIn><CreateView state={state} onLogo={() => undefined} onList={() => undefined} onRetry={() => undefined} signIn={null} /><div data-test-readiness=""><Readiness issues={issuesOf(state)} state={state} /></div></SocialViewerProvider>;
  }
  const fix = (label: string) => container.querySelector<HTMLButtonElement>(`[data-test-readiness] button[aria-label="${label}"]`)!;
  const toggle = () => container.querySelector<HTMLButtonElement>("#cr-links [aria-expanded]")!;
  try {
    for (const reduced of [false, true]) {
      dom.window.reducedMotion = reduced;
      createStore.reset({ phase: "ready", draft: { ...filledSample(), name: "", symbol: "", site: "invalid" }, step: "details" });
      await act(async () => root.render(<Draft />));
      await act(async () => fix("Coin: Add a name").click());
      assert.equal(createStore.get().step, "token");
      const input = container.querySelector<HTMLInputElement>('[data-f="name"]')!;
      assert.equal(dom.document.activeElement, input);
      assert.equal(input.getAttribute("aria-invalid"), "true");
      assert.equal(dom.document.getElementById(input.getAttribute("aria-describedby")!)?.textContent, "Add a name");
      await act(async () => fix("Coin: Add a ticker").click());
      assert.equal(dom.document.activeElement, container.querySelector('[data-f="symbol"]'));
      await act(async () => createStore.set({ step: "details" }));
      assert.equal(toggle().getAttribute("aria-expanded"), "true", "a shown link error opens the links");
      await act(async () => toggle().click());
      assert.equal(toggle().getAttribute("aria-expanded"), "false");
      await act(async () => fix("Links: Website isn't a web address").click());
      assert.equal(toggle().getAttribute("aria-expanded"), "true");
      assert.equal(dom.document.activeElement, container.querySelector('[data-f="site"]'));
    }
    // With nothing to fix, Continue to review opens Review.
    await act(async () => createStore.reset({ phase: "ready", draft: filledSample(), bluefinOptions: { status: "ready", min_tick: -443_636, max_tick: 443_636 }, step: "details" }));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Continue to review")!.click());
    assert.equal(createStore.get().step, "review");
    assert.equal(dom.window.location.hash, "#review");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.reducedMotion = false;
    createStore.reset();
  }
});

test("the step bar, Continue and Back open steps in place as history entries; the draft, its uploads and its validation are untouched", async (t) => {
  const { useCreateState } = await import("./create-store");
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const draft = filledSample();
  createStore.reset({ phase: "ready", draft, bluefinOptions: { status: "ready", min_tick: -443636, max_tick: 443636 }, dirty: true, logoPreview: "blob:logo", coverPreview: "blob:cover", allowlistUploading: true, touched: new Set(["symbol"]), tried: true });
  const frames: FrameRequestCallback[] = [];
  t.mock.method(globalThis, "requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  const scrolls = t.mock.method(dom.window, "scrollTo", () => undefined);
  const intoView = t.mock.method(dom.window.HTMLElement.prototype, "scrollIntoView", () => undefined);
  const flush = async () => {
    const pending = frames.splice(0);
    await act(async () => pending.forEach((callback) => callback(0)));
  };
  function Page() {
    const state = useCreateState();
    return <SocialViewerProvider signedIn><CreateView state={state} onLogo={() => undefined} onList={() => undefined} onRetry={() => undefined} signIn={null} /></SocialViewerProvider>;
  }
  const current = () => container.querySelector('nav[aria-label="Steps"] [aria-current="page"]')?.textContent;
  const link = (step: string) => container.querySelector<HTMLAnchorElement>(`nav[aria-label="Steps"] a[href="#${step}"]`)!;
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === label)!;
  try {
    await act(async () => root.render(<Page />));
    assert.equal(current(), "Coin");
    assert.equal(dom.window.location.hash, "");
    await act(async () => link("details").dispatchEvent(testEvent("click")));
    assert.equal(current(), "Details");
    assert.equal(dom.window.location.hash, "#details");
    await flush();
    assert.equal(dom.document.activeElement, container.querySelector("[data-create-step]"));
    assert.deepEqual(scrolls.mock.calls.at(-1)?.arguments, [{ top: 0, behavior: "instant" }]);
    assert.deepEqual([...container.querySelectorAll('nav[aria-label="Steps"] a')].filter((anchor) => anchor.querySelector("svg")).map((anchor) => anchor.textContent), ["Coin", "Raise"]);
    await act(async () => button("Back").click());
    assert.equal(current(), "Raise");
    assert.equal(dom.window.location.hash, "#raise");
    await act(async () => button("Continue").click());
    assert.equal(current(), "Details");
    // Back and Forward follow the history the steps added.
    dom.window.history.replaceState(null, "", "#token");
    await act(async () => dom.window.dispatchEvent(testEvent("popstate")));
    assert.equal(current(), "Coin");
    await act(async () => button("Continue to raise").click());
    assert.equal(current(), "Raise");
    // A link to a part of a step (the page's links before it had steps) opens the step and lands on the part.
    dom.window.history.replaceState(null, "", "#cr-fees");
    await act(async () => dom.window.dispatchEvent(testEvent("hashchange")));
    await flush();
    assert.equal(current(), "Raise");
    assert.equal(dom.document.activeElement?.id, "cr-fees");
    assert.deepEqual(intoView.mock.calls.at(-1)?.arguments, [{ behavior: "instant", block: "start" }]);
    const now = createStore.get();
    assert.deepEqual(now.draft, draft);
    assert.deepEqual([now.dirty, now.logoPreview, now.coverPreview, now.allowlistUploading, now.tried, now.touched.has("symbol")], [true, "blob:logo", "blob:cover", true, true, true], "uploads, validation and dirty state survive navigation");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    createStore.reset();
  }
});

test("a recipient’s long SuiNS name resolves after Continue leaves the Raise step", async (t) => {
  const { useCreateState } = await import("./create-store");
  const address = `0x${"a".repeat(64)}`;
  const reply = Promise.withResolvers<{ address: string }>();
  const lookup = t.mock.method(SuiGrpcClient.prototype, "resolveNameServiceAddress", () => reply.promise);
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  dom.window.history.replaceState(null, "", "#raise");
  createStore.reset({ phase: "ready", draft: filledSample(), step: "raise" });
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    createStore.reset();
  });

  function Page() {
    return <SocialViewerProvider signedIn><CreateView state={useCreateState()} onLogo={() => undefined} onList={() => undefined} onRetry={() => undefined} signIn={null} /></SocialViewerProvider>;
  }
  const name = `${"a".repeat(45)}.${"b".repeat(35)}.sui`;
  await act(async () => root.render(<Page />));
  await act(async () => container.querySelector<HTMLButtonElement>('#cr-split button[aria-expanded]')!.click());
  const field = container.querySelector<HTMLInputElement>('[data-f="token_recipients.0.address"]')!;
  await act(async () => {
    field.focus();
    setInputValue(field, name);
    field.dispatchEvent(testEvent("input"));
  });
  assert.equal(field.value, name);
  const next = [...container.querySelectorAll("button")].find((button) => button.textContent === "Continue")!;
  await act(async () => next.click());
  assert.equal(createStore.get().step, "details");
  assert.equal(lookup.mock.calls.length, 1);
  assert.equal(field.closest("[hidden]")?.getAttribute("hidden"), "");
  await act(async () => reply.resolve({ address }));
  assert.equal(createStore.get().draft.token_recipients[0]!.address, address);
});

test("a link to a step or a part of one opens it on load; a step opened without a link replaces the hash", async (t) => {
  const { useCreateState } = await import("./create-store");
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const frames: FrameRequestCallback[] = [];
  t.mock.method(globalThis, "requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  t.mock.method(dom.window.HTMLElement.prototype, "scrollIntoView", () => undefined);
  function Page() {
    const state = useCreateState();
    return <SocialViewerProvider signedIn><CreateView state={state} onLogo={() => undefined} onList={() => undefined} onRetry={() => undefined} signIn={null} /></SocialViewerProvider>;
  }
  dom.window.history.replaceState(null, "", "#cr-join");
  createStore.reset({ phase: "ready", draft: filledSample() });
  try {
    await act(async () => root.render(<Page />));
    await act(async () => frames.splice(0).forEach((callback) => callback(0)));
    assert.equal(createStore.get().step, "raise");
    assert.equal(dom.document.activeElement?.id, "cr-join");
    assert.equal(dom.window.location.hash, "#cr-join", "the link is kept");
    await act(async () => createStore.set({ step: "token" }));
    assert.equal(dom.window.location.hash, "#token");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    createStore.reset();
  }
});



test("vesting units default to months and change independently for token and raise splits", async () => {
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  createStore.reset({ phase: "ready", draft: filledSample(), bluefinOptions: { status: "ready", min_tick: -443_636, max_tick: 443_636 }, step: "raise" });
  const render = () => act(async () => root.render(<CreateForm state={createStore.get()} issues={[]} onLogo={() => {}} onList={() => {}} />));
  try {
    await render();
    const pick = async (path: string, unit: string) => {
      const select = container.querySelector<HTMLSelectElement>(`select[data-f="${path}"]`)!;
      assert.ok(select);
      assert.deepEqual([...select.options].map((option) => option.value), ["months", "weeks", "days", "hours", "minutes"]);
      select.value = unit;
      await act(async () => select.dispatchEvent(testEvent("change")));
      await render();
    };
    assert.equal(container.querySelector<HTMLSelectElement>('select[data-f="token_recipients.0.duration_unit"]')!.value, "months");
    await pick("token_recipients.0.cliff_unit", "weeks");
    assert.equal(createStore.get().draft.token_recipients[0]!.duration_unit, "months");
    assert.equal(createStore.get().draft.raise_recipients[0]!.cliff_unit, "months");
    await pick("token_recipients.0.duration_unit", "days");
    await pick("raise_recipients.0.duration_unit", "minutes");
    await pick("raise_recipients.0.cliff_unit", "minutes");
    assert.equal(createStore.get().draft.token_recipients[0]!.cliff_unit, "weeks");
    assert.equal(container.querySelector<HTMLInputElement>('[data-f="raise_recipients.0.duration"]')!.getAttribute("aria-label"), "Raise split: Team vesting length, in minutes");
    // Seconds and milliseconds are no longer offered, but a draft saved with one still loads and shows it.
    const [team, ...rest] = createStore.get().draft.token_recipients;
    await act(async () => createStore.set({ draft: { ...createStore.get().draft, token_recipients: [{ ...team!, duration_unit: "seconds" }, ...rest] } }));
    await render();
    const old = container.querySelector<HTMLSelectElement>('select[data-f="token_recipients.0.duration_unit"]')!;
    assert.equal(old.value, "seconds");
    assert.deepEqual([...old.options].map((option) => option.value), ["months", "weeks", "days", "hours", "minutes", "seconds"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    createStore.reset();
  }
});


test("a completed presale shows success once, then Create opens a fresh editable draft", async () => {
  const originalFetch = globalThis.fetch;
  const reads: string[] = [];
  const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") {
      writes.push(String(input));
      const { draft } = JSON.parse(String(init.body));
      return Response.json({ created_at_ms: 1, updated_at_ms: 2, issues: [], draft_id: createStore.get().draftId, version: 1, draft, logo_url: null, cover: null, allowlist: null, fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [CREATE_TEST_SUI_QUOTE_TYPE], sui_price: null, published_presale_id: null });
    }
    reads.push(String(input));
    if (String(input).includes("?limit=")) return Response.json({ items: [], next_cursor: null });
    return Response.json({ created_at_ms: 1, updated_at_ms: 2, issues: [], draft_id: createStore.get().draftId, version: 7, draft: filledSample(), logo_url: null, cover: null, allowlist: null, fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [], sui_price: null, published_presale_id: `0x${"1".repeat(64)}` });
  };
  createStore.reset();
  dom.window.sessionStorage.clear();
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  const page = (status: "loading" | "ready" = "ready") => <AppRouterContext value={router}>
    <SocialAccountContext value={{ status, account, refresh: () => undefined }}>
      <SocialViewerProvider signedIn getAccessToken={async () => "token"}>
        <CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={[CREATE_TEST_SUI_QUOTE_TYPE]} suiPrice={null} />
      </SocialViewerProvider>
    </SocialAccountContext>
  </AppRouterContext>;
  const assertFresh = () => {
    const state = createStore.get();
    assert.equal(state.draft.quote_type, CREATE_TEST_SUI_QUOTE_TYPE);
    assert.equal(state.publishedPresaleId, null);
    assert.equal(state.reviewOpen, false);
    assert.equal(state.publishLocked, false);
    assert.equal(state.publishProgress, null);
    assert.equal(state.publishError, null);
    assert.equal(state.version, 0);
    assert.equal(state.logoUrl, null);
    assert.equal(state.cover, null);
    assert.equal(state.allowlist, null);
    assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Name"]')!.value, "");
    assert.equal(container.querySelector<HTMLFieldSetElement>("fieldset")!.disabled, false);
    assert.doesNotMatch(container.textContent ?? "", /Your presale is published\./);
    assert.equal(dom.document.querySelector("canvas"), null);
  };
  const complete = () => createStore.set({ draft: filledSample(), version: 7, publishedPresaleId: `0x${"1".repeat(64)}`, publishLocked: true, reviewOpen: true });
  try {
    await act(async () => root.render(page()));
    assertFresh();
    await act(async () => complete());
    assert.match(dom.document.body.textContent ?? "", /Your presale is published\./);
    const completedId = createStore.get().draftId;
    await act(async () => root.render(null));
    await act(async () => root.render(page()));
    assertFresh();
    assert.notEqual(createStore.get().draftId, completedId);
    assert.deepEqual(reads, [`${SOCIAL_CREATE_DRAFTS_PATH}?limit=1&resume=true`], "the completed draft is never fetched again");
    await act(async () => complete());
    assert.match(dom.document.body.textContent ?? "", /Your presale is published\./);
    await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    assertFresh();
    await act(async () => root.render(null));
    await act(async () => root.render(page("loading")));
    await act(async () => root.render(page()));
    assertFresh();
    const newId = createStore.get().draftId;
    const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
    await act(async () => {
      setInputValue(input, "Second presale");
      input.dispatchEvent(testEvent("input"));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 850)));
    assert.deepEqual(writes, [`${SOCIAL_CREATE_DRAFTS_PATH}/${newId}`]);
    assert.notEqual(newId, completedId);
    assert.equal(createStore.get().version, 1);
    assert.equal(createStore.get().draft.name, "Second presale");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    createStore.reset();
    dom.window.sessionStorage.clear();
  }
});


test("Create resumes unfinished publishing but replaces a draft published in another tab", async () => {
  const originalFetch = globalThis.fetch;
  const draftId = "00000000-0000-4000-8000-000000000002";
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  dom.window.sessionStorage.clear();
  try {
    for (const publishedElsewhere of [false, true]) {
      createStore.reset({ phase: "ready", ownerId: account.account_id, draftId, version: 7, draft: filledSample(), publishLocked: true, reviewOpen: true });
      globalThis.fetch = async (input) => {
        assert.equal(String(input), `${SOCIAL_CREATE_DRAFTS_PATH}/${draftId}`);
        return Response.json({ created_at_ms: 1, updated_at_ms: 2, issues: [], draft_id: draftId, version: 7, draft: filledSample(), logo_url: "https://assets.example/logo.png", cover: null, allowlist: null, fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [], sui_price: null, published_presale_id: publishedElsewhere ? `0x${"2".repeat(64)}` : null });
      };
      await act(async () => root.render(<AppRouterContext value={router}>
        <SocialAccountContext value={{ status: "ready", account, refresh: () => undefined }}>
          <SocialViewerProvider signedIn getAccessToken={async () => "token"}>
            <CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={[]} suiPrice={null} />
          </SocialViewerProvider>
        </SocialAccountContext>
      </AppRouterContext>));
      assert.equal(createStore.get().publishedPresaleId, null);
      assert.equal(createStore.get().publishLocked, !publishedElsewhere);
      assert.equal(createStore.get().reviewOpen, !publishedElsewhere);
      assert.equal(createStore.get().draft.name, publishedElsewhere ? "" : filledSample().name);
      assert.equal(createStore.get().draftId === draftId, !publishedElsewhere);
      assert.equal(createStore.get().version, publishedElsewhere ? 0 : 7);
      assert.equal(dom.document.querySelector("canvas"), null);
      await act(async () => root.render(null));
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    createStore.reset();
    dom.window.sessionStorage.clear();
  }
});

test("a late save cannot restore a completed presale after the form starts over", async () => {
  const originalFetch = globalThis.fetch;
  const pending = Promise.withResolvers<Response>();
  const draftId = "00000000-0000-4000-8000-000000000003";
  const saved: CreateDraftResponse = {
    draft_id: draftId, version: 1, created_at_ms: 1, updated_at_ms: 2,
    draft: filledSample(), logo_url: null, cover: null, published_presale_id: null,
    allowlist: null, issues: [], fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [], sui_price: null,
  };
  let saves = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "PUT") { saves++; return pending.promise; }
    return Response.json(saved);
  };
  createStore.reset({ ownerId: account.account_id, draftId, version: 1 });
  dom.window.sessionStorage.clear();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AppRouterContext value={router}>
      <SocialAccountContext value={{ status: "ready", account, refresh: () => undefined }}>
        <SocialViewerProvider signedIn getAccessToken={async () => "token"}>
          <CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={[]} suiPrice={null} />
        </SocialViewerProvider>
      </SocialAccountContext>
    </AppRouterContext>));
    await act(async () => {
      createStore.edit((draft) => ({ ...draft, name: "Completed token" }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 850)));
    assert.equal(saves, 1);
    await act(async () => {
      createStore.set({ publishedPresaleId: `0x${"1".repeat(64)}` });
      createStore.startNewDraft();
    });
    const nextId = createStore.get().draftId;
    await act(async () => pending.resolve(Response.json({ ...saved, version: 2 })));
    assert.equal(createStore.get().draftId, nextId);
    assert.equal(createStore.get().draft.name, "");
    assert.equal(createStore.get().version, 0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    createStore.reset();
    dom.window.sessionStorage.clear();
  }
});

test("CSV validation, review and acceptance preserve the old list until a successful confirmed upload", async () => {
  const motion = recordAnimations();
  const originalFetch = globalThis.fetch;
  const oldList = "00000000-0000-4000-8000-000000000a11";
  const newList = "00000000-0000-4000-8000-000000000b22";
  const draftId = "00000000-0000-4000-8000-000000000001";
  const draft = { ...filledSample(), venue: "bluefin" as const, eligibility: "allowlist" as const, allowlist_id: oldList };
  const saved: CreateDraftResponse = {
    draft_id: draftId, version: 1, created_at_ms: 1, updated_at_ms: 2, draft,
    logo_url: null, cover: null, published_presale_id: null, issues: [],
    allowlist: { allowlist_id: oldList, root: "2".repeat(64), leaf_count: 1, min_cap: 10, max_cap: 10, quote_type: draft.quote_type },
    fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [draft.quote_type, CREATE_TEST_SUI_QUOTE_TYPE], sui_price: null,
    bluefin_options: { status: "ready", min_tick: -443_636, max_tick: 443_636 },
  };
  const uploads: { quote: string; csv: string }[] = [];
  let response: () => Promise<Response> = async () => Response.json({ error: { code: "invalid_allowlist", rows: [{ row: 2, reason: "invalid address" }, { row: 2, reason: "cap must be at least 1" }, { row: 2, reason: "duplicate wallet (first on row 1)" }, { row: 2, reason: "__proto__" }] } }, { status: 400 });
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/presale/allowlists") {
      const body = init!.body as FormData;
      uploads.push({ quote: String(body.get("quote")), csv: await (body.get("file") as Blob).text() });
      return response();
    }
    if (String(input).endsWith("/entries")) return Response.json({ quote: draft.quote_type, source: { file_name: "allowlist.csv", uploaded_count: 1, include_blast_holders: false, added_count: 0, holder_cap: null }, entries: [{ wallet: "0x" + "1".padStart(64, "0"), cap: "1000001" }] });
    if (init?.method === "PUT") return Response.json({ ...saved, draft: JSON.parse(String(init.body)).draft });
    return Response.json(saved);
  };
  createStore.reset({ phase: "ready", ownerId: account.account_id, draftId, version: 1, draft, step: "raise" });
  dom.window.sessionStorage.clear();
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  const pick = async (text: string, name = "allowlist.csv") => {
    const input = container.querySelector<HTMLInputElement>('input[accept=".csv,text/csv,text/plain"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File([text], name, { type: "text/csv" })] });
    await act(async () => input.dispatchEvent(testEvent("change")));
  };
  const button = (label: string) => [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === label)!;
  const unchanged = () => {
    assert.equal(createStore.get().draft.allowlist_id, oldList);
    assert.equal(createStore.get().allowlist!.allowlist_id, oldList);
    assert.equal(createStore.get().localAllowlist, null);
  };
  const close = async (label: string) => {
    await act(async () => button(label).click());
    await act(async () => motion.finishAll());
    assert.equal(dom.document.activeElement, container.querySelector('[data-f="allowlist"][data-cr-upload]'));
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    assert.equal(dom.document.body.style.overflow, "");
    unchanged();
  };
  try {
    await act(async () => root.render(
      <AppRouterContext value={router}>
        <SocialAccountContext value={{ status: "ready", account, refresh: () => undefined }}>
          <SocialViewerProvider signedIn getAccessToken={async () => "token"}>
            <CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={saved.quotes} suiPrice={null} />
          </SocialViewerProvider>
        </SocialAccountContext>
      </AppRouterContext>,
    ));
    await act(async () => container.querySelector<HTMLButtonElement>('#cr-join button[aria-controls]')!.click());
    assert.ok(button("Download CSV"));
    await pick("address,amount\n0x1,100\nno-wallet,50\n0x2,100abc\n0x3,1.0000001");
    assert.match(dom.document.body.textContent ?? "", /Line 3Addressno-walletInvalid Sui address/);
    assert.match(dom.document.body.textContent ?? "", /Line 4Amount100abcInvalid number/);
    assert.match(dom.document.body.textContent ?? "", /Line 5Amount1.0000001Maximum 6 decimal places/);
    assert.equal(button("Accept allowlist"), undefined);
    assert.equal(uploads.length, 0);
    unchanged();
    await close("Back to upload");
    await pick("0x1,0");
    await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    await act(async () => motion.finishAll());
    assert.equal(dom.document.activeElement, container.querySelector('[data-f="allowlist"][data-cr-upload]'));
    unchanged();
    await pick("0x1,0");
    await act(async () => dom.document.activeElement!.dispatchEvent(testEvent("keydown", { key: "Escape" })));
    await act(async () => motion.finishAll());
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    assert.equal(dom.document.activeElement, container.querySelector('[data-f="allowlist"][data-cr-upload]'));
    unchanged();
    const input = container.querySelector<HTMLInputElement>('input[accept=".csv,text/csv,text/plain"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [] });
    await act(async () => input.dispatchEvent(testEvent("change")));
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    unchanged();
    await pick("address,amount\n\n0x1,1.000001\n\n0x2,0.000001");
    assert.match(dom.document.body.textContent ?? "", /Review your allowlist/);
    assert.match(dom.document.body.textContent ?? "", /1\.000001/);
    assert.equal(uploads.length, 0, "review must not send the file");
    unchanged();
    await close("Cancel");
    unchanged();
    await pick("address,amount\n\n0x1,1.000001\n\n0x2,0.000001");
    await act(async () => button("Accept allowlist").click());
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].quote, draft.quote_type);
    assert.equal(uploads[0].csv, `wallet,cap\n0x${"1".padStart(64, "0")},1000001\n0x${"2".padStart(64, "0")},1\n`);
    assert.match(dom.document.body.textContent ?? "", /Line 5Address0x2Invalid Sui address/, "server row numbers map back to original file lines and supplied values");
    assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /Reported: 1 row needs attention out of 2.*4 issues reported/);
    assert.match(dom.document.body.textContent ?? "", /Duplicate wallet; first on line 3/);
    assert.match(dom.document.body.textContent ?? "", /Check this address and contribution limit/);
    assert.doesNotMatch(dom.document.body.textContent ?? "", /__proto__/);
    unchanged();
    await close("Back to upload");
    response = async () => { throw new Error("offline"); };
    await pick("0x1,1.000001");
    await act(async () => button("Accept allowlist").click());
    assert.match(dom.document.body.textContent ?? "", /Your current list is unchanged/);
    unchanged();
    const pending = Promise.withResolvers<Response>();
    response = () => pending.promise;
    await act(async () => button("Accept allowlist").click());
    assert.equal(createStore.get().allowlistUploading, true);
    const uploading = dom.document.querySelector('[role="status"][aria-label="Uploading allowlist"]');
    assert.ok(uploading);
    assert.equal(uploading.closest("button")!.disabled, true);
    assert.equal(button("Cancel").disabled, true);
    await act(async () => createStore.edit((value) => ({ ...value, quote_type: CREATE_TEST_SUI_QUOTE_TYPE })));
    assert.equal(createStore.get().draft.quote_type, CREATE_TEST_SUI_QUOTE_TYPE, "the fixture admits the quote change before the upload completes");
    await act(async () => pending.resolve(Response.json({ allowlist_id: newList, entry_count: 1, leaf_count: "1", root: "1".repeat(64), total_cap: "1000001", warnings: [] }, { status: 201 })));
    unchanged();
    assert.equal(createStore.get().allowlistUploading, false, "a late response for another quote never replaces the list");
    await act(async () => createStore.edit((value) => ({ ...value, quote_type: draft.quote_type })));
    response = async () => Response.json({ allowlist_id: newList, entry_count: 1, leaf_count: "1", root: "1".repeat(64), total_cap: "1000001", warnings: [] }, { status: 201 });
    await act(async () => button("Accept allowlist").click());
    assert.equal(createStore.get().draft.allowlist_id, newList);
    assert.deepEqual(createStore.get().localAllowlist, { n: 1, min: 1.000001, max: 1.000001, quoteType: draft.quote_type });
    assert.equal(button("Accept allowlist"), undefined);
    assert.equal(createStore.get().allowlistUploading, false);
    assert.equal(createStore.get().dirty, true);
    const hundredRows = "address,amount\n" + Array.from({ length: 100 }, (_, i) => `0x${(i + 1).toString(16)},${i === 99 ? "12649.75" : "250.00"}`).join("\n");
    const uploadedBeforePaging = uploads.length;
    await pick(hundredRows);
    await act(async () => dom.document.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click());
    assert.equal(uploads.length, uploadedBeforePaging, "paging does not upload the candidate");
    await act(async () => button("Cancel").click());
    await act(async () => motion.finishAll());
    assert.equal(createStore.get().draft.allowlist_id, newList);
    assert.equal(createStore.get().localAllowlist!.n, 1, "cancel preserves the accepted list");
    response = async () => Response.json({ allowlist_id: newList, entry_count: 100, leaf_count: "100", root: "1".repeat(64), total_cap: "37399750000", warnings: [] }, { status: 201 });
    await pick(hundredRows);
    assert.equal(dom.document.querySelector('[aria-label="Pages of wallets"] [aria-current="page"]')!.textContent, "1", "reopening starts at page one");
    await act(async () => dom.document.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click());
    await act(async () => button("Accept allowlist").click());
    const fullCsv = uploads.at(-1)!.csv.trim().split("\n");
    assert.equal(fullCsv.length, 101, "accept uploads the entire candidate, including the hidden first page");
    assert.equal(fullCsv[1], `0x${"1".padStart(64, "0")},250000000`);
    assert.equal(fullCsv[100], `0x${"64".padStart(64, "0")},12649750000`);
    assert.equal(createStore.get().localAllowlist!.n, 100);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    createStore.reset();
  }
});

test("venue controls refuse unsupported choices and expose only live pool tiers", async () => {
  const { CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE } = await import("@blast/core/modules/social/contracts/create.ts");
  const { useCreateState, issuesOf } = await import("./create-store");
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  function Form() {
    const state = useCreateState();
    return <CreateForm state={state} issues={issuesOf(state)} onLogo={() => undefined} onList={() => undefined} />;
  }
  createStore.reset({ phase: "ready", draft: { ...filledSample(), quote_type: CREATE_USDSUI_QUOTE_TYPE }, quotes: [CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE], cetusTiers: { [CREATE_QUOTE_TYPE]: [[200, 10_000]] }, bluefinOptions: { status: "ready", min_tick: -443_636, max_tick: 443_636 }, step: "raise" });
  try {
    await act(async () => root.render(<ShellActionsProvider><Form /></ShellActionsProvider>));
    const cetus = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Pool venue"] button')].find((button) => button.textContent === "Cetus")!;
    assert.equal(cetus().disabled, true);
    await act(async () => createStore.set({ flash: { section: "raise", path: "venue", nonce: 1 } }));
    assert.equal(dom.document.activeElement?.textContent, "Bluefin");
    const before = createStore.get().draft;
    await act(async () => cetus().click());
    assert.equal(createStore.get().draft.venue, "bluefin");
    assert.equal(createStore.get().draft.quote_type, before.quote_type);
    assert.equal(createStore.get().draft.target, before.target);
    assert.ok(container.textContent!.includes("USDsui"));
    await act(async () => createStore.edit((draft) => ({ ...draft, quote_type: CREATE_QUOTE_TYPE, pool_fee: 3_000 })));
    assert.equal(cetus().disabled, false);
    await act(async () => cetus().click());
    assert.equal(createStore.get().draft.venue, "cetus");
    const fee = container.querySelector<HTMLSelectElement>('[aria-label="Pool fee"]')!;
    assert.deepEqual([...fee.options].map((option) => option.value), ["10000"]);
    assert.equal(fee.value, "10000");
    await act(async () => createStore.set({ cetusTiers: null }));
    assert.equal(cetus().disabled, true);
    assert.equal(fee.disabled, true);
    assert.ok(issuesOf(createStore.get()).some((issue) => issue.path === "venue"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    createStore.reset();
  }
});

// Fails if the selected row loses initial focus or the mounted group's key handler stops moving/wrapping focus.
test("the quote picker focuses its selected row and moves both ways with wrap while leaving unknown keys alone", async () => {
  const page = await quotePickerHarness();
  try {
    await page.mount();
    assert.equal(dom.document.activeElement === page.row("USDC"), true);
    const down = new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    await act(async () => page.row("USDC").dispatchEvent(down));
    assert.equal(down.defaultPrevented, true);
    assert.equal(dom.document.activeElement === page.row("USDsui"), true);
    await act(async () => page.row("USDsui").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    assert.equal(dom.document.activeElement === page.row("SUI"), true);
    await act(async () => page.row("SUI").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
    assert.equal(dom.document.activeElement === page.row("USDsui"), true);
    await act(async () => page.row("USDsui").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
    assert.equal(dom.document.activeElement === page.row("USDC"), true);
    const unknown = new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
    await act(async () => page.row("USDC").dispatchEvent(unknown));
    assert.equal(unknown.defaultPrevented, false);
    assert.equal(dom.document.activeElement === page.row("USDC"), true);
    assert.equal(page.row("USDC").getAttribute("aria-checked"), "true");
    assert.equal(page.row("SUI").getAttribute("aria-checked"), "false");
    assert.equal(page.row("USDsui").getAttribute("aria-checked"), "false");
    assert.equal(createStore.get().draft.quote_type, page.originalQuote);
    assert.equal(createStore.get().quoteOpen, true);
  } finally {
    await page.close();
  }
});

// Fails if a pick delays checked feedback, commits early, or misses the normal-motion 240 ms boundary.
test("the quote picker checks a pending row immediately and commits only at 240 ms with normal motion", async (t) => {
  const reduced = dom.window.reducedMotion;
  dom.window.reducedMotion = false;
  const page = await quotePickerHarness();
  try {
    await page.mount();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await act(async () => page.row("USDsui").click());
    assert.equal(page.row("USDsui").getAttribute("aria-checked"), "true");
    assert.equal(page.row("USDC").getAttribute("aria-checked"), "false");
    assert.equal(createStore.get().draft.quote_type, page.originalQuote);
    assert.equal(createStore.get().quoteOpen, true);
    await act(async () => t.mock.timers.tick(239));
    assert.equal(createStore.get().draft.quote_type, page.originalQuote);
    assert.equal(createStore.get().quoteOpen, true);
    await act(async () => t.mock.timers.tick(1));
    assert.equal(createStore.get().draft.quote_type, page.pickedQuote);
    assert.equal(createStore.get().quoteOpen, false);
  } finally {
    await page.close();
    t.mock.timers.reset();
    dom.window.reducedMotion = reduced;
  }
});

// Fails if the mounted picker ignores reduced motion and retains any nonzero close delay.
test("the quote picker commits a checked pending row at zero ms under reduced motion", async (t) => {
  const reduced = dom.window.reducedMotion;
  dom.window.reducedMotion = true;
  const page = await quotePickerHarness();
  try {
    await page.mount();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await act(async () => page.row("USDsui").click());
    assert.equal(page.row("USDsui").getAttribute("aria-checked"), "true");
    assert.equal(createStore.get().draft.quote_type, page.originalQuote);
    assert.equal(createStore.get().quoteOpen, true);
    await act(async () => t.mock.timers.tick(0));
    assert.equal(createStore.get().draft.quote_type, page.pickedQuote);
    assert.equal(createStore.get().quoteOpen, false);
  } finally {
    await page.close();
    t.mock.timers.reset();
    dom.window.reducedMotion = reduced;
  }
});

async function quotePickerHarness() {
  const { CREATE_QUOTE_TYPE, CREATE_SUI_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE } = await import("@blast/core/modules/social/contracts/create.ts");
  const { QuotePicker } = await import("./QuotePicker");
  const { useCreateState } = await import("./create-store");
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  createStore.reset({ phase: "ready", draft: { ...filledSample(), venue: "cetus", pool_fee: 10_000 }, quoteOpen: true, quotes: [CREATE_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE], suiPrice: { usd_price: "3.42", as_of_ms: 1 }, cetusTiers: { [CREATE_QUOTE_TYPE]: [[200, 10_000]] }, bluefinOptions: { status: "ready", min_tick: -443_636, max_tick: 443_636 } });
  function Picker() {
    return <QuotePicker state={useCreateState()} />;
  }
  return {
    originalQuote: CREATE_QUOTE_TYPE,
    pickedQuote: CREATE_USDSUI_QUOTE_TYPE,
    mount: () => act(async () => root.render(<Picker />)),
    row(symbol: string) {
      const group = dom.document.querySelector('[role="radiogroup"][aria-label="Raise in"]');
      const row = [...group!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent?.trim().startsWith(symbol));
      assert.ok(row, `Expected quote row: ${symbol}`);
      return row;
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
      createStore.reset();
    },
  };
}

test("the quote picker offers coins across DEXs and rechecks pending picks", async () => {
  const { CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE } = await import("@blast/core/modules/social/contracts/create.ts");
  const { QuotePicker } = await import("./QuotePicker");
  const { useCreateState } = await import("./create-store");
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  const draft = { ...filledSample(), venue: "cetus" as const, pool_fee: 10_000 };
  const options = { phase: "ready" as const, draft, quoteOpen: true, quotes: [CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE], cetusTiers: { [CREATE_QUOTE_TYPE]: [[200, 10_000] as const] }, bluefinOptions: { status: "ready" as const, min_tick: -443_636, max_tick: 443_636 } };
  function Picker() {
    return <QuotePicker state={useCreateState()} />;
  }
  const row = () => dom.document.querySelector<HTMLButtonElement>('[data-q="USDsui"]')!;
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 280)); });
  createStore.reset(options);
  try {
    await act(async () => root.render(<Picker />));
    assert.equal(row().getAttribute("aria-disabled"), "false");
    assert.deepEqual(createStore.get().draft, draft);
    assert.equal(row().getAttribute("aria-disabled"), "false");
    await act(async () => row().click());
    await settle();
    assert.equal(createStore.get().draft.quote_type, CREATE_USDSUI_QUOTE_TYPE);
    assert.equal(createStore.get().draft.venue, "bluefin");
    assert.equal(createStore.get().draft.target, draft.target);

    await act(async () => createStore.reset({ ...options, cetusTiers: null, bluefinOptions: { status: "unavailable" } }));
    assert.equal(row(), null);
    assert.deepEqual(createStore.get().draft, draft);

    await act(async () => createStore.reset({ ...options, draft: { ...draft, venue: "bluefin" } }));
    await act(async () => row().click());
    await act(async () => createStore.set({ bluefinOptions: { status: "unavailable" } }));
    await settle();
    assert.equal(createStore.get().draft.quote_type, CREATE_QUOTE_TYPE);
    assert.equal(row(), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    createStore.reset();
  }
});

function recoveryScreenHarness() {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  let root = createRoot(container);
  const render = async (signedIn: boolean, identity: SocialMeAccount | null = account, status: "ready" | "signed_out" | "loading" | "error" = signedIn ? "ready" : "signed_out", sessionPending = false) => act(async () => root.render(
    <AppRouterContext value={router}><SocialAccountContext value={{ status, account: signedIn ? identity : null, refresh() {} }}><SocialViewerProvider signedIn={signedIn} sessionPending={sessionPending} getAccessToken={async () => signedIn ? "token" : null}><CreateScreen fees={CREATE_DEFAULT_FEE_POLICY} publish={publish} quotes={[filledSample().quote_type]} suiPrice={null} /></SocialViewerProvider></SocialAccountContext></AppRouterContext>,
  ));
  return {
    container, render,
    async remount(signedIn: boolean, identity: SocialMeAccount | null = account, status: "ready" | "signed_out" | "loading" | "error" = signedIn ? "ready" : "signed_out", sessionPending = false) { await act(async () => root.unmount()); root = createRoot(container); await render(signedIn, identity, status, sessionPending); },
    async close() { await act(async () => root.unmount()); container.remove(); createStore.reset(); dom.window.sessionStorage.clear(); },
    async click(label: string) {
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
      assert.equal(button !== undefined, true, `Expected control: ${label}`);
      await act(async () => button!.click());
    },
    async name(value: string) {
      const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]');
      assert.equal(input !== null, true, "The draft must remain editable");
      await act(async () => { setInputValue(input!, value); input!.dispatchEvent(testEvent("input")); });
    },
  };
}

function recoveredBrowserCopies() {
  const retained = "Opus v4 exact retained source";
  const canonical = JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: { ...filledSample(), name: "Browser-only recovered edits" }, recovered_from: guestSourceDigest(retained) });
  dom.window.sessionStorage.setItem(RETAINED_GUEST_DRAFT_KEY, retained);
  dom.window.sessionStorage.setItem(GUEST_DRAFT_KEY, canonical);
  return { retained, canonical };
}

function savedRecoveryDraft(draftId: string, draft = filledSample(), version = 1) {
  return { created_at_ms: 1, updated_at_ms: 2, published_presale_id: null, issues: [], draft_id: draftId, version, draft, logo_url: null, cover: null, allowlist: null, fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [draft.quote_type], sui_price: null };
}

const pauseForDraftSave = () => act(async () => new Promise((resolve) => setTimeout(resolve, 850)));

test("Opus N1 separate guest survives remount and sign-in without overwriting or acknowledging retained copies", async () => {
  const previousFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, "PUT"); writes++;
    return Response.json(savedRecoveryDraft(String(input).split("/").at(-1)!, JSON.parse(String(init.body)).draft));
  };
  createStore.reset(); dom.window.sessionStorage.clear();
  const copies = recoveredBrowserCopies(); const screen = recoveryScreenHarness();
  try {
    await screen.render(false);
    await screen.click("Continue with a separate draft");
    await screen.name("Independent unsaved work");
    await screen.remount(false);
    assert.equal(createStore.get().draft.name, "Independent unsaved work");
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), copies.retained);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), copies.canonical, "remount must not infer adoption from dirty work");
    await screen.render(true); await pauseForDraftSave();
    assert.equal(writes, 1); assert.equal(createStore.get().version, 1);
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), copies.retained);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), copies.canonical, "unrelated saved work cannot acknowledge either browser copy");
  } finally { await screen.close(); globalThis.fetch = previousFetch; }
});

test("Opus N2 adopting from an account load error starts a ready unsaved draft instead of fetching its nonexistent ID", async () => {
  const previousFetch = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(init?.method ?? "GET");
    return init?.method === "PUT" ? Response.json(savedRecoveryDraft(String(input).split("/").at(-1)!, JSON.parse(String(init.body)).draft)) : Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
  };
  createStore.reset(); dom.window.sessionStorage.clear(); recoveredBrowserCopies(); const screen = recoveryScreenHarness();
  try {
    await screen.render(true); assert.equal(createStore.get().phase, "error");
    const loads = calls.length;
    await screen.click("Use recovered draft");
    assert.equal(createStore.get().phase, "ready");
    await pauseForDraftSave();
    assert.deepEqual(calls.slice(loads), ["PUT"], "new adopted UUID is saved, never loaded as an existing row");
    assert.equal(createStore.get().version, 1);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), null);
  } finally { await screen.close(); globalThis.fetch = previousFetch; }
});

test("Opus N3 a plain guest saved through in-page sign-in does not resurrect after a full store reload", async () => {
  const previousFetch = globalThis.fetch; let saved: ReturnType<typeof savedRecoveryDraft> | null = null; let writes = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") { writes++; saved = savedRecoveryDraft(String(input).split("/").at(-1)!, JSON.parse(String(init.body)).draft); return Response.json(saved); }
    assert.equal(saved !== null, true);
    return String(input).endsWith("resume=true") ? Response.json({ next_cursor: null, items: [{ ...draftSummaryFields, draft_id: saved!.draft_id }] }) : Response.json(saved);
  };
  createStore.reset(); dom.window.sessionStorage.clear(); const screen = recoveryScreenHarness();
  try {
    await screen.render(false); await screen.name("Guest becoming account draft");
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY) !== null, true);
    await screen.render(true); await pauseForDraftSave();
    const savedId = createStore.get().draftId;
    assert.equal(writes, 1); assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), null, "successful save acknowledges the exact plain guest snapshot");
    await act(async () => createStore.reset());
    await screen.remount(true); await pauseForDraftSave();
    assert.equal(createStore.get().draftId, savedId); assert.equal(writes, 1, "reload resumes the saved account row, without creating another draft");
  } finally { await screen.close(); globalThis.fetch = previousFetch; }
});

test("Opus N4 an adopted account draft survives a failed save and remount with its acknowledgement identity intact", async () => {
  const previousFetch = globalThis.fetch; let writes = 0;
  const originalId = "00000000-0000-4000-8000-000000000141";
  globalThis.fetch = async (input, init) => {
    if (init?.method !== "PUT") return String(input).endsWith("resume=true") ? Response.json({ next_cursor: null, items: [{ ...draftSummaryFields, draft_id: originalId }] }) : Response.json(savedRecoveryDraft(originalId));
    writes++;
    return writes === 1 ? Response.json({ error: { code: "unavailable" } }, { status: 503 }) : Response.json(savedRecoveryDraft(String(input).split("/").at(-1)!, JSON.parse(String(init.body)).draft));
  };
  createStore.reset(); dom.window.sessionStorage.clear(); recoveredBrowserCopies(); const screen = recoveryScreenHarness();
  try {
    await screen.render(true); await screen.click("Use as a separate draft");
    const adoptedId = createStore.get().draftId;
    await pauseForDraftSave(); assert.equal(writes, 1); assert.equal(createStore.get().dirty, true);
    await screen.remount(true);
    assert.equal(screen.container.querySelector("[data-guest-recovery]") === null, true, "remount preserves explicit adoption rather than blocking its save");
    assert.equal(createStore.get().draftId, adoptedId);
    await pauseForDraftSave(); assert.equal(writes, 2); assert.equal(createStore.get().version, 1);
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), null);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), null);
  } finally { await screen.close(); globalThis.fetch = previousFetch; }
});

test("Opus N5 a readable changed guest copy remains exportable and is distinguished from unavailable storage", async () => {
  const previousFetch = globalThis.fetch; globalThis.fetch = async () => assert.fail("Unsigned drafts must stay local");
  createStore.reset(); dom.window.sessionStorage.clear(); const screen = recoveryScreenHarness();
  try {
    await screen.render(false); await screen.name("Original mounted work");
    const foreign = JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: { ...filledSample(), name: "Other readable browser work" } });
    dom.window.sessionStorage.setItem(GUEST_DRAFT_KEY, foreign);
    await screen.name("Current unsaved work");
    assert.equal(screen.container.querySelector("h1")?.textContent, "Your browser copies changed");
    assert.equal([...screen.container.querySelectorAll("button")].some((button) => button.textContent === "Export versioned draft"), true);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), foreign);
    assert.equal(createStore.get().draft.name, "Current unsaved work");
  } finally { await screen.close(); globalThis.fetch = previousFetch; }
});

test("Opus N4 remount retries an interrupted adopted save and ignores its late response", async () => {
  const previousFetch = globalThis.fetch; const pending = Promise.withResolvers<Response>(); let writes = 0;
  const originalId = "00000000-0000-4000-8000-000000000142";
  globalThis.fetch = async (input, init) => {
    if (init?.method !== "PUT") return String(input).endsWith("resume=true") ? Response.json({ next_cursor: null, items: [{ ...draftSummaryFields, draft_id: originalId }] }) : Response.json(savedRecoveryDraft(originalId));
    writes++;
    return writes === 1 ? pending.promise : Response.json(savedRecoveryDraft(String(input).split("/").at(-1)!, JSON.parse(String(init.body)).draft));
  };
  createStore.reset(); dom.window.sessionStorage.clear(); const copies = recoveredBrowserCopies(); const screen = recoveryScreenHarness();
  try {
    await screen.render(true); await screen.click("Use as a separate draft");
    const adoptedId = createStore.get().draftId;
    await pauseForDraftSave(); assert.equal(writes, 1); assert.equal(createStore.get().dirty, false);
    await screen.remount(true);
    assert.equal(screen.container.querySelector("[data-guest-recovery]") === null, true);
    assert.equal(createStore.get().draftId, adoptedId); assert.equal(createStore.get().dirty, true, "aborted unsaved request is retried on the new mount");
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), copies.canonical);
    await pauseForDraftSave(); assert.equal(writes, 2); assert.equal(createStore.get().version, 1);
    await act(async () => pending.resolve(Response.json(savedRecoveryDraft(adoptedId!, { ...filledSample(), name: "Stale interrupted response" }, 99))));
    assert.equal(createStore.get().version, 1); assert.equal(createStore.get().draft.name, "Browser-only recovered edits");
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), null);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), null);
  } finally { await screen.close(); globalThis.fetch = previousFetch; }
});

test("Opus N5 an actual guest write failure remains a storage error without deleting the previous readable copy", async () => {
  const previousFetch = globalThis.fetch; globalThis.fetch = async () => assert.fail("Unsigned drafts must stay local");
  createStore.reset(); dom.window.sessionStorage.clear(); const screen = recoveryScreenHarness();
  const storage = dom.window.sessionStorage; const prototype = Object.getPrototypeOf(storage);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "setItem")!;
  try {
    await screen.render(false); await screen.name("Last durable browser copy");
    const durable = storage.getItem(GUEST_DRAFT_KEY);
    Object.defineProperty(prototype, "setItem", { configurable: true, value(this: Storage, key: string, value: string) {
      if (key === GUEST_DRAFT_KEY) throw new Error("Synthetic storage write quota refusal");
      descriptor.value.call(this, key, value);
    } });
    await screen.name("Work not yet stored");
    assert.equal(screen.container.querySelector("h1")?.textContent, "Your browser draft is unavailable");
    assert.equal(storage.getItem(GUEST_DRAFT_KEY), durable);
    assert.equal(createStore.get().draft.name, "Work not yet stored");
  } finally { Object.defineProperty(prototype, "setItem", descriptor); await screen.close(); globalThis.fetch = previousFetch; }
});


for (const disposition of ["separate", "adopted", "keep_current"] as const) {
  test(`Opus owner remount never carries account A's ${disposition} permission into account B`, async () => {
    const previousFetch = globalThis.fetch;
    const secondAccount = { ...account, account_id: "second-existing-account", callsign: "second" };
    let owner = "A";
    let writes = 0;
    globalThis.fetch = async (input, init) => {
      const draftId = owner === "A" ? "00000000-0000-4000-8000-000000000151" : "00000000-0000-4000-8000-000000000152";
      if (init?.method === "PUT") {
        writes++;
        assert.equal(owner, "B");
        return Response.json(savedRecoveryDraft(draftId, JSON.parse(String(init.body)).draft, 2));
      }
      return String(input).endsWith("resume=true") ? Response.json({ next_cursor: null, items: [{ ...draftSummaryFields, draft_id: draftId }] }) : Response.json(savedRecoveryDraft(draftId, { ...filledSample(), name: `Account ${owner} draft` }));
    };
    createStore.reset(); dom.window.sessionStorage.clear();
    const copies = recoveredBrowserCopies(); const screen = recoveryScreenHarness();
    try {
      await screen.render(true);
      assert.equal(createStore.guestRecovery().choice.ownerId, account.account_id, "initial restoration must bind its known account after any store reset");
      await screen.click({ separate: "Continue with a separate draft", adopted: "Use as a separate draft", keep_current: "Keep editing my account draft" }[disposition]);
      assert.equal(createStore.guestRecovery().choice.disposition, disposition);
      owner = "B";
      await screen.remount(true, secondAccount);
      assert.equal(screen.container.querySelector("[data-guest-recovery]") !== null, true, "a different owner must make its own recovery choice after remount");
      assert.deepEqual(createStore.guestRecovery().choice, { ownerId: secondAccount.account_id, disposition: "review" });
      assert.equal(createStore.get().draft.name, "Account B draft");
      await screen.click("Keep editing my account draft");
      await screen.name("Account B explicitly edited work");
      await pauseForDraftSave();
      assert.equal(writes, 1, "visible editor and autosave must agree about B's explicit permission");
      assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), copies.retained);
      assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), copies.canonical);
    } finally { await screen.close(); globalThis.fetch = previousFetch; }
  });
}


for (const disposition of ["separate", "adopted"] as const) {
  test(`Opus guest ownership becomes account A's ${disposition} choice before remounting as B`, async () => {
    const previousFetch = globalThis.fetch;
    const secondAccount = { ...account, account_id: "second-existing-account", callsign: "second" };
    const secondDraftId = "00000000-0000-4000-8000-000000000153";
    let writes = 0;
    globalThis.fetch = async (input, init) => {
      if (init?.method === "PUT") {
        writes++;
        return Response.json(savedRecoveryDraft(secondDraftId, JSON.parse(String(init.body)).draft, 2));
      }
      return String(input).endsWith("resume=true") ? Response.json({ next_cursor: null, items: [{ ...draftSummaryFields, draft_id: secondDraftId }] }) : Response.json(savedRecoveryDraft(secondDraftId, { ...filledSample(), name: "Account B draft" }));
    };
    createStore.reset(); dom.window.sessionStorage.clear();
    const copies = recoveredBrowserCopies(); const screen = recoveryScreenHarness();
    try {
      await screen.render(false);
      await screen.click(disposition === "separate" ? "Continue with a separate draft" : "Use recovered draft");
      if (disposition === "separate") await screen.name("Guest separate work belonging to A");
      await screen.render(true);
      assert.equal(createStore.get().ownerId, account.account_id);
      assert.deepEqual(createStore.guestRecovery().choice, { ownerId: account.account_id, disposition }, "the first signed-in owner claims the exact guest recovery choice");
      const claimedCanonical = dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY);
      await screen.remount(true, secondAccount);
      assert.equal(screen.container.querySelector("[data-guest-recovery]") !== null, true, "a guest choice already claimed by A must not transfer to B");
      assert.deepEqual(createStore.guestRecovery().choice, { ownerId: secondAccount.account_id, disposition: "review" });
      await screen.click("Keep editing my account draft");
      await screen.name("Account B deliberate edits"); await pauseForDraftSave();
      assert.equal(writes, 1);
      assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), copies.retained);
      assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), claimedCanonical);
    } finally { await screen.close(); globalThis.fetch = previousFetch; }
  });
}


for (const unavailable of ["loading", "error", "pending"] as const) for (const disposition of ["separate", "adopted"] as const) {
  test(`Opus unknown identity ${unavailable} preserves A's ${disposition} ownership and mounted work`, async () => {
    const previousFetch = globalThis.fetch;
    let identityAvailable = true;
    let writes = 0;
    let requestsWhileUnknown = 0;
    globalThis.fetch = async (input, init) => {
      if (!identityAvailable) requestsWhileUnknown++;
      writes++;
      assert.equal(identityAvailable, true, "unavailable account identity cannot authorize any new request");
      assert.equal(init?.method, "PUT", "temporary identity unavailability must not load a new unsaved draft UUID");
      return Response.json(savedRecoveryDraft(String(input).split("/").at(-1)!, JSON.parse(String(init.body)).draft));
    };
    createStore.reset(); dom.window.sessionStorage.clear(); recoveredBrowserCopies();
    const screen = recoveryScreenHarness();
    try {
      await screen.render(false);
      await screen.click(disposition === "separate" ? "Continue with a separate draft" : "Use recovered draft");
      if (disposition === "separate") await screen.name("Separate work saved only for A");
      await screen.render(true);
      const before = createStore.get();
      const canonical = dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY);
      const retained = dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY);
      assert.equal(writes, 0, "the test pauses identity before the first autosave");
      identityAvailable = false;
      if (unavailable === "pending") await screen.remount(false, null, "loading", true);
      else await screen.render(true, null, unavailable);
      await pauseForDraftSave();
      assert.equal(requestsWhileUnknown, 0);
      assert.deepEqual(createStore.guestRecovery().choice, { ownerId: account.account_id, disposition }, "unknown account identity must not clear the last authoritative choice");
      if (unavailable === "error") assert.match(screen.container.querySelector('[role="alert"]')?.textContent ?? "", /Your account could not load/);
      identityAvailable = true;
      await screen.render(true);
      assert.equal(screen.container.querySelector("[data-guest-recovery]") === null, true);
      assert.equal(screen.container.querySelector<HTMLInputElement>('[aria-label="Name"]')?.value, before.draft.name);
      assert.equal(createStore.get().draftId, before.draftId);
      assert.equal(createStore.get().ownerId, account.account_id);
      assert.equal(createStore.get().phase, "ready");
      assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), retained);
      assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), canonical);
      await pauseForDraftSave();
      assert.equal(writes, 1, "autosave resumes after identity recovers without requiring another edit");
      assert.equal(createStore.get().draftId, before.draftId);
      assert.equal(createStore.get().version, 1);
      assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), disposition === "adopted" ? null : retained);
      assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), disposition === "adopted" ? null : canonical);
    } finally { await screen.close(); globalThis.fetch = previousFetch; }
  });
}

for (const path of ["separate", "changed"] as const) {
  test(`Opus R1 ${path} recovery cannot replace mounted unsaved guest work`, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => assert.fail("Guest recovery must remain local");
    createStore.reset(); dom.window.sessionStorage.clear();
    if (path === "separate") recoveredBrowserCopies();
    const screen = recoveryScreenHarness();
    try {
      await screen.render(false);
      if (path === "separate") await screen.click("Continue with a separate draft");
      else {
        await screen.name("Previous durable guest work");
        recoveredBrowserCopies();
      }
      await screen.name("Irreplaceable mounted guest work");
      await screen.click(path === "separate" ? "Review browser draft" : "Check browser storage again");
      const use = [...screen.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use recovered draft");
      assert.equal(use !== undefined, true);
      assert.equal(use!.disabled, true, "Unsaved work must be protected for guests too");
      await act(async () => use!.click());
      assert.equal(createStore.get().draft.name, "Irreplaceable mounted guest work");
      assert.match(screen.container.textContent!, /current draft.*save|save.*current draft/i);
      assert.equal(JSON.parse(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY)!).draft.name, "Browser-only recovered edits");
    } finally { await screen.close(); globalThis.fetch = previousFetch; }
  });
}

test("Opus R2 pending identity remount postpones saved allowlist reads until account verification", async () => {
  const previousFetch = globalThis.fetch;
  const draftId = "00000000-0000-4000-8000-000000000181";
  const draft = { ...filledSample(), allowlist_id: "00000000-0000-4000-8000-000000000182" };
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/entries")) return Response.json({ quote: draft.quote_type, source: null, entries: [{ wallet: "0x" + "1".padStart(64, "0"), cap: "1000001" }] });
    return Response.json(savedRecoveryDraft(draftId, draft));
  };
  createStore.reset({ phase: "ready", ownerId: account.account_id, draftId, version: 1, draft }); dom.window.sessionStorage.clear();
  const screen = recoveryScreenHarness();
  try {
    await screen.render(false, null, "loading", true);
    assert.equal(calls.length, 0, "An existing wallet cookie must not start account reads while identity is unknown");
    assert.equal(createStore.get().draft.allowlist_id, draft.allowlist_id);
    await screen.render(true);
    assert.equal(calls.filter((url) => url.endsWith("/entries")).length, 1);
    assert.equal(createStore.get().ownerId, account.account_id);
  } finally { await screen.close(); globalThis.fetch = previousFetch; }
});

test("Opus R3 closing recovery restarts a blocked autosave without another edit", async () => {
  const previousFetch = globalThis.fetch; let writes = 0;
  const draftId = "00000000-0000-4000-8000-000000000183";
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") { writes++; return Response.json(savedRecoveryDraft(draftId, JSON.parse(String(init.body)).draft, 2)); }
    return String(input).endsWith("resume=true") ? Response.json({ next_cursor: null, items: [{ ...draftSummaryFields, draft_id: draftId }] }) : Response.json(savedRecoveryDraft(draftId));
  };
  createStore.reset(); dom.window.sessionStorage.clear(); recoveredBrowserCopies(); const screen = recoveryScreenHarness();
  try {
    await screen.render(true); await screen.click("Keep editing my account draft");
    await screen.name("Unsaved before reviewing recovery");
    await act(async () => createStore.chooseGuest("separate"));
    await screen.remount(true);
    await screen.click("Review browser draft");
    await pauseForDraftSave(); assert.equal(writes, 0, "Recovery pauses saves");
    await screen.click("Keep editing my account draft");
    await pauseForDraftSave(); assert.equal(writes, 1, "Clearing the recovery block must reschedule unchanged dirty work");
    assert.equal(createStore.get().draft.name, "Unsaved before reviewing recovery");
  } finally { await screen.close(); globalThis.fetch = previousFetch; }
});

test("Opus R4 saved browser receipt survives a new draft for the same owner but never follows a different owner", async () => {
  createStore.reset({ ownerId: account.account_id });
  const snapshot = { retainedRaw: "original retained bytes", canonicalRaw: "saved canonical bytes" };
  createStore.bindGuestOwner(account.account_id);
  createStore.rememberGuestSave(snapshot);
  try {
    createStore.startNewDraft();
    assert.deepEqual(createStore.guestRecovery().savedSnapshot, snapshot);
    assert.deepEqual(createStore.guestRecovery().choice, { ownerId: account.account_id, disposition: "review" });
    createStore.bindGuestOwner("different-existing-owner");
    assert.equal(createStore.guestRecovery().savedSnapshot, null);
  } finally { createStore.reset(); }
});

test("Opus R4 saved guest cannot be adopted again after starting a new same-owner draft when receipt storage failed", async () => {
  const previousFetch = globalThis.fetch;
  const originalCreateUrl = URL.createObjectURL; const originalRevokeUrl = URL.revokeObjectURL;
  const storage = dom.window.sessionStorage; const prototype = Object.getPrototypeOf(storage);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "setItem")!;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") return Response.json(savedRecoveryDraft(String(input).split("/").at(-1)!, JSON.parse(String(init.body)).draft));
    return Response.json({ next_cursor: null, items: [] });
  };
  createStore.reset(); storage.clear(); const copies = recoveredBrowserCopies(); const screen = recoveryScreenHarness();
  try {
    await screen.render(false); await screen.click("Use recovered draft");
    Object.defineProperty(prototype, "setItem", { configurable: true, value(this: Storage, key: string, value: string) {
      if (key === GUEST_DRAFT_ACKNOWLEDGED_KEY) throw new Error("Synthetic receipt quota refusal");
      descriptor.value.call(this, key, value);
    } });
    await screen.render(true); await pauseForDraftSave();
    assert.equal(createStore.get().version, 1);
    assert.equal(createStore.guestRecovery().savedSnapshot !== null, true);
    await act(async () => createStore.startNewDraft());
    await screen.click("Review browser draft");
    assert.equal(screen.container.querySelector("h1")?.textContent, "This browser draft was already saved");
    assert.equal([...screen.container.querySelectorAll("button")].some((button) => button.textContent?.startsWith("Use ")), false);
    assert.equal(storage.getItem(RETAINED_GUEST_DRAFT_KEY), copies.retained);
  } finally {
    Object.defineProperty(prototype, "setItem", descriptor);
    URL.createObjectURL = originalCreateUrl; URL.revokeObjectURL = originalRevokeUrl;
    await screen.close(); globalThis.fetch = previousFetch;
  }
});

test("Opus R3 first image save serializes autosave and preserves edits typed while it is pending", async () => {
  const previousFetch = globalThis.fetch;
  const originalCreateUrl = URL.createObjectURL; const originalRevokeUrl = URL.revokeObjectURL;
  const pending = Promise.withResolvers<Response>();
  const writes: { version: number; draft: ReturnType<typeof filledSample> }[] = [];
  const draftId = "00000000-0000-4000-8000-000000000184";
  let imageWrites = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/logo")) { imageWrites++; return Response.json(savedRecoveryDraft(draftId, writes[0]!.draft)); }
    if (init?.method === "PUT") {
      writes.push(JSON.parse(String(init.body)));
      return writes.length === 1 ? pending.promise : Response.json(savedRecoveryDraft(draftId, writes.at(-1)!.draft, 2));
    }
    return Response.json({ next_cursor: null, items: [] });
  };
  URL.createObjectURL = () => "blob:owned-logo-fixture"; URL.revokeObjectURL = () => {};
  createStore.reset({ phase: "ready", ownerId: account.account_id, draftId, version: 0, draft: filledSample(), dirty: true }); dom.window.sessionStorage.clear();
  const screen = recoveryScreenHarness();
  try {
    await screen.render(true);
    const logo = screen.container.querySelector<HTMLInputElement>('[data-cr-upload] + input[type="file"]');
    assert.equal(logo !== null, true);
    Object.defineProperty(logo!, "files", { configurable: true, value: [new File(["fixture image bytes"], "logo.png", { type: "image/png" })] });
    await act(async () => logo!.dispatchEvent(testEvent("change")));
    assert.equal(writes.length, 1);
    await screen.name("Edits during first image save");
    await pauseForDraftSave();
    assert.equal(writes.length, 1, "A pending first save excludes autosave of the same version");
    await act(async () => pending.resolve(Response.json(savedRecoveryDraft(draftId, writes[0]!.draft))));
    assert.equal(imageWrites, 1);
    assert.equal(createStore.get().draft.name, "Edits during first image save");
    await pauseForDraftSave();
    assert.deepEqual(writes.map((write) => write.version), [0, 1]);
    assert.equal(writes[1]!.draft.name, "Edits during first image save");
    assert.equal(createStore.get().version, 2);
  } finally {
    pending.resolve(Response.json(savedRecoveryDraft(draftId)));
    await screen.close(); globalThis.fetch = previousFetch;
    URL.createObjectURL = originalCreateUrl; URL.revokeObjectURL = originalRevokeUrl;
  }
});

test("Opus F1 partial browser cleanup keeps the saved account draft editable and its remaining copy acknowledged", async () => {
  const previousFetch = globalThis.fetch; let writes = 0; let refusedRemovals = 0;
  const storage = dom.window.sessionStorage; const prototype = Object.getPrototypeOf(storage);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "removeItem")!;
  globalThis.fetch = async (input, init) => {
    if (init?.method !== "PUT") return Response.json({ next_cursor: null, items: [] });
    writes++;
    return Response.json(savedRecoveryDraft(String(input).split("/").at(-1)!, JSON.parse(String(init.body)).draft, writes));
  };
  createStore.reset(); storage.clear(); recoveredBrowserCopies(); const screen = recoveryScreenHarness();
  try {
    await screen.render(false); await screen.click("Use recovered draft");
    const adoptedCanonical = storage.getItem(GUEST_DRAFT_KEY);
    Object.defineProperty(prototype, "removeItem", { configurable: true, value(this: Storage, key: string) {
      if (key === GUEST_DRAFT_KEY) { refusedRemovals++; throw new Error("Synthetic canonical removal refusal"); }
      descriptor.value.call(this, key);
    } });
    await screen.render(true); await pauseForDraftSave();
    assert.equal(writes, 1); assert.equal(refusedRemovals, 1);
    assert.equal(storage.getItem(RETAINED_GUEST_DRAFT_KEY), null);
    assert.equal(storage.getItem(GUEST_DRAFT_KEY), adoptedCanonical);
    assert.notEqual(storage.getItem(GUEST_DRAFT_ACKNOWLEDGED_KEY), null);
    assert.match(screen.container.textContent!, /account saved this draft.*cleanup could not finish/i);
    await screen.name("Edits after partial cleanup");
    await pauseForDraftSave();
    assert.equal(writes, 2); assert.equal(createStore.get().version, 2);
    await screen.click("Review browser draft");
    assert.equal(screen.container.querySelector("h1")?.textContent, "This browser draft was already saved");
    assert.equal([...screen.container.querySelectorAll("button")].some((button) => button.textContent?.startsWith("Use ")), false);
    assert.equal(storage.getItem(GUEST_DRAFT_KEY), adoptedCanonical);
  } finally { Object.defineProperty(prototype, "removeItem", descriptor); await screen.close(); globalThis.fetch = previousFetch; }
});

for (const persistence of ["healthy", "separate", "failed"] as const) {
  test(`Opus F2 beforeunload protects ${persistence} guest edits only when they are not persisted`, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => assert.fail("Guest edits must remain local");
    const storage = dom.window.sessionStorage; const prototype = Object.getPrototypeOf(storage);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "setItem")!;
    createStore.reset(); storage.clear();
    if (persistence === "separate") recoveredBrowserCopies();
    const screen = recoveryScreenHarness();
    const leaving = () => { const event = new dom.window.Event("beforeunload", { cancelable: true }); dom.window.dispatchEvent(event); return event.defaultPrevented; };
    try {
      await screen.render(false);
      if (persistence === "separate") await screen.click("Continue with a separate draft");
      assert.equal(leaving(), false, "An untouched guest draft needs no unload warning");
      if (persistence === "failed") {
        await screen.name("Last persisted guest edits");
        assert.equal(leaving(), false);
        Object.defineProperty(prototype, "setItem", { configurable: true, value(this: Storage, key: string, value: string) {
          if (key === GUEST_DRAFT_KEY) throw new Error("Synthetic guest persistence failure");
          descriptor.value.call(this, key, value);
        } });
      }
      await screen.name("Current guest edits");
      assert.equal(createStore.get().draft.name, "Current guest edits");
      assert.equal(leaving(), persistence !== "healthy", "Only durable browser persistence can replace the unload warning");
      if (persistence === "healthy") assert.equal(JSON.parse(storage.getItem(GUEST_DRAFT_KEY)!).draft.name, "Current guest edits");
      if (persistence === "failed") assert.equal(JSON.parse(storage.getItem(GUEST_DRAFT_KEY)!).draft.name, "Last persisted guest edits");
    } finally { Object.defineProperty(prototype, "setItem", descriptor); await screen.close(); globalThis.fetch = previousFetch; }
  });
}

test("Opus F3 a lost save acknowledgement followed by newer edits preserves the local body across conflict and retries its new version", async () => {
  const previousFetch = globalThis.fetch;
  const writes: { version: number; draft: ReturnType<typeof filledSample> }[] = [];
  let stored: ReturnType<typeof savedRecoveryDraft> | null = null;
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, "PUT");
    writes.push(JSON.parse(String(init.body)));
    const draftId = String(input).split("/").at(-1)!;
    if (writes.length === 1) {
      stored = savedRecoveryDraft(draftId, writes[0]!.draft, 1);
      throw new Error("Synthetic acknowledgement lost after the server committed");
    }
    if (writes.length === 2) return Response.json({ error: { code: "draft_conflict", draft: stored } }, { status: 409 });
    return Response.json(savedRecoveryDraft(draftId, writes.at(-1)!.draft, 2));
  };
  createStore.reset(); dom.window.sessionStorage.clear(); recoveredBrowserCopies(); const screen = recoveryScreenHarness();
  try {
    await screen.render(false); await screen.click("Use recovered draft");
    const retained = dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY);
    const canonical = dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY);
    await screen.render(true); await pauseForDraftSave();
    assert.equal(writes.length, 1); assert.equal(createStore.get().version, 0);
    await screen.name("Edits after lost acknowledgement");
    const newer = createStore.get().draft;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 2100)));
    assert.equal(writes.length, 2); assert.deepEqual(writes.map((write) => write.version), [0, 0]);
    assert.deepEqual(createStore.get().draft, newer, "Conflict must never replace newer local work with the earlier committed body");
    assert.equal(createStore.get().version, 1); assert.equal(createStore.get().dirty, true);
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), retained);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), canonical, "A conflict is not acknowledgement of the current local body");
    await pauseForDraftSave();
    assert.equal(writes.length, 3); assert.equal(writes[2]!.version, 1); assert.deepEqual(writes[2]!.draft, newer);
    assert.equal(createStore.get().version, 2); assert.equal(createStore.get().dirty, false);
    assert.equal(dom.window.sessionStorage.getItem(GUEST_DRAFT_KEY), null);
    assert.equal(dom.window.sessionStorage.getItem(RETAINED_GUEST_DRAFT_KEY), null);
  } finally { await screen.close(); globalThis.fetch = previousFetch; }
});

test("Opus F3 conflict preserves edits typed while the request is pending and rebases only the saved version", async () => {
  const previousFetch = globalThis.fetch; const pending = Promise.withResolvers<Response>();
  const draftId = "00000000-0000-4000-8000-000000000191";
  const writes: { version: number; draft: ReturnType<typeof filledSample> }[] = [];
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== "PUT") return Response.json(savedRecoveryDraft(draftId));
    writes.push(JSON.parse(String(init.body)));
    return writes.length === 1 ? pending.promise : Response.json(savedRecoveryDraft(draftId, writes.at(-1)!.draft, 3));
  };
  createStore.reset({ phase: "ready", ownerId: account.account_id, draftId, version: 1, draft: filledSample() }); dom.window.sessionStorage.clear();
  const screen = recoveryScreenHarness();
  try {
    await screen.render(true); await screen.name("Body sent before conflict"); await pauseForDraftSave();
    assert.equal(writes.length, 1);
    await screen.name("Edits while conflict pending");
    const newer = createStore.get().draft;
    await act(async () => pending.resolve(Response.json({ error: { code: "draft_conflict", draft: savedRecoveryDraft(draftId, { ...filledSample(), name: "Other committed body" }, 2) } }, { status: 409 })));
    assert.deepEqual(createStore.get().draft, newer);
    assert.equal(createStore.get().version, 2); assert.equal(createStore.get().dirty, true);
    await pauseForDraftSave();
    assert.equal(writes.length, 2); assert.equal(writes[1]!.version, 2); assert.deepEqual(writes[1]!.draft, newer);
    assert.equal(createStore.get().version, 3); assert.equal(createStore.get().dirty, false);
  } finally { await screen.close(); globalThis.fetch = previousFetch; }
});

test("#588: a chosen start that passes while the form sits idle reads as past from then, and Opens counts from it", async (t) => {
  const { useCreateState } = await import("./create-store");
  const { startFieldText } = await import("./create-field-model");
  const now = Math.ceil(Date.now() / 60_000) * 60_000;
  const start = now + 5 * 60_000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  createStore.reset({ phase: "ready", draft: { ...filledSample(), start_ms: start }, step: "raise", touched: new Set(["start_ms"]), nowMs: now });
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  function Draft() {
    const state = useCreateState();
    return <SocialViewerProvider signedIn><CreateView state={state} onLogo={() => undefined} onList={() => undefined} onRetry={() => undefined} signIn={null} /></SocialViewerProvider>;
  }
  const field = () => container.querySelector<HTMLInputElement>('[data-f="start_ms"]')!;
  const error = () => container.querySelector('[data-err="start_ms"]')?.textContent ?? "";
  try {
    await act(async () => root.render(<Draft />));
    assert.equal(error(), "");
    assert.equal(field().getAttribute("min"), startFieldText(now));
    await act(async () => t.mock.timers.tick(5 * 60_000 - 1));
    assert.equal(error(), "", "nothing ticks before the start");
    await act(async () => t.mock.timers.tick(1));
    assert.equal(error(), "Pick a time from now on", "no edit needed: the start passed");
    assert.equal(field().getAttribute("aria-invalid"), "true");
    assert.equal(field().getAttribute("min"), startFieldText(start));
    assert.equal(createStore.get().nowMs, start);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    createStore.reset();
  }
});

test("cover dimension reads revoke their own URL on replacement, removal and unmount", async (t) => {
  const images: HTMLImageElement[] = [];
  const revoked: string[] = [];
  let nextUrl = 0;
  t.mock.method(URL, "createObjectURL", () => `blob:cover-${++nextUrl}`);
  t.mock.method(URL, "revokeObjectURL", (url: string) => { revoked.push(url); });
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
  Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
    constructor() { const image = document.createElement("img"); images.push(image); return image; }
  } });
  createStore.reset({ phase: "ready", step: "details", cover: { url: "/cover.webp", width: 1536, height: 512 } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  const pick = async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["image"], "cover.webp", { type: "image/webp" })] });
    await act(async () => input.dispatchEvent(testEvent("change")));
  };
  try {
    await act(async () => root.render(<ShellActionsProvider><CreateForm state={createStore.get()} issues={[]} onLogo={() => undefined} onCover={() => undefined} onCoverRemove={() => undefined} onList={() => undefined} /></ShellActionsProvider>));
    await pick();
    const staleLoad = images[0]!.onload!;
    await pick();
    assert.deepEqual(revoked, ["blob:cover-1"]);
    assert.equal(images[0]!.onload, null);
    await act(async () => staleLoad.call(images[0]!, new dom.window.Event("load")));
    assert.deepEqual(revoked, ["blob:cover-1"], "a canceled load cannot finish twice");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Remove")!.click());
    assert.deepEqual(revoked, ["blob:cover-1", "blob:cover-2"]);
    await pick();
    await act(async () => root.unmount()); mounted = false;
    assert.deepEqual(revoked, ["blob:cover-1", "blob:cover-2", "blob:cover-3"]);
    assert.ok(images.every(image => image.onload === null && image.onerror === null && !image.hasAttribute("src")));
  } finally {
    if (mounted) await act(async () => root.unmount());
    container.remove(); createStore.reset();
    if (previousImage) Object.defineProperty(globalThis, "Image", previousImage);
    else Reflect.deleteProperty(globalThis, "Image");
  }
});
