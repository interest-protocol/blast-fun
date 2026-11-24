import assert from "node:assert/strict";
import test from "node:test";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { installTestDom, setInputValue, testEvent, waitFor } from "../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LaunchpadSearch } = await import("./LaunchpadSearch.tsx");

test("launch search retries a SuiNS lookup and pages through the resolved wallet’s launches", async (t) => {
  const wallet = `0x${"a".repeat(64)}`;
  const launchId = `0x${"b".repeat(64)}`;
  const name = `${Array<string>(4).fill("c".repeat(57)).join(".")}.sui`;
  let unavailable = true;
  t.mock.method(SuiGrpcClient.prototype, "resolveNameServiceAddress", async () => {
    if (unavailable) throw new Error("Sui node unavailable");
    return { address: wallet };
  });
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input, "https://blast.test");
    if (url.pathname !== "/api/launchpad/search" || url.searchParams.get("q") !== wallet) {
      return Response.json({}, { status: 400 });
    }

    const secondPage = url.searchParams.get("cursor") === "wallet-page-two";
    return Response.json({ groups: [{ group: "wallets", section: {
      state: "available",
      provenance: {
        source: "replica", network: "mainnet", deployment: "fixture",
        checkpoint: 1, timestampMs: 1, observedAt: 1, lagMs: 0,
      },
      data: {
        items: secondPage ? [{ match: "creator", pool: null, launch: {
          launchId, coinType: `${launchId}::example::EXAMPLE`, name: "Second-page launch",
          symbol: "EXAMPLE", iconUrl: null, lifecycle: "live", creator: wallet, createdAtMs: 1,
        } }] : [],
        nextCursor: secondPage ? null : "wallet-page-two",
      },
    } }] });
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<LaunchpadSearch />));

  const field = container.querySelector<HTMLInputElement>("input[type=search]")!;
  await act(async () => {
    setInputValue(field, name);
    field.dispatchEvent(testEvent("input"));
  });
  const retry = await waitFor(
    () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again"),
    "a retry for the unavailable SuiNS lookup",
    2_000,
  );
  assert.match(container.textContent ?? "", /the SuiNS name couldn’t be looked up/);
  assert.match(container.querySelector(".err-code")?.textContent ?? "", /Code: service_unavailable/);
  assert.equal(field.value, name);
  unavailable = false;
  await act(async () => retry.click());

  const more = await waitFor(
    () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Show more launches by this wallet"),
    "the wallet's first page",
    2_000,
  );
  await act(async () => more.click());
  await waitFor(() => container.textContent?.includes("Second-page launch"), "the wallet's next page", 2_000);
  assert.equal(field.value, name);
});
