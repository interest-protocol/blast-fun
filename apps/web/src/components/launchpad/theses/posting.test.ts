import assert from "node:assert/strict";
import test from "node:test";

import { thesesPosting } from "./posting.ts";

const FINGERPRINT = "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c";
const MAINNET = { network: "mainnet", deployment: FINGERPRINT } as const;

test("posting signs for the deployment this app serves, with Privy only when it is configured", () => {
  assert.deepEqual(thesesPosting({ expectedDeployment: MAINNET, privyAppId: "privy-app" }, "nonce-1"), {
    network: "mainnet", privyAppId: "privy-app", nonce: "nonce-1",
  });
  assert.deepEqual(thesesPosting({ expectedDeployment: MAINNET, privyAppId: null }, "n"), {
    network: "mainnet", privyAppId: null, nonce: "n",
  });
});

// An incomplete or unknown BLAST_NETWORK/BLAST_DEPLOYMENT_FINGERPRINT pair now
// fails at parse (web-config.test.ts), so the page never sees a broken one.
test("without a named deployment the page says posting is unavailable and offers no signer", () => {
  assert.deepEqual(thesesPosting({ expectedDeployment: null, privyAppId: "privy-app" }, "n"), {
    unavailable: "Posting is unavailable here: this app does not name its Blast deployment.",
  });
});
