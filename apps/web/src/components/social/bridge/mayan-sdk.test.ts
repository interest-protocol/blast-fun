import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, type TestContext } from "node:test";

import { addresses, type Quote } from "@mayanfinance/swap-sdk";
import { FetchRequest, Interface, toUtf8Bytes, toUtf8String } from "ethers";

import type { BridgeRequest } from "./bridge-guard.ts";
import { CHAINS, DESTINATIONS, type SourceToken } from "./bridge-model.ts";
import type { EvmWallet, QuoteInput } from "./bridge-sdk.ts";
import { mayanSdk } from "./mayan-sdk.ts";

// The real Mayan SDK against a price API and a chain RPC faked on this machine: no network, nothing signed.

/** Live Mayan answers captured 2026-11-28 with placeholder addresses: Fast MCTP, then MCTP. */
const live = (pair: string) => JSON.parse(readFileSync(new URL(`../../../../test/fixtures/social/bridge/all-routes-${pair}.json`, import.meta.url), "utf8")) as [Quote, Quote];
const BLINK = (JSON.parse(readFileSync(new URL("../../../../test/fixtures/social/bridge/blink-quotes.json", import.meta.url), "utf8")) as Record<"baseUsdcToSui", Quote>).baseUsdcToSui;
const [FAST, MCTP] = live("base-usdc-sui");

const BLAST = `0x${"ab".repeat(32)}`;
const SOURCE = `0x${"11".repeat(20)}`;
const REQUEST: BridgeRequest = { chain: "base", token: CHAINS.base.tokens[1], to: DESTINATIONS[0]!, amountIn64: "20000000", blastAddress: BLAST, sourceAddress: SOURCE };
const SIGNED_OUT: QuoteInput = { chain: "base", token: REQUEST.token, to: REQUEST.to, amountIn64: REQUEST.amountIn64 };

/** `deadline64` moved past the real clock, which the adapter reads. */
const fresh = (quote: Quote): Quote => ({ ...quote, deadline64: String(Math.floor(Date.now() / 1000) + 3600) });

async function fakeMayan(t: TestContext, quotes: readonly Quote[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ quotes, minimumSdkVersion: [1, 0, 0] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const real = addresses.PRICE_URL;
  addresses.PRICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => {
    addresses.PRICE_URL = real;
    server.close();
  });
  return bodies;
}

const HASH = `0x${"fe".repeat(32)}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

/** Every ethers request in this file: an allowance already set, and each transaction mined at once. */
let chainId = 8453;
const receipt = () => ({
  transactionHash: HASH, blockHash: HASH, blockNumber: "0x10", transactionIndex: "0x0", from: SOURCE, to: SOURCE, contractAddress: null,
  logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", type: "0x2",
});
function rpcResult(method: string): unknown {
  if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
  if (method === "eth_blockNumber") return "0x10";
  if (method === "eth_call") return word(5n);
  if (method === "eth_getTransactionReceipt") return receipt();
  throw new Error(`Unexpected RPC call ${method}`);
}
FetchRequest.registerGetUrl(async (request) => {
  const sent = JSON.parse(toUtf8String(request.body!)) as { id: number; method: string } | Array<{ id: number; method: string }>;
  const answer = ({ id, method }: { id: number; method: string }) => ({ jsonrpc: "2.0", id, result: rpcResult(method) });
  const body = toUtf8Bytes(JSON.stringify(Array.isArray(sent) ? sent.map(answer) : answer(sent)));
  return { statusCode: 200, statusMessage: "OK", headers: { "content-type": "application/json" }, body };
});
after(() => FetchRequest.registerGetUrl(FetchRequest.createGetUrlFunc()));

type Sent = { to: string; data: string; from: string };

/** A wallet that records what it is asked to sign. */
function recordingWallet(sent: Sent[]): EvmWallet {
  return {
    kind: "evm",
    address: SOURCE,
    chainId,
    switchChain: async () => undefined,
    provider: async () => ({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
        if (method === "eth_accounts") return [SOURCE];
        if (method === "eth_estimateGas") return "0x30000";
        if (method === "eth_sendTransaction") {
          sent.push((params as [Sent])[0]);
          return HASH;
        }
        throw new Error(`Unexpected wallet call ${method}`);
      },
    }),
  };
}

const flags = (body: Record<string, unknown>) => Object.fromEntries(["blink", "fastMctp", "mctp", "swift", "wormhole", "shuttle", "monoChain", "gasless", "fullList"].map((key) => [key, body[key]]));

test("one request asks the routes we check, and Fast MCTP wins over MCTP and Blink", async (t) => {
  const bodies = await fakeMayan(t, [BLINK, fresh(MCTP), fresh(FAST)]);
  assert.equal((await mayanSdk().quote(SIGNED_OUT)).type, "FAST_MCTP");
  assert.equal(bodies.length, 1);
  assert.deepEqual(flags(bodies[0]!), { blink: true, fastMctp: true, mctp: true, swift: false, wormhole: false, shuttle: false, monoChain: false, gasless: false, fullList: true });
  assert.equal("swapperAddress" in bodies[0]!, false);
  assert.equal("destinationAddress" in bodies[0]!, false);
});

for (const only of [FAST, MCTP]) {
  test(`a ${only.type} answer alone is built by the SDK for the Blast address and sent once`, async (t) => {
    await fakeMayan(t, [fresh(only)]);
    const sdk = mayanSdk();
    const quote = await sdk.quote({ ...SIGNED_OUT, swapper: SOURCE, destination: BLAST });
    assert.equal(quote.type, only.type);
    const sent: Sent[] = [];
    const signed: string[] = [];
    assert.equal(await sdk.send(quote, REQUEST, recordingWallet(sent), (hash) => signed.push(hash), new AbortController().signal), HASH);
    assert.deepEqual(signed, [HASH]);
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.data.includes(BLAST.slice(2)), "the Blast address is in the call");
  });
}

test("an old Ethereum USDT allowance is set to zero before the new one", async () => {
  chainId = 1;
  try {
    const usdt: SourceToken = { symbol: "USDT", decimals: 6, mayan: "0xdAC17F958D2ee523a2206206994597C13D831ec7", native: false, reserve: 0n, logo: null };
    const quote = { ...fresh(MCTP), fromChain: "ethereum", fromToken: { ...MCTP.fromToken, chainId: 1, wChainId: 2, contract: usdt.mayan, symbol: "USDT" } } as Quote;
    const sent: Sent[] = [];
    await mayanSdk().approve(quote, { ...REQUEST, chain: "ethereum", token: usdt }, recordingWallet(sent), new AbortController().signal);
    const erc20 = new Interface(["function approve(address spender, uint256 value)"]);
    const approvals = sent.map(({ to, data }) => [to.toLowerCase(), erc20.decodeFunctionData("approve", data)[1] as bigint]);
    assert.deepEqual(approvals, [[usdt.mayan.toLowerCase(), 0n], [usdt.mayan.toLowerCase(), 20_000_000n]]);
  } finally {
    chainId = 8453;
  }
});
