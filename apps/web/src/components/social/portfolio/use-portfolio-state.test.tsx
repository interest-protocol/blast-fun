import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const globals = globalThis as unknown as { portfolioViewer: { signedIn: boolean; callsign: string | null } };
globals.portfolioViewer = { signedIn: true, callsign: "reader" };
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "../SignInGate") return { shortCircuit: true, url: "data:text/javascript,export function useSocialViewer(){return globalThis.portfolioViewer}" };
  return next(specifier, context);
} });
const { usePortfolioState } = await import("./use-portfolio-state");
hooks.deregister();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

function Controls() {
  const [filter, setFilter] = usePortfolioState("vesting-filter", "Receiving");
  const [period, setPeriod] = usePortfolioState("history-period", "1w");
  return <><button onClick={() => setFilter("Created")}>{filter}</button><button onClick={() => setPeriod("1d")}>{period}</button></>;
}

test("reload retains selections without needing unload capture; viewer changes and Back stay scoped", async t => {
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  t.after(async () => { await act(() => root.unmount()); container.remove(); window.history.replaceState({}, "", "/"); });
  window.history.replaceState({ __NA: true }, "", "/portfolio/vestings");
  await act(() => root.render(<Controls />));
  for (const button of container.querySelectorAll("button")) await act(() => button.click());
  const entry = structuredClone(window.history.state);
  assert.equal(entry.blastListContent["portfolio:reader:vesting-filter"], "Created");
  assert.equal(entry.blastListContent["portfolio:reader:history-period"], "1d");
  assert.equal(entry.__NA, true);
  await act(() => root.unmount());
  globals.portfolioViewer = { signedIn: false, callsign: null };
  root = createRoot(container);
  await act(() => root.render(<Controls />));
  assert.equal(container.textContent, "Receiving1w");
  globals.portfolioViewer = { signedIn: true, callsign: "reader" };
  await act(() => root.render(<Controls />));
  assert.equal(container.textContent, "Created1d");
  globals.portfolioViewer = { signedIn: true, callsign: "other" };
  await act(() => root.render(<Controls />));
  assert.equal(container.textContent, "Receiving1w");
  globals.portfolioViewer = { signedIn: true, callsign: "reader" };
  await act(() => root.render(<Controls />));
  await act(() => {
    window.history.replaceState({ ...entry, blastListContent: { "portfolio:reader:vesting-filter": "History", "portfolio:reader:history-period": "all" } }, "");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  assert.equal(container.textContent, "Historyall");
});
