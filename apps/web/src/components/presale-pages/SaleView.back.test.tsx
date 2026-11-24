import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SaleView } = await import("./SaleView");
const { fixtureDetail, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");

test("the detail back link retains the discovery sort and scope after a client-side navigation", async (t) => {
  const detail = fixtureDetail("mrdn");
  const entries = [
    { url: "http://127.0.0.1/presale?sort=backed&scope=watch", index: 0 },
    { url: `http://127.0.0.1/presale/${detail.presale.presale_id}`, index: 1 },
  ];
  const navigation = Object.assign(new window.EventTarget(), { currentEntry: entries[0], entries: () => entries });
  Object.assign(window, { navigation });
  window.history.replaceState(null, "", entries[0].url);
  const originalBack = window.history.back;
  let returns = 0;
  window.history.back = () => { returns += 1; };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount()); container.remove();
    window.history.back = originalBack;
    Reflect.deleteProperty(window, "navigation");
  });
  await act(async () => root.render(<SaleView detail={detail} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  const link = container.querySelector<HTMLAnchorElement>(".backbar a")!;
  assert.equal(link.getAttribute("href"), "/presale", "Next can render the detail before the navigation commits");
  await act(async () => {
    window.history.pushState(null, "", entries[1].url);
    navigation.currentEntry = entries[1];
    navigation.dispatchEvent(new window.Event("currententrychange"));
  });
  assert.equal(link.getAttribute("href"), "/presale?sort=backed&scope=watch");
  await act(async () => link.click());
  assert.equal(returns, 1);
});

test("contextual Back works without the Navigation API and retains the originating Home controls", async (t) => {
  Reflect.deleteProperty(window, "navigation");
  const detail = fixtureDetail("mrdn");
  const from = "http://127.0.0.1/?src=watchlist&w=7d&sort=volume";
  const destination = `http://127.0.0.1/presale/${detail.presale.presale_id}`;
  window.history.replaceState(null, "", from);
  window.history.pushState({ __NA: true }, "", destination);
  window.sessionStorage.setItem("blast:list-origin", JSON.stringify({ from, to: destination, at: Date.now() }));
  const originalBack = window.history.back;
  let returns = 0;
  window.history.back = () => { returns++; };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); window.history.back = originalBack; });
  await act(async () => root.render(<SaleView detail={detail} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  const link = container.querySelector<HTMLAnchorElement>(".backbar a")!;
  assert.equal(link.textContent, "Home");
  assert.equal(link.getAttribute("href"), "/?src=watchlist&w=7d&sort=volume");
  assert.equal(window.history.state.__NA, true);
  await act(async () => link.click());
  assert.equal(returns, 1);
});
