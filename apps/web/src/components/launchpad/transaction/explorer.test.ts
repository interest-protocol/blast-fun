import assert from "node:assert/strict";
import test from "node:test";

import { explorerTransactionUrl } from "./explorer.ts";

const DIGEST = "BMwg3HvPTPQaKr9Lnk5jjNkw1bseCftzVgdaGksass4W";

function deployment(baseUrl: string, environment: "production" | "non-production" = "production") {
  return { environment, explorer: { baseUrl } } as const;
}

test("a completed digest links under the configured explorer base", () => {
  assert.equal(
    explorerTransactionUrl(deployment("https://suiscan.xyz/mainnet"), DIGEST),
    `https://suiscan.xyz/mainnet/tx/${DIGEST}`,
  );
});

test("a local non-production explorer may use http on a loopback host", () => {
  assert.equal(
    explorerTransactionUrl(deployment("http://127.0.0.1:9001", "non-production"), DIGEST),
    `http://127.0.0.1:9001/tx/${DIGEST}`,
  );
  assert.equal(explorerTransactionUrl(deployment("http://127.0.0.1:9001"), DIGEST), null, "never in production");
  assert.equal(explorerTransactionUrl(deployment("http://explorer.example", "non-production"), DIGEST), null);
});

test("no link is produced from an invalid base or digest", () => {
  for (const base of [
    "javascript:alert(1)",
    "https://user:secret@suiscan.xyz/mainnet",
    "https://suiscan.xyz/mainnet?ref=x",
    "https://suiscan.xyz/mainnet#tx",
    "not a url",
  ]) {
    assert.equal(explorerTransactionUrl(deployment(base), DIGEST), null, base);
  }
  for (const digest of ["", "0xabc", "../../evil", `${DIGEST}/../x`]) {
    assert.equal(explorerTransactionUrl(deployment("https://suiscan.xyz/mainnet"), digest), null, digest);
  }
});
