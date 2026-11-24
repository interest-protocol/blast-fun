import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { MultiSigPublicKey } from "@mysten/sui/multisig";
import {
  getZkLoginSignature,
  toZkLoginPublicIdentifier,
} from "@mysten/sui/zklogin";
import { createSuiPersonalMessageVerifier } from "./service.ts";

test("ordinary wallet proofs bind the exact signer address without calling the node", async () => {
  const signer = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(19));
  const message = new TextEncoder().encode("synthetic wallet proof");
  const { signature } = await signer.signPersonalMessage(message);
  const verify = createSuiPersonalMessageVerifier({
    baseUrl: "http://127.0.0.1:1",
    fetch: async () => assert.fail("ordinary wallet proofs verify offline"),
  });
  assert.equal(await verify(message, signature, signer.toSuiAddress()), true);
  assert.equal(await verify(message, signature, `0x${"1".repeat(64)}`), false);
});

test(
  "plain and multisig zkLogin verification settle when the local RPC body stalls",
  { timeout: 5_000 },
  async () => {
    let calls = 0;
    let closed = 0;
    let contentType: string | undefined;
    const server = createServer((request, response) => {
      calls++;
      contentType = request.headers["content-type"];
      response.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      response.write(Buffer.from([0, 0, 0, 0, 5, 1]));
      request.once("close", () => {
        closed++;
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const issuer = "https://synthetic-issuer.test";
      const signature = getZkLoginSignature({
        inputs: {
          proofPoints: {
            a: ["1", "2", "3"],
            b: [
              ["1", "2"],
              ["3", "4"],
              ["5", "6"],
            ],
            c: ["1", "2", "3"],
          },
          issBase64Details: {
            value: Buffer.from(`"iss":"${issuer}",`).toString("base64url"),
            indexMod4: 0,
          },
          headerBase64: "synthetic",
          addressSeed: "1",
        },
        maxEpoch: 1,
        userSignature: new Uint8Array(97),
      });
      const publicKey = toZkLoginPublicIdentifier(1n, issuer, {
        legacyAddress: false,
      });
      const multisig = MultiSigPublicKey.fromPublicKeys({
        threshold: 1,
        publicKeys: [{ publicKey, weight: 1 }],
      });
      const port = (server.address() as { port: number }).port;
      const verify = createSuiPersonalMessageVerifier({
        baseUrl: `http://127.0.0.1:${port}`,
        // Leave time for a cold connection before the response body stalls.
        timeoutMs: 1_000,
      });
      const message = new TextEncoder().encode("synthetic message");
      const proofs = [
        [signature, publicKey.toSuiAddress()],
        [
          multisig.combinePartialSignatures([signature]),
          multisig.toSuiAddress(),
        ],
      ] as const;
      for (const [index, [proof, address]] of proofs.entries()) {
        await assert.rejects(verify(message, proof, address), {
          message: /aborted due to timeout|timed out/,
        });
        const expectedCalls = index + 1;
        assert.equal(
          calls,
          expectedCalls,
          "Each proof reaches the SDK's RPC path",
        );
        assert.equal(contentType, "application/grpc-web-text");
        for (
          let attempt = 0;
          closed < expectedCalls && attempt < 100;
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(
          closed,
          expectedCalls,
          "Each timeout closes its response socket",
        );
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
