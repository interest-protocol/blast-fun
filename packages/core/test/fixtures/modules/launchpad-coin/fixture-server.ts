// A disposable stand-in for blast-infra `/v1` and the Sui node's launch
// objects, for development and tests only. It serves the coin fixtures
// (`fixtures.ts`) of one launch at a switchable lifecycle, with switchable
// degradation: a lagging, starting or unreachable engine, an unavailable
// venue pool, and a launch object that disagrees with the index or is gone.
// It also serves the coin's native holder snapshot (complete, incomplete,
// behind or a genuine zero), each pool's own candles (`chart-fixtures.ts`),
// the launch's classified activity and the venue pool's trades
// (`activity-fixtures.ts`), and the launch's fees (core's `rewards-fixtures.ts`).
// Only the app's server reads it, as only the
// server reads blast-infra: browsers read the app's `/api/launchpad/market`
// routes, which relay these answers, so it sends no CORS headers. Started
// with `apiKey` (the script passes `BLAST_INFRA_API_KEY`), every `/v1`
// request must carry it in `x-blast-infra-key` or is refused 401, as
// blast-infra refuses one.
// As the node it also answers its chain identifier (`/__fixture/chain`) and
// the verified-outcome fixture transactions (`/__fixture/transactions/{digest}`,
// `modules/launchpad-telemetry/outcome-fixtures.ts`); `POST
// /__fixture/transactions` lands another (the launch harness's creation,
// forwarded by the dev server).
// `GET /__fixture/state` shows the state and `POST /__fixture/state` merges a
// JSON patch into it.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { NON_PRODUCTION_MANIFEST, FOREIGN_CHAIN_IDENTIFIER } from "./manifest-fixtures.ts";
import { BLAST_INFRA_KEY_HEADER } from "../../../../src/modules/read-routing/blast-infra.ts";
import { LAUNCH_LIFECYCLES, type LaunchLifecycle } from "../../../../src/modules/launchpad-contract/discovery.ts";
import { CANDLE_INTERVALS, type CandleInterval } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { candleFixtureBody } from "./chart-fixtures.ts";
import {
  outcomeFixtureTransactions,
  outcomeTransactionFromWire,
  outcomeTransactionWire,
} from "../launchpad-telemetry/outcome-fixtures.ts";
import {
  COIN_FIXTURE,
  CURVE_POOL_KEY,
  coinBody,
  curvePoolBody,
  curvePoolSummary,
  errorBody,
  launchObjectFixture,
  launchObjectWire,
  venuePoolBody,
  wireProvenance,
  withoutFlow,
} from "./fixtures.ts";
import { classifiedActivityBody, venueTradesBody } from "./activity-fixtures.ts";
import { launchRewardsBody } from "./rewards-fixtures.ts";
import { HOLDER_FIXTURE_STATES, holderSnapshotBody, type HolderFixtureState } from "./holder-fixtures.ts";

export type CoinFixtureState = {
  /** The lifecycle blast-infra has indexed. */
  indexed: LaunchLifecycle;
  /** The launch object's lifecycle on the node, or `absent` (no object) or `down` (node unreachable). */
  fresh: LaunchLifecycle | "absent" | "down";
  /** blast-infra: answering, lagging (45 s behind), starting (`503 not_ready`) or unreachable. */
  infra: "ok" | "lagging" | "starting" | "down";
  /**
   * The venue pool after migration: answering, `503 not_ready`, or
   * `untracked` (the migration opened no pool blast-infra tracks).
   */
  venue: "ok" | "down" | "untracked";
  /** The chain the node answers for: the fixture deployment's, or another (mainnet's). */
  chain: "deployment" | "other";
  /** The coin's native holder snapshot. */
  holders: HolderFixtureState;
};

export const INITIAL_FIXTURE_STATE: Readonly<CoinFixtureState> = {
  indexed: "live",
  fresh: "live",
  infra: "ok",
  venue: "ok",
  chain: "deployment",
  holders: "complete",
};

/** An ID the node holds as an object of another package: not a launch of this deployment. */
export const FOREIGN_OBJECT_ID = `0x${"0f".repeat(32)}`;

const PATCH_VALUES: Readonly<Record<keyof CoinFixtureState, readonly string[]>> = {
  indexed: LAUNCH_LIFECYCLES,
  fresh: [...LAUNCH_LIFECYCLES, "absent", "down"],
  infra: ["ok", "lagging", "starting", "down"],
  venue: ["ok", "down", "untracked"],
  chain: ["deployment", "other"],
  holders: HOLDER_FIXTURE_STATES,
};

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function applyPatch(state: CoinFixtureState, patch: unknown): string | null {
  if (typeof patch !== "object" || patch === null) return "the patch must be an object";
  for (const [key, value] of Object.entries(patch)) {
    const allowed = PATCH_VALUES[key as keyof CoinFixtureState];
    if (!allowed || !allowed.includes(value as string)) return `${key} must be one of ${allowed?.join(", ") ?? "nothing"}`;
  }
  Object.assign(state, patch);
  return null;
}

export type CoinFixtureServer = Readonly<{
  origin: string;
  state: CoinFixtureState;
  close(): Promise<void>;
}>;

export async function startCoinFixtureServer(
  options: Readonly<{
    host?: string;
    port?: number;
    now?: () => number;
    apiKey?: string;
    /** The network blast-infra's provenance names, for a server that checks it (an API on mainnet); default the fixtures' localnet. */
    network?: string;
  }> = {},
): Promise<CoinFixtureServer> {
  const state: CoinFixtureState = { ...INITIAL_FIXTURE_STATE };
  const now = options.now ?? Date.now;
  const transactions = outcomeFixtureTransactions();

  async function fixtureState(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "POST") {
      let patch: unknown;
      try {
        patch = await readJson(request);
      } catch {
        return send(response, 400, { error: "the body must be JSON" });
      }
      const refused = applyPatch(state, patch);
      if (refused) return send(response, 400, { error: refused });
    }
    return send(response, 200, state);
  }

  function fixtureObject(path: string, response: ServerResponse) {
    const id = path.slice("/__fixture/objects/".length);
    if (id === FOREIGN_OBJECT_ID) {
      const impostor = { ...launchObjectFixture("live", { launchpadPackage: `0x${"f0".repeat(32)}` }), objectId: FOREIGN_OBJECT_ID };
      return send(response, 200, launchObjectWire(impostor));
    }
    if (state.fresh === "down") return send(response, 503, { error: "node unavailable" });
    if (id !== COIN_FIXTURE.launchId || state.fresh === "absent") return send(response, 404, { error: "not found" });
    return send(response, 200, launchObjectWire(launchObjectFixture(state.fresh)));
  }

  function fixtureNode(path: string, response: ServerResponse) {
    if (path === "/__fixture/chain" || path.startsWith("/__fixture/transactions/")) {
      // The node: `fresh: "down"` makes it unreachable for every read.
      if (state.fresh === "down") return send(response, 503, { error: "node unavailable" });
      if (path === "/__fixture/chain") {
        const chainIdentifier = state.chain === "deployment" ? NON_PRODUCTION_MANIFEST.chainIdentifier : FOREIGN_CHAIN_IDENTIFIER;
        return send(response, 200, { chainIdentifier });
      }
      const transaction = transactions.get(path.slice("/__fixture/transactions/".length));
      return transaction ? send(response, 200, outcomeTransactionWire(transaction)) : send(response, 404, { error: "not found" });
    }

    return fixtureObject(path, response);

  }

  function onNetwork(body: unknown): unknown {
    const { network } = options;
    if (network === undefined || typeof body !== "object" || body === null || !("provenance" in body)) return body;
    return { ...body, provenance: { ...(body.provenance as Record<string, unknown>), network } };
  }

  function serveInfra(request: IncomingMessage, response: ServerResponse, url: URL, path: string) {
    const reply = (status: number, body: unknown) => send(response, status, onNetwork(body));
    if (options.apiKey !== undefined && request.headers[BLAST_INFRA_KEY_HEADER] !== options.apiKey) {
      return reply(401, errorBody("unauthorized", "a valid API key is required"));
    }
    if (state.infra === "down") {
      request.socket.destroy();
      return;
    }
    if (state.infra === "starting") return reply(503, errorBody("not_ready", "the engine has not bootstrapped"));
    const lag = state.infra === "lagging" ? 45_000 : undefined;
    const at = now();
    const migrated = state.indexed === "migrated";

    const untracked = migrated && state.venue === "untracked";
    const pageLimit = (fallback: number, max: number) => {
      const limit = Number(url.searchParams.get("limit") ?? fallback);
      return Number.isInteger(limit) && limit >= 1 && limit <= max ? limit : null;
    };
    function curveResponse() {
      const body = curvePoolBody(state.indexed, at, lag) as { pool: { migration: Record<string, unknown> | null } };
      if (untracked && body.pool.migration) body.pool.migration = { ...body.pool.migration, pool_key: null };
      return reply(200, body);
    }

    function coinResponse() {
      const body = coinBody(state.indexed, at, lag);
      if (!untracked) return reply(200, body);
      const curve = curvePoolSummary("migrated");
      return reply(200, {
        ...body,
        migration: { ...(body.migration as Record<string, unknown>), pool_key: null },
        current_pool: CURVE_POOL_KEY,
        pools: [CURVE_POOL_KEY],
        windows: withoutFlow(curve.windows),
        market_cap: curve.market_cap,
        holders: curve.holders,
        inputs: curve.inputs,
      });
    }

    function venueResponse() {
      if (state.venue === "down") return reply(503, errorBody("not_ready", "history is temporarily unavailable"));
      return reply(200, venuePoolBody(at, lag));
    }

    function candlesResponse(candlePool: "curve" | "venue") {
      if (candlePool === "venue" && state.venue === "down") return reply(503, errorBody("not_ready", "candle history is unavailable"));
      const interval = url.searchParams.get("interval") as CandleInterval;
      if (!CANDLE_INTERVALS.includes(interval)) return reply(400, errorBody("invalid_parameter", "interval is unknown"));
      const bound = (name: string) => (url.searchParams.has(name) ? Number(url.searchParams.get(name)) : undefined);
      const request = { interval, from: bound("from"), to: bound("to"), limit: bound("limit") };
      return reply(200, candleFixtureBody(candlePool, state.indexed, request, at, { lagMs: lag, venuePoolKey: untracked ? null : undefined }));
    }

    function activityResponse() {
      const limit = pageLimit(25, 100);
      if (limit === null) return reply(400, errorBody("invalid_parameter", "limit must be 1 to 100"));
      try {
        return reply(200, classifiedActivityBody(state.indexed, { cursor: url.searchParams.get("cursor"), limit, walletLabels: url.searchParams.get("wallet_labels") === "true" }, at, lag));
      } catch {
        return reply(400, errorBody("invalid_parameter", "cursor is not a page token of this list"));
      }
    }

    function tradesResponse() {
      if (state.venue === "down") return reply(503, errorBody("not_ready", "history is temporarily unavailable"));
      const before = url.searchParams.get("before");
      if (before !== null && !/^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/.test(before)) return reply(400, errorBody("invalid_parameter", "before must be a cursor"));
      return reply(200, venueTradesBody({ before, limit: Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200) }, at, lag));
    }

    function holdersResponse() {
      const limit = pageLimit(25, 100);
      if (limit === null) return reply(400, errorBody("invalid_parameter", "limit must be 1 to 100"));
      try {
        return reply(200, holderSnapshotBody(state.holders, { cursor: url.searchParams.get("cursor"), limit }, at, lag));
      } catch {
        return reply(400, errorBody("invalid_parameter", "cursor is not a page token of this list"));
      }
    }

    function migratedVenueResponse(read: () => void) {
      if (!migrated || untracked) return reply(404, errorBody("not_found", "no such pool or coin"));
      return read();
    }

    switch (path) {
      case "/v1/status":
        return reply(200, {
          provenance: wireProvenance(at, lag),
          checkpoint: 326_274_009,
          timestamp_ms: at - (lag ?? 412),
          lag_ms: lag ?? 412,
          cursor: "326274009:3:4294967295:0",
          engine_id: "coin-fixture",
        });
      case `/v1/pools/blast_curve/${COIN_FIXTURE.launchId}`: return curveResponse();
      case `/v1/coins/${COIN_FIXTURE.coinType}`: return coinResponse();
      case `/v1/pools/bluefin/${COIN_FIXTURE.venuePoolId}`:
        return migratedVenueResponse(venueResponse);
      case `/v1/pools/blast_curve/${COIN_FIXTURE.launchId}/candles`: return candlesResponse("curve");
      case `/v1/pools/bluefin/${COIN_FIXTURE.venuePoolId}/candles`:
        return migratedVenueResponse(() => candlesResponse("venue"));
      case `/v1/launches/${COIN_FIXTURE.launchId}/activity`:
        if (url.searchParams.get("view") === "classified") return activityResponse();
        break;
      case `/v1/launches/${COIN_FIXTURE.launchId}/rewards`:
        return reply(200, launchRewardsBody(state.indexed, at, lag));
      case `/v1/pools/bluefin/${COIN_FIXTURE.venuePoolId}/trades`:
        return migratedVenueResponse(tradesResponse);
      case `/v1/coins/${COIN_FIXTURE.coinType}/holders`:
        if (url.searchParams.get("view") === "snapshot") return holdersResponse();
        break;
    }
    return reply(404, errorBody("not_found", "no such pool or coin"));
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    const path = decodeURIComponent(url.pathname);

    if (path === "/__fixture/state") return fixtureState(request, response);

    if (path === "/__fixture/transactions" && request.method === "POST") {
      // The dev server lands a dev page's transaction (`fixture-landing.ts`).
      try {
        const transaction = outcomeTransactionFromWire((await readJson(request)) as Record<string, unknown>);
        transactions.set(transaction.digest, transaction);
      } catch {
        return send(response, 400, { error: "the body must be a fixture transaction" });
      }
      response.writeHead(204, { "Cache-Control": "no-store" });
      return response.end();
    }

    if (path === "/__fixture/chain" || path.startsWith("/__fixture/transactions/") || path.startsWith("/__fixture/objects/")) return fixtureNode(path, response);

    if (!path.startsWith("/v1/")) return send(response, 404, errorBody("not_found", "unknown route"));
    return serveInfra(request, response, url, path);
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve));
  const { address, port } = server.address() as AddressInfo;
  return {
    origin: `http://${address}:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
