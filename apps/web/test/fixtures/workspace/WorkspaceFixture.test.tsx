import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { installTestDom, setInputValue, testEvent } from "../social/test-dom.ts";
const dom = installTestDom();
dom.window.scrollTo = () => {};
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
// Node renders the fixture without Next's alias resolution or build-time font loader.
const testFonts = `data:text/javascript,${encodeURIComponent(
  "const font = ({ variable }) => ({ variable }); export { font as Bricolage_Grotesque, font as Geist, font as Geist_Mono };",
)}`;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "next/font/google") return { url: testFonts, shortCircuit: true };
  return nextResolve(specifier.startsWith("#web/") ? new URL(`../../../src/${specifier.slice(5)}`, import.meta.url).href : specifier, context);
} });
const { WorkspaceFixture } = await import("./WorkspaceFixture");
const { tabsProbe } = await import("./tabs-probe");
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

test("root workspace producer enters its real host and the discovery adapters with production query composition", async () => {
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AppRouterContext value={router as never}><PathnameContext value="/"><WorkspaceFixture /></PathnameContext></AppRouterContext>));
    await act(async () => container.querySelector<HTMLButtonElement>("#fixture-open")!.click());
    for (let attempt = 0; attempt < 40 && !container.querySelector('[role="tablist"][aria-label="What to discover"]'); attempt++) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    assert.ok(container.querySelector('[data-workspace-host]'));
    const views = ["Coins", "Presales", "Bonding", "Feed", "Traders", "Activity", "Portfolio"] as const;
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="What to discover"] [role="tab"]')];
    assert.deepEqual(tabs.map(tab => tab.textContent), ["Coins", "Presales", "Bonding", "Posts"]);
    const more = () => container.querySelector<HTMLButtonElement>('[aria-label^="More views:"]')!;
    const moreItems = () => [...dom.document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    await act(async () => more().click());
    assert.deepEqual(moreItems().map(item => item.textContent!.replace(/\s*✓\s*$/, "").trim()), ["Traders", "Activity", "Portfolio"]);
    await act(async () => more().click());
    for (const view of views) {
      const visibleTab = container.querySelector<HTMLButtonElement>(`#workspace-data-tab-${view}`);
      await act(async () => {
        if (visibleTab) visibleTab.click();
        else more().click();
      });
      if (!visibleTab) await act(async () => moreItems().find(item => item.textContent!.replace(/\s*✓\s*$/, "").trim() === view)!.click());
      // A tab view is the selected tab; a More view is More's value and never a fifth tab.
      const tab = container.querySelector<HTMLButtonElement>(`#workspace-data-tab-${view}`);
      if (visibleTab) assert.equal(tab!.getAttribute("aria-selected"), "true");
      else {
        assert.equal(tab, null, view);
        assert.equal(more().getAttribute("aria-label"), `More views: ${view}`);
      }
      const panel = container.querySelector('[role="tabpanel"]')!;
      assert.equal(panel.getAttribute("aria-labelledby"), visibleTab ? tab!.id : null);
      // A view opened from More names its panel directly; the More select is not its name.
      assert.equal(panel.getAttribute("aria-label"), visibleTab ? null : view);
      assert.match(panel.textContent!, new RegExp(`Simulated ${view} Data adapter`));
      const field = container.querySelector<HTMLInputElement>(`input[aria-label="Saved ${view} position"]`)!;
      assert.ok(field);
      await act(async () => { setInputValue(field, "47"); field.dispatchEvent(testEvent("input")); });
      const setup = tabsProbe().snapshot().setup!;
      assert.equal(setup.data.controls[view as keyof typeof setup.data.controls].navigation.scroll_top, 47);
      for (const invalid of ["", "-1"]) {
        await act(async () => { setInputValue(field, invalid); field.dispatchEvent(testEvent("input")); });
        assert.equal(tabsProbe().snapshot().setup!.data.controls[view].navigation.scroll_top, 47,
          "Cleared or negative positions must not overwrite the saved position");
      }
    }
  } finally { await act(async () => root.unmount()); container.remove(); }
});
