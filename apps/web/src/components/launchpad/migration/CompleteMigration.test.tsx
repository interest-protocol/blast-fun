import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ActionState } from "../transaction/action-machine.ts";
import { LaunchpadSignerSourceProvider } from "../transaction/LaunchpadSignerProvider";
import type { SignerSource } from "../transaction/controller";
import { actionStateFixtures, fixtureWalletSigner } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { installTestDom, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import { createMigrationFixtureChain, MIGRATION_LAUNCH_ID } from "../../../../../../packages/core/test/fixtures/modules/launch-migration/fixtures.ts";
import { CompleteMigration, MigrationPanel, MigrationUnavailable } from "./CompleteMigration.tsx";
import type { MigrationInput } from "./migration-adapter.ts";
import type { MigrationFlowState, Settlement } from "./migration-flow.ts";

const actions = actionStateFixtures<MigrationInput>({ launchId: MIGRATION_LAUNCH_ID });
const controls = {
  submit() {},
  chooseSigner() {},
  cancel() {},
  approve() {},
  recheck() {},
  acknowledge() {},
  checkAgain() {},
};

function render(action: ActionState<MigrationInput>, settlement: Settlement = { status: "open" }, venue = "cetus") {
  const state: MigrationFlowState = { action, settlement };
  return renderToStaticMarkup(<MigrationPanel state={state} venue={venue} signerKinds={["privy", "wallet"]} controls={controls} />);
}

function buttons(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]!);
}

test("a ready launch offers the public action to any wallet, independent of Blast's automation", () => {
  const html = render(actions.editing);
  assert.deepEqual(buttons(html), ["Complete migration"]);
  assert.match(html, /Migration venue.*Cetus/);
});

test("the review shows every fresh fact, including Bluefin's fee, before the single approval", () => {
  const review = actions.review;
  if (review.phase !== "review") return assert.fail();
  const html = render(
    {
      ...review,
      review: {
        ...review.review,
        facts: [
          { key: "network", label: "Network", value: "Sui localnet" },
          { key: "route", label: "Recorded route", value: "Bluefin Spot, tick spacing 60, fee rate 3000" },
          { key: "pool-creation-fee", label: "Bluefin pool-creation fee", value: "1.25 SUI (1250000000 MIST), paid by you to Bluefin" },
        ],
      },
    },
    { status: "open" },
    "bluefin",
  );
  assert.match(html, /Bluefin pool-creation fee/);
  assert.match(html, /1\.25 SUI \(1250000000 MIST\), paid by you to Bluefin/);
  assert.deepEqual(buttons(html), ["Approve and sign", "Cancel"]);
});

test("a changed review says what changed before it can be approved", () => {
  const review = actions.review;
  if (review.phase !== "review") return assert.fail();
  const html = render({
    ...review,
    changes: [{ key: "pool-creation-fee", label: "Bluefin pool-creation fee", before: "0 SUI", after: "2 SUI" }],
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /Bluefin pool-creation fee: 0 SUI → 2 SUI/);
  assert.deepEqual(buttons(html), ["Approve the updated review", "Cancel"]);
});

test("a failure with the launch still ready stays visible and retryable with guidance", () => {
  const html = render(actions.failed, { status: "still-ready", message: "Sui still shows this launch as migration ready, so it has not migrated." });
  assert.match(html, /The launch rejected this purchase/);
  assert.match(html, /Sui still shows this launch as migration ready/);
  assert.ok(buttons(html).includes("Review again"));
});

test("while the launch is re-read after a failure, nothing is claimed", () => {
  const html = render(actions.blocked, { status: "checking" });
  assert.match(html, /Reading the launch from Sui/);
  assert.doesNotMatch(html, /Migration complete|already migrated/);
  assert.deepEqual(buttons(html), [], "no new attempt while the read is in flight");
});

test("an unanswered check offers to read again, never a completion", () => {
  const html = render(actions.failed, { status: "unverified", message: "Blast could not read the launch from Sui." });
  assert.ok(buttons(html).includes("Check again"));
  assert.doesNotMatch(html, /Migration complete/);
});

test("another wallet's migration closes the action from Sui's evidence, with nothing to sign", () => {
  const html = render(actions.blocked, { status: "completed", by: "another", digest: null, explorerUrl: null });
  assert.match(html, /Already migrated/);
  assert.match(html, /Nothing was submitted from your wallet/);
  assert.deepEqual(buttons(html), []);
});

test("this wallet's migration is complete only with its Migrated transaction", () => {
  const html = render(actions.succeeded, { status: "completed", by: "you", digest: "DIGEST1", explorerUrl: "https://explorer.test/tx/DIGEST1" });
  assert.match(html, /Migration complete/);
  assert.match(html, /DIGEST1/);
  assert.match(html, /href="https:\/\/explorer.test\/tx\/DIGEST1"/);
  assert.deepEqual(buttons(html), []);
});

test("without a signing connection the action stays visible, disabled, with the reason and no alternative", () => {
  const html = renderToStaticMarkup(<MigrationUnavailable venue="bluefin" reason="This app is not connected to a released Blast deployment." />);
  assert.match(html, /<button[^>]*disabled[^>]*>Complete migration<\/button>/);
  assert.match(html, /not connected to a released Blast deployment/);
  assert.match(html, /Migration venue.*Bluefin/);
});

test("when this wallet's transaction lost the race, the completion says it failed and never that nothing was submitted", () => {
  const html = render(actions.failed, { status: "completed", by: "another", digest: null, explorerUrl: null });
  assert.match(html, /Already migrated/);
  assert.doesNotMatch(html, /Nothing was submitted from your wallet/);
  assert.match(html, /Your transaction failed\. Only the network fee was spent/);
  assert.doesNotMatch(html, /because the launch had already migrated/);
  assert.deepEqual(buttons(html), []);
});

test("an unresolved submission offers only a recheck, never a way back to another attempt", () => {
  const html = render(actions.ambiguous);
  assert.deepEqual(buttons(html), ["Check again"]);
  assert.match(html, /No other migration can start here until Sui settles it/);
});

test("a completed transaction without Migrated is final and may be left for a new attempt", () => {
  const ambiguous = actions.ambiguous;
  if (ambiguous.phase !== "ambiguous") return assert.fail();
  const html = render({ ...ambiguous, reason: "evidence-missing", message: "Transaction completed, but its expected Blast record was not found." });
  assert.deepEqual(buttons(html), ["Check again", "Back"]);
});

test("a submitted migration shows its confirmation after navigation without refreshing the old page", async (t) => {
  const fixture = createMigrationFixtureChain();
  const chain = { client: fixture.client, manifest: fixture.manifest, mode: "non-production" as const };
  const signer = fixtureWalletSigner();
  const signers: SignerSource = { kinds: ["wallet"], current: () => signer, connect: async () => signer };
  const confirmation = Promise.withResolvers<void>();
  const waitForTransaction = fixture.client.core.waitForTransaction.bind(fixture.client.core);
  t.mock.method(fixture.client.core, "waitForTransaction", async (...args: Parameters<typeof waitForTransaction>) => {
    await confirmation.promise;
    return waitForTransaction(...args);
  });
  const { document } = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ToastProvider } = await import("#web/components/blast-ui/Toasts.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    confirmation.resolve();
    await act(async () => root.unmount());
    container.remove();
  });
  let refreshes = 0;
  const render = (showMigration: boolean) => root.render(
    <ToastProvider>
      {showMigration && <LaunchpadSignerSourceProvider source={signers}>
        <CompleteMigration chain={chain} launchId={MIGRATION_LAUNCH_ID} venue="cetus" onCompleted={() => { refreshes += 1; }} />
      </LaunchpadSignerSourceProvider>}
    </ToastProvider>,
  );
  await act(async () => render(true));
  const click = async (label: string) => {
    const button = await waitFor(() => [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    ), label, 750);
    await act(async () => button.click());
  };
  await click("Complete migration");
  await click("Approve and sign");
  await waitFor(() => fixture.calls.execute === 1, "the submitted migration", 750);
  await act(async () => render(false));
  await act(async () => confirmation.resolve());
  const toast = await waitFor(() => container.querySelector("[data-sonner-toast]"), "the migration confirmation", 750);
  assert.match(toast.textContent!, /Migration complete/);
  assert.ok(toast.querySelector("a")?.href);
  assert.equal(refreshes, 0);
});
