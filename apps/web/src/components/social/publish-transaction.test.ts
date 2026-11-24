import assert from "node:assert/strict";
import test from "node:test";
import { TransactionError, type ClientWithCoreApi } from "@mysten/sui/client";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";

import { findTransaction, sendPublishTransaction } from "./publish-transaction.ts";

const BYTES = new Uint8Array([1, 2, 3, 4]);
const DIGEST = TransactionDataBuilder.getDigestFromBytes(BYTES);
const RESERVATION = "5b0c2a52-8d4b-4c3e-9a51-0b1f4f0b8d11";
const DETAILS = { effects: true, objectTypes: true };
const CONFIRMED = { $kind: "Transaction", Transaction: { digest: DIGEST } };

function fixture(sponsorAnswer: () => Response) {
  const calls: string[] = [];
  const client = {
    core: {
      async waitForTransaction(request: unknown) {
        calls.push(`wait ${JSON.stringify(request)}`);
        return CONFIRMED;
      },
    },
  } as unknown as ClientWithCoreApi;
  const fetch: typeof globalThis.fetch = async (url) => {
    calls.push(`fetch ${String(url)}`);
    return sponsorAnswer();
  };
  const options = {
    cancelled: "Cancelled in the wallet.",
    unconfirmed: "Not confirmed.",
    keep: () => calls.push("keep"),
    drop: () => calls.push("drop"),
  };
  const send = () => ({
    api: { getAccessToken: async () => "token", fetch },
    client,
    async sign(bytes: Uint8Array) {
      calls.push("sign");
      return { bytes: toBase64(bytes), signature: "signature" };
    },
  });

  return { calls, options, send };
}

test("an expired sponsor reservation drops the saved step and stops", async () => {
  const flow = fixture(() => Response.json({ error: { code: "reservation_expired" } }, { status: 410 }));

  await assert.rejects(
    sendPublishTransaction(flow.send(), { bytes: toBase64(BYTES), digest: DIGEST, reservationId: RESERVATION }, flow.options),
    { message: "Not confirmed. Code: reservation_expired." },
  );
  assert.deepEqual(flow.calls, ["sign", "keep", `fetch /api/presale/sponsor/${RESERVATION}/execute`, "drop"]);
});

test("a sponsor that executed another digest stops before waiting for it", async () => {
  const flow = fixture(() => Response.json({ digest: "another-digest", effects: { status: "success" } }));

  await assert.rejects(
    sendPublishTransaction(flow.send(), { bytes: toBase64(BYTES), digest: DIGEST, reservationId: RESERVATION }, flow.options),
    { message: "The sponsor returned a different transaction digest. Keep this draft and contact support. Code: request_failed." },
  );
  assert.deepEqual(flow.calls, ["sign", "keep", `fetch /api/presale/sponsor/${RESERVATION}/execute`]);
});

test("progress saved without a sponsor reservation stops before the wallet signs", async () => {
  const flow = fixture(() => Response.json({}));

  await assert.rejects(
    sendPublishTransaction(flow.send(), { bytes: toBase64(BYTES), digest: DIGEST }, flow.options),
    { message: "Saved progress uses wallet gas. Keep this draft and contact support. Code: request_failed." },
  );
  assert.deepEqual(flow.calls, []);
});

test("a publish cancelled while the wallet signs is neither kept nor sent", async () => {
  const flow = fixture(() => Response.json({}));
  const cancel = new AbortController();
  const send = flow.send();

  await assert.rejects(
    sendPublishTransaction(
      {
        ...send,
        api: { ...send.api, signal: cancel.signal },
        async sign(bytes: Uint8Array) {
          cancel.abort();
          return send.sign(bytes);
        },
      },
      { bytes: toBase64(BYTES), digest: DIGEST, reservationId: RESERVATION },
      flow.options,
    ),
    { name: "AbortError" },
  );
  assert.deepEqual(flow.calls, ["sign"]);
});

test("a sponsored step waits for the digest it saved, with its effects and object types", async () => {
  const flow = fixture(() => Response.json({ digest: DIGEST, effects: { status: "success" } }));

  const result = await sendPublishTransaction(flow.send(), { bytes: toBase64(BYTES), digest: DIGEST, reservationId: RESERVATION }, flow.options);

  assert.deepEqual(result, CONFIRMED);
  assert.deepEqual(flow.calls, [
    "sign",
    "keep",
    `fetch /api/presale/sponsor/${RESERVATION}/execute`,
    `wait {"digest":"${DIGEST}","include":{"effects":true,"objectTypes":true}}`,
  ]);
});

test("a transaction Sui has not seen is absent, and any other read failure stops", async () => {
  const unseen = {
    core: {
      async getTransaction({ digest, include }: { digest: string; include: unknown }) {
        assert.deepEqual(include, DETAILS);
        throw new TransactionError("notFound", digest);
      },
    },
  } as unknown as ClientWithCoreApi;
  const unavailable = {
    core: {
      async getTransaction() {
        throw new Error("fullnode unavailable");
      },
    },
  } as unknown as ClientWithCoreApi;

  assert.equal(await findTransaction(unseen, DIGEST), null);
  await assert.rejects(findTransaction(unavailable, DIGEST), { message: "fullnode unavailable" });
});
