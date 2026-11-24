import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { fixtureWalletSigner } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { LaunchpadSignerProvider } from "./LaunchpadSignerProvider";
import { createLazySignerSource } from "./launchpad-signer-provider-model";

test("public readers render without mounting any signer bridge", () => {
  let bridgeRenders = 0;
  const html = renderToStaticMarkup(
    <LaunchpadSignerProvider
      kinds={["privy", "wallet"]}
      renderBridge={() => {
        bridgeRenders += 1;
        return <p>wallet bridge</p>;
      }}
    >
      <p>coin page</p>
    </LaunchpadSignerProvider>,
  );
  assert.equal(html, "<p>coin page</p>");
  assert.equal(bridgeRenders, 0);
});

test("the first connection activates the bridge once and waits for it to register", async () => {
  let activations = 0;
  const { source, register } = createLazySignerSource({ kinds: ["wallet"], activate: () => (activations += 1) });
  assert.equal(source.current(), null);
  assert.equal(activations, 0, "creating the source initializes nothing");
  const signer = fixtureWalletSigner();
  const connecting = source.connect("wallet");
  const again = source.connect("wallet");
  assert.equal(activations, 1);
  register({ current: () => signer, connect: async () => signer });
  assert.equal(await connecting, signer);
  assert.equal(await again, signer);
  assert.equal(source.current(), signer);
});

test("a bridge that never loads fails the connection instead of hanging", async () => {
  const { source } = createLazySignerSource({ kinds: ["privy"], activate: () => {}, timeoutMs: 10 });
  await assert.rejects(source.connect("privy"), /could not start/);
});
