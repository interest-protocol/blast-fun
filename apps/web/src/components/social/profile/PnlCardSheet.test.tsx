import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { useState } from "react";
import { PROFILE_PNL } from "../../../../test/fixtures/social/profile/pnl-fixtures.ts";
import { installTestDom, recordAnimations } from "../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
// Next's image component is verified in the browser; DOM tests need only its image.
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve("react")).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "next/image") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`import {createElement} from ${JSON.stringify(reactUrl)}; export default function Image({unoptimized, ...props}) { return createElement('img', props); }`)}` };
  return nextResolve(specifier, context);
} });
const motion = recordAnimations();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: PnlCardSheet } = await import("./PnlCardSheet");
const card = { callsign: "nova", figures: PROFILE_PNL.totals };

test("closing a card finishes the sheet exit and restores the opener, including after a render failure", async (t) => {
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); motion.all.length = 0; });
  function Page() {
    const [show, setShow] = useState(false);
    return <><button onClick={() => setShow(true)} type="button">Create card</button>{show ? <PnlCardSheet card={card} onClose={() => setShow(false)} /> : null}</>;
  }
  await act(async () => root.render(<Page />));
  const opener = container.querySelector<HTMLButtonElement>("button")!;
  opener.focus();
  await act(async () => opener.click());
  assert.match(container.textContent!, /Card could not render/);
  assert.ok(document.querySelector('[role="dialog"]'));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  assert.ok(document.querySelector('[role="dialog"]'), "sheet stays mounted for its exit");
  await act(async () => motion.finishAll());
  assert.equal(document.querySelector('[role="dialog"]') === null, true);
  assert.equal(document.activeElement === opener, true);
  assert.equal(document.body.style.overflow, "");
});


test("sharing, cancellation and style edits always use the current card", async (t) => {
  const canvas = Object.getPrototypeOf(document.createElement("canvas"));
  const getContext = Object.getOwnPropertyDescriptor(canvas, "getContext")!;
  const toBlob = Object.getOwnPropertyDescriptor(canvas, "toBlob")!;
  const toDataURL = Object.getOwnPropertyDescriptor(canvas, "toDataURL")!;
  const decoded: string[] = [];
  Object.defineProperty(globalThis, "Image", { configurable: true, value: class { src = ""; naturalWidth = 640; naturalHeight = 480; async decode() { decoded.push(this.src); } } });
  Object.defineProperty(canvas, "getContext", { configurable: true, value: () => ({ drawImage() {} }) });
  Object.defineProperty(canvas, "toBlob", { configurable: true, value: (done: BlobCallback) => done(new Blob(["png"], { type: "image/png" })) });
  Object.defineProperty(canvas, "toDataURL", { configurable: true, value: () => "data:image/png;base64,aGVsbG8=" });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  let complete = () => {};
  let cancel = () => {};
  let calls = 0;
  Object.defineProperty(navigator, "share", { configurable: true, value: (data: ShareData) => {
    assert.equal(data.url, `${window.location.origin}/?ref=nova`);
    assert.equal(data.files?.length, 1);
    calls += 1;
    return new Promise<void>((resolve, reject) => {
      complete = resolve;
      cancel = () => reject(new DOMException("Cancelled", "AbortError"));
    });
  } });
  t.after(() => {
    Object.defineProperty(canvas, "getContext", getContext);
    Object.defineProperty(canvas, "toBlob", toBlob);
    Object.defineProperty(canvas, "toDataURL", toDataURL);
    Reflect.deleteProperty(globalThis, "Image");
    Reflect.deleteProperty(navigator, "canShare");
    Reflect.deleteProperty(navigator, "share");
  });
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); motion.all.length = 0; });
  await act(async () => root.render(<PnlCardSheet card={card} onClose={() => {}} />));
  assert.equal(decoded[0], "/social/pnl-loss-meme.webp", "loss cards prepare the supplied crying sticker");
  const share = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Share card")!;
  const status = container.querySelector('[role="status"]')!;
  await act(async () => share.click());
  assert.equal(share.disabled, true);
  await act(async () => complete());
  assert.equal(status.textContent, "Card shared.");
  await act(async () => share.click());
  assert.equal(status.textContent, "", "a new attempt must not announce the previous share's success");
  await act(async () => cancel());
  assert.equal(status.textContent, "");
  assert.equal(share.disabled, false);
  assert.ok(container.querySelector("a[download]"), "cancelling preserves the download fallback");
  await act(async () => share.click());
  await act(async () => complete());
  assert.equal(calls, 3);
  assert.equal(status.textContent, "Card shared.");
  const download = container.querySelector<HTMLAnchorElement>("a[download]")!;
  const original = download.href;
  const caption = container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => { caption.value = "diamond"; caption.dispatchEvent(new window.Event("change", { bubbles: true })); });
  assert.notEqual(container.querySelector<HTMLAnchorElement>("a[download]")!.href, original);
  assert.equal(status.textContent, "", "editing must clear a previous share result");
  const beforeDeath = container.querySelector<HTMLAnchorElement>("a[download]")!.href;
  await act(async () => { caption.value = "last"; caption.dispatchEvent(new window.Event("change", { bubbles: true })); });
  assert.notEqual(container.querySelector<HTMLAnchorElement>("a[download]")!.href, beforeDeath);
  assert.equal(decoded.at(-2), "/social/pnl-death-meme.webp");
  assert.ok(decodeURIComponent(decoded.at(-1)!).includes("sayin it since $MELANIA"));
  await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"][value="this-is-fine"]')!.click());
  await act(async () => { caption.value = "diamond"; caption.dispatchEvent(new window.Event("change", { bubbles: true })); });
  assert.equal(container.querySelector('input[type="file"]'), null, "Custom image uploads are unavailable");
  assert.doesNotMatch(container.textContent!, /Upload image|Change image|Remove image|10 MB|edges may crop/);
  for (const name of ["Flight report", "Afterburner", "Full blast", "Launch pad", "Helmet grid", "Soft landing"]) {
    assert.ok([...container.querySelectorAll("label")].some((label) => label.textContent?.includes(name)), name);
  }
  const flight = container.querySelector<HTMLInputElement>('input[type="radio"][value="flight-report"]')!;
  const beforeStyle = container.querySelector<HTMLAnchorElement>("a[download]")!.href;
  await act(async () => flight.click());
  assert.equal(flight.checked, true);
  assert.notEqual(container.querySelector<HTMLAnchorElement>("a[download]")!.href, beforeStyle);
  assert.equal(decoded.at(-2), "/social/pnl-flight-report.svg");
  assert.ok(decodeURIComponent(decoded.at(-1)!).includes('fill="#FF8DA6">−$170.00'));
  assert.equal(container.querySelectorAll('input[type="radio"]').length, 8);
  assert.equal(container.querySelector('input[value="money-printer"]'), null);
  const death = container.querySelector<HTMLInputElement>('input[value="death"]')!;
  await act(async () => death.click());
  assert.equal(decoded.at(-2), "/social/pnl-death-meme.webp");
  assert.ok(decodeURIComponent(decoded.at(-1)!).includes("−$170.00"));

  const gain = { ...card, figures: { realized_usd: "1000.00", unrealized_usd: "284.00", total_usd: "1284.00" } };
  await act(async () => root.render(<PnlCardSheet card={gain} onClose={() => {}} />));
  assert.equal(container.querySelectorAll('input[type="radio"]').length, 7);
  assert.equal(container.querySelector('input[value="death"]'), null);
  assert.equal(container.querySelector('input[value="this-is-fine"]'), null);
  assert.equal(container.querySelector<HTMLInputElement>('input[value="money-printer"]')!.checked, true, "an ineligible selection falls back to a gain design");
  assert.equal(decoded.at(-2), "/social/pnl-gain-meme.webp");
  assert.ok(decodeURIComponent(decoded.at(-1)!).includes("+$1,284.00"));

  for (const option of container.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
    await act(async () => option.click());
    const svg = decodeURIComponent(decoded.at(-1)!);
    assert.ok(svg.includes("+$1,284.00"));
    assert.ok(svg.includes("@nova"));
    assert.ok(container.querySelector<HTMLAnchorElement>('a[download]')!.href);
  }
  const zero = { ...card, figures: { realized_usd: "0.00", unrealized_usd: "0.00", total_usd: "0.00" } };
  await act(async () => root.render(<PnlCardSheet card={zero} onClose={() => {}} />));
  assert.equal(container.querySelectorAll('input[type="radio"]').length, 6);
  assert.ok(decodeURIComponent(decoded.at(-1)!).includes("$0.00"));

  const openWindow = Object.getOwnPropertyDescriptor(window, "open")!;
  const fetch = globalThis.fetch;
  t.after(() => { Object.defineProperty(window, "open", openWindow); globalThis.fetch = fetch; });
  const popup = { opener: window, closed: false, location: { href: "about:blank" }, close() { this.closed = true; } };
  const events: string[] = [];
  Object.defineProperty(window, "open", { configurable: true, value: () => { events.push("open"); return popup; } });
  globalThis.fetch = async (path, init) => {
    events.push("upload");
    assert.equal(path, "/api/social/me/pnl/card");
    assert.equal(init?.method, "POST");
    assert.equal(init?.credentials, "same-origin");
    assert.ok(init?.body instanceof File);
    assert.equal(init.body.type, "image/png");
    assert.equal(init.body.name, "blast-pnl-nova-since-launch.png");
    assert.equal(popup.location.href, "about:blank", "the card must be stored before opening the composer");
    return Response.json({ path: `/card/pnl/${"a".repeat(64)}?ref=nova` });
  };
  const shareOnX = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Share on X")!;
  await act(async () => shareOnX.click());
  assert.deepEqual(events, ["open", "upload"], "open within the click to avoid popup blockers");
  assert.equal(popup.opener, null);
  const intent = new URL(popup.location.href);
  assert.equal(intent.origin + intent.pathname, "https://x.com/intent/post");
  assert.equal(intent.searchParams.get("url"), `${window.location.origin}/card/pnl/${"a".repeat(64)}?ref=nova`);
  assert.match(status.textContent!, /Review your post and press Post/);
  assert.doesNotMatch(status.textContent!, /Card shared/, "opening a composer never claims a post was published");

  globalThis.fetch = async () => Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
  await act(async () => shareOnX.click());
  assert.equal(popup.closed, true);
  assert.match(status.textContent!, /Card link could not be prepared/);
  assert.ok(container.querySelector("a[download]"), "a failed upload preserves the card download");
});
