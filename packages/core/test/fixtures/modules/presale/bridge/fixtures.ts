// Circle Iris API fixtures for the presale bridge tests: response bodies in
// the shape Circle documents for `GET /v2/burn/USDC/fees/{src}/{dst}` and
// `GET /v2/fastBurn/USDC/allowance` (checked 2026-10-02), and a fixture
// `fetch` that serves them. Nothing here calls Circle: the bodies are written
// from the documented shape, not captured from the live API.

import { randomBytes } from "node:crypto";

import type { BridgeSource } from "../../../../../src/modules/presale/contracts/web-api.ts";
import { CCTP_SOURCE_DOMAINS, type BridgeActivationRecord, type BridgeActivationRecords, type BridgeTransfer, type BridgeTransferRegistration, type BridgeTransfers } from "../../../../../src/modules/presale/bridge/contracts.ts";

/** Fee lists to Sui (domain 8) by source: Fast (threshold 1000) and Standard (2000). */
export const CIRCLE_FEES_TO_SUI: Readonly<Record<BridgeSource, readonly unknown[]>> = {
  ethereum: [
    { finalityThreshold: 1000, minimumFee: 1 },
    { finalityThreshold: 2000, minimumFee: 0 },
  ],
  arbitrum: [
    { finalityThreshold: 1000, minimumFee: 1.3 },
    { finalityThreshold: 2000, minimumFee: 0 },
  ],
  base: [
    { finalityThreshold: 1000, minimumFee: 1.3 },
    { finalityThreshold: 2000, minimumFee: 0 },
  ],
  solana: [
    { finalityThreshold: 1000, minimumFee: 2 },
    { finalityThreshold: 2000, minimumFee: 0.5 },
  ],
};

/** A route with no Fast Transfer: Standard only. */
export const CIRCLE_FEES_STANDARD_ONLY: readonly unknown[] = [{ finalityThreshold: 2000, minimumFee: 0 }];

/** The global Fast Transfer allowance, in USDC (not atoms). */
export const CIRCLE_FAST_ALLOWANCE = { allowance: 2500000.5, lastUpdated: "2026-10-02T12:00:00.000Z" };

/** Circle's rate-limit answer: 40 requests per second, then every request is blocked for 5 minutes. */
export const CIRCLE_RATE_LIMITED = { status: 429, body: { error: "Too Many Requests" } };

const DOMAINS: Readonly<Record<string, BridgeSource>> = { "0": "ethereum", "3": "arbitrum", "5": "solana", "6": "base" };

/**
 * A fixture Iris API on Circle's mainnet host. It records every request,
 * serves `fees` and `allowance`, and can answer 429, a 500, or hang until
 * the request is aborted.
 */
export function fixtureCircle() {
  const state = {
    requests: [] as string[],
    fees: { ...CIRCLE_FEES_TO_SUI } as Record<BridgeSource, readonly unknown[]>,
    allowance: CIRCLE_FAST_ALLOWANCE as unknown,
    mode: "ok" as "ok" | "rate_limited" | "error" | "hang",
    /** Error bodies the client cancelled instead of leaving unread. */
    cancelledBodies: 0,
    /** Holds every answer until `release()`, to observe concurrent callers. */
    gate: null as Promise<void> | null,
  };
  let release: () => void = () => undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://iris-api.circle.com") throw new Error(`unexpected host ${url.origin}`);
    state.requests.push(url.pathname);
    if (state.gate) await state.gate;
    if (state.mode === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
      });
    }
    const errorBody = (text: string) => new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode(text)),
      cancel: () => {
        state.cancelledBodies += 1;
      },
    });
    if (state.mode === "rate_limited") return new Response(errorBody(JSON.stringify(CIRCLE_RATE_LIMITED.body)), { status: 429 });
    if (state.mode === "error") return new Response(errorBody("upstream error"), { status: 500 });
    if (url.pathname === "/v2/fastBurn/USDC/allowance") return Response.json(state.allowance);
    const fee = url.pathname.match(/^\/v2\/burn\/USDC\/fees\/(\d+)\/8$/);
    const source = fee ? DOMAINS[fee[1]!] : undefined;
    if (source) return Response.json(state.fees[source]);
    return Response.json({ error: "not found" }, { status: 404 });
  };
  return {
    state,
    fetch,
    hold() {
      state.gate = new Promise<void>((resolve) => {
        release = () => {
          state.gate = null;
          resolve();
        };
      });
    },
    release: () => release(),
  };
}

/** An in-memory activation record table with the Postgres store's ordering. */
export function memoryBridgeActivations(): BridgeActivationRecords & { readonly rows: BridgeActivationRecord[] } {
  const rows: BridgeActivationRecord[] = [];
  return {
    rows,
    async record(record) {
      const stored = Object.freeze({ ...record, id: String(rows.length + 1), recordedAt: new Date() });
      rows.push(stored);
      return stored;
    },
    latest: async () => rows.at(-1) ?? null,
    anyComplete: async () => rows.some((row) => row.complete),
    history: async (limit) => rows.slice(-limit).reverse(),
  };
}

/** An in-memory registry for the routes: registration and reads only (transitions are Postgres's). */
export function memoryBridgeTransfers(): Pick<BridgeTransfers, "register" | "find"> & {
  readonly rows: Map<string, BridgeTransfer>;
  put(transfer: BridgeTransfer): void;
  findByHash(source: BridgeTransfer["source"], txHash: string): Promise<BridgeTransfer | null>;
  openRegistrations(privyDid: string, limit: number): Promise<number>;
} {
  const rows = new Map<string, BridgeTransfer>();
  return {
    rows,
    put: (transfer) => void rows.set(transfer.id, transfer),
    async register(input: BridgeTransferRegistration) {
      const existing = [...rows.values()].find((row) => row.source === input.source && row.txHash === input.txHash);
      if (existing) return { id: existing.id, created: false };
      const id = `bt_${randomBytes(16).toString("hex")}`;
      const now = new Date();
      rows.set(id, {
        id, ...input, sourceDomain: CCTP_SOURCE_DOMAINS[input.source], status: "sent", sentAt: now,
        attestedAt: null, mintedAt: null, failedAt: null, error: null, nonce: null, message: null,
        attestation: null, suiDigest: null, nextPollAt: now, pollCount: 0, circleNotFoundAt: null, observedFrom: null,
      });
      return { id, created: true };
    },
    find: async (id) => rows.get(id) ?? null,
    findByHash: async (source, txHash) => [...rows.values()].find((row) => row.source === source && row.txHash === txHash) ?? null,
    openRegistrations: async (privyDid, limit) =>
      Math.min(limit, [...rows.values()].filter((row) => row.privyDid === privyDid && row.status === "sent").length),
  };
}
