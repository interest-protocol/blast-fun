import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";
import { useVestingAccountState, vestingAccountKey } from "./use-account-state.ts";

installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

test("account recovery survives sign-out without blocking another account or accepting its late responses", async (t) => {
  let owner: string | null = "A";
  let current: ReturnType<typeof useVestingAccountState<string | null>>;
  function Probe() {
    current = useVestingAccountState<string | null>(owner, null);
    return <output>{current[0] ?? "ready"}</output>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const render = async () => { await act(async () => root.render(<Probe />)); };
  await render();
  const setA = current![1];
  await act(async () => setA("original-digest"));
  owner = null;
  await render();
  assert.equal(host.textContent, "ready");
  owner = "B";
  await render();
  assert.equal(host.textContent, "ready");
  await act(async () => current![1]("B-digest"));
  await act(async () => setA(value => `${value}-confirmed`));
  assert.equal(host.textContent, "B-digest");
  owner = "A";
  await render();
  assert.equal(host.textContent, "original-digest-confirmed");
});

test("recovery identity remains stable as the account loads and the callsign or wallet changes", () => {
  const loading = { signedIn: true, sessionIdentity: "A", sessionPending: true, callsign: null };
  assert.equal(vestingAccountKey(loading, "first-wallet"), "privy:A");
  assert.equal(vestingAccountKey({ ...loading, sessionPending: false, callsign: "renamed" }, "new-wallet"), "privy:A");
  assert.equal(vestingAccountKey({ ...loading, signedIn: false }, "cached-wallet"), null);
  assert.notEqual(vestingAccountKey({ ...loading, sessionIdentity: "wallet" }, "A"), vestingAccountKey({ ...loading, sessionIdentity: "wallet" }, "B"));
});

test("visitor input is adopted on sign-in and consumed before another account arrives", async (t) => {
  let owner: string | null = null;
  let current: ReturnType<typeof useVestingAccountState<string>>;
  function Probe() {
    current = useVestingAccountState(owner, "blank", true);
    return <output>{current[0]}</output>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const render = async () => { await act(async () => root.render(<Probe />)); };
  await render();
  await act(async () => current![1]("visitor-schedule"));
  owner = "A";
  await render();
  assert.equal(host.textContent, "visitor-schedule");
  owner = null;
  await render();
  assert.equal(host.textContent, "blank");
  owner = "B";
  await render();
  assert.equal(host.textContent, "blank");
  await act(async () => current![1]("B-schedule"));
  owner = "A";
  await render();
  assert.equal(host.textContent, "visitor-schedule");
});
