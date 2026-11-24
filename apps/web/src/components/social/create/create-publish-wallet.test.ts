import assert from "node:assert/strict";
import test from "node:test";
import { toBase64 } from "@mysten/sui/utils";

import { loadPublishSigner } from "./create-publish-wallet.ts";
import type { PrivyCoinSigner } from "../coins/signers.tsx";

const ADDRESS = `0x${"a".repeat(64)}`;
const api = {
  getAccessToken: async () => "test-token",
  fetch: async () =>
    Response.json({
      address: ADDRESS,
      signer: "privy",
      fee: "sponsored",
      coins: [],
      as_of_ms: 0,
    }),
};

test("the embedded publishing signer signs the exact bytes with the canonical wallet", async () => {
  const transaction = new Uint8Array([1, 2, 3]);
  const privy: PrivyCoinSigner = {
    address: () => ADDRESS,
    createWallet: async () => {},
    signer: () => ({
      fee: "sponsored",
      address: ADDRESS,
      async signTransaction(bytes) {
        assert.deepEqual(bytes, transaction);
        return "signature";
      },
    }),
  };
  const signer = await loadPublishSigner(api, ADDRESS, privy);
  assert.equal(signer.address, ADDRESS);
  assert.equal(signer.fee, "sponsored");
  assert.deepEqual(await signer.sign(transaction), {
    bytes: toBase64(transaction),
    signature: "signature",
  });
  await assert.rejects(loadPublishSigner(api, `0x${"b".repeat(64)}`, privy), /verified/);
  await assert.rejects(loadPublishSigner(api, ADDRESS, null), /isn’t ready/);
  await assert.rejects(
    loadPublishSigner(api, ADDRESS, {
      ...privy,
      signer: () => ({
        fee: "sponsored",
        address: `0x${"b".repeat(64)}`,
        signTransaction: async () => "wrong-wallet-signature",
      }),
    }),
    /isn’t ready/,
  );
});
