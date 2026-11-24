// Test fixtures for withdrawals out of Sui (CCTP V2, Circle's Forwarding
// Service): synthetic CCTP wire vectors, Circle's Sui package IDs, and a fake Iris client.
// Tests only: nothing here is read by the app, and nothing calls a network.

import { readFileSync } from "node:fs";

import { fromBase64, toBase58 } from "@mysten/sui/utils";

import { SUI_CCTP_V2_MAINNET, SUI_CCTP_V2_MAINNET_MESSAGE_TRANSMITTER } from "../../../../../src/modules/presale/bridge/sui-burn.ts";

const readVector = (name: string): unknown => JSON.parse(readFileSync(new URL(`./withdraw-recordings/${name}`, import.meta.url), "utf8"));

/** `GET /v2/burn/USDC/fees/8/{domain}?forward=true` shaped per destination (Solana with its account setup). */
export const FIXTURE_FORWARD_FEES = Object.freeze({
  ethereum: readVector("fees-8-0-forward.json"),
  arbitrum: readVector("fees-8-3-forward.json"),
  solana: readVector("fees-8-5-forward-setup.json"),
  base: readVector("fees-8-6-forward.json"),
});

/** The same routes without `forward=true`: no `forwardFee`, so Circle would not forward. */
export const FIXTURE_PLAIN_FEES = Object.freeze({
  ethereum: readVector("fees-8-0.json"),
  arbitrum: readVector("fees-8-3.json"),
  solana: readVector("fees-8-5.json"),
  base: readVector("fees-8-6.json"),
});

/** A Sui V2 burn with the Forwarding hook (to Arc): `forwardState: COMPLETE`, its `forwardTxHash`, `feeExecuted == maxFee`. */
export const FIXTURE_FORWARDED_MESSAGE = readVector("messages-forward-arc.json");
/** A plain Sui V2 burn to Base: attested, never forwarded. */
export const FIXTURE_PLAIN_MESSAGE = readVector("messages-base-noforward.json");

export const FORWARDED_BURN_DIGEST = toBase58(new Uint8Array(32).fill(17));
export const PLAIN_BURN_DIGEST = toBase58(new Uint8Array(32).fill(23));

type BurnVector = Readonly<{
  sender: string;
  commands: readonly Readonly<Record<string, unknown>>[];
  inputs: readonly Readonly<Record<string, unknown>>[];
  events: readonly Readonly<{ eventType: string; bcs: string; json: Readonly<Record<string, unknown>> }>[];
}>;

/** Two synthetic Sui transaction vectors, keyed by synthetic digests. */
export const SUI_BURN_VECTORS = readVector("sui-burn-vectors.json") as Readonly<Record<string, BurnVector>>;

/** Events in the same type and BCS form as the fullnode lookup. */
export function fixtureBurnEvents(digest: string): { eventType: string; bcs: Uint8Array }[] {
  const burn = SUI_BURN_VECTORS[digest];
  if (!burn) throw new Error(`no burn vector ${digest}`);
  return burn.events.map((event) => ({ eventType: event.eventType, bcs: fromBase64(event.bcs) }));
}

/** The identity's `cctp` block for Circle's CCTP V2 on Sui mainnet, with the stablecoin handler (as `PRESALE_DEPLOYMENT_MANIFEST` carries it). */
export const SUI_CCTP_V2_IDENTITY = Object.freeze({
  messageTransmitter: SUI_CCTP_V2_MAINNET_MESSAGE_TRANSMITTER,
  tokenMessengerMinter: SUI_CCTP_V2_MAINNET.tokenMessengerMinter,
  mtState: SUI_CCTP_V2_MAINNET.mtState,
  tmmState: SUI_CCTP_V2_MAINNET.tmmState,
  usdcTreasury: SUI_CCTP_V2_MAINNET.usdcTreasury,
  usdcType: SUI_CCTP_V2_MAINNET.usdcType,
  denyList: SUI_CCTP_V2_MAINNET.denyList,
  stablecoinHandler: SUI_CCTP_V2_MAINNET.stablecoinHandler,
  handlerState: SUI_CCTP_V2_MAINNET.handlerState,
});

/**
 * A fixture Iris over `fetch` for withdrawals: each fee route answers its
 * vector (or `fees[domain]` when a test sets one), each message route the
 * test's `messages[digest]` (404 when absent). `status` forces an answer for
 * every request (429 to rate-limit). Every requested path is logged.
 */
export function fixtureWithdrawIris(options: {
  fees?: Partial<Record<string, unknown>>;
  messages?: Record<string, unknown>;
} = {}) {
  const requests: string[] = [];
  const state = { status: null as number | null, fees: { ...options.fees }, messages: { ...options.messages } };
  const byDomain: Record<string, unknown> = {
    "0": FIXTURE_FORWARD_FEES.ethereum,
    "3": FIXTURE_FORWARD_FEES.arbitrum,
    "5": FIXTURE_FORWARD_FEES.solana,
    "6": FIXTURE_FORWARD_FEES.base,
  };
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (state.status !== null) return json(state.status, { error: "forced" });
    const fee = /^\/v2\/burn\/USDC\/fees\/8\/([0-9]+)$/.exec(url.pathname);
    if (fee) {
      const domain = fee[1]!;
      const body = Object.hasOwn(state.fees, domain) ? state.fees[domain] : byDomain[domain];
      return body === undefined ? json(404, { error: "not found" }) : json(200, body);
    }
    if (url.pathname === "/v2/messages/8") {
      const digest = url.searchParams.get("transactionHash") ?? "";
      return Object.hasOwn(state.messages, digest) ? json(200, state.messages[digest]) : json(404, { error: "not found" });
    }
    return json(404, { error: "not found" });
  }) as typeof globalThis.fetch;
  return { fetch, requests, state };
}

/** The `cctp` block without some of its keys (an identity before the V2 handler, or half of the pair). */
export function cctpWithout(...keys: readonly (keyof typeof SUI_CCTP_V2_IDENTITY)[]): Record<string, unknown> {
  const omitted = new Set<string>(keys);
  return Object.fromEntries(Object.entries(SUI_CCTP_V2_IDENTITY).filter(([key]) => !omitted.has(key)));
}
