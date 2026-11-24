import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { COIN_FIXTURE } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";

import { ThesesHarness } from "./ThesesHarness.tsx";
import { THESES_FIXTURE_WALLETS } from "./theses-fixtures.ts";

test("the test harness uses its requested launch and offers fixture Privy and wallet signers", () => {
  for (const launchId of [
    COIN_FIXTURE.launchId,
    `0x${"b1".padStart(64, "0")}`,
  ]) {
    const html = renderToStaticMarkup(<ThesesHarness launchId={launchId} />);
    assert.match(html, new RegExp(`Launch <code>${launchId}</code>`));
    assert.match(html, /Post with Privy/);
    assert.match(html, /Post with wallet/);
    assert.ok(
      html.includes(THESES_FIXTURE_WALLETS.creator) &&
        html.includes(THESES_FIXTURE_WALLETS.other),
    );
  }
});
