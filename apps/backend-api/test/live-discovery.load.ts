/**
 * Local fleet rehearsal using a committed blast-infra reader, PostgreSQL and
 * Valkey. See live-discovery-load.sql and the runbook in live-data-delivery.md.
 */
import assert from "node:assert/strict";
import { SQL } from "bun";
import { WebSocket as UpstreamSocket } from "undici";
import { ingressTrust } from "@blast/core/lib/web-security/ingress.ts";
import { createRedisConnection } from "@blast/core/lib/redis.ts";
import { mintLiveTicket } from "@blast/core/modules/launchpad-contract/live-ticket.ts";
import type { DiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import {
  MarketStreamRelay,
  type RelaySocket,
} from "@blast/server/modules/launchpad-market/stream-relay.ts";
import { createLiveSocket, type LiveSocketData } from "../src/transport/live-socket.ts";

const origin = "http://127.0.0.1:55414";
const reader = "http://127.0.0.1:55412";
const postgres = "postgres://live_load:disposable-fixture@127.0.0.1:55410/live_discover_run";
const redisUrl = "redis://127.0.0.1:55411";
const secret = "disposable-test-gateway-key".repeat(2);
const readerKey = "local-fixture-only-live-socket-api-key";
const fingerprint = "a".repeat(64);
const ticketPath = "/api/launchpad/market/ticket";
const gatewayCount = 12;
const id = (index: number) => `0x${index.toString(16).padStart(64, "0")}`;
const pool = (index: number) => `blast_curve:${id(index)}`;

async function gateway() {
  const redis = createRedisConnection(redisUrl, "private-replay");
  await redis.execute(["PING"]);
  const relay = new MarketStreamRelay(
    () => {
      const url = reader.replace("http:", "ws:") + "/v1/ws";
      return new UpstreamSocket(url, {
        headers: { "x-blast-infra-key": readerKey },
      }) as unknown as RelaySocket;
    },
    { network: "mainnet", deployment: fingerprint },
  );
  const live = createLiveSocket({
    host: "127.0.0.1",
    siteOrigin: origin,
    gatewaySecret: secret,
    namespace: "local-fleet",
    redis,
    relay,
    ingress: ingressTrust({
      BLAST_BACKEND_INGRESS_MODE: "trusted-proxy",
      BLAST_BACKEND_TRUSTED_PROXY_CIDRS: "127.0.0.0/24",
    }),
  });
  const server = Bun.serve<LiveSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    websocket: live.websocket,
    fetch(request, native) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/socket") {
        return live.upgrade(request, native, native.requestIP(request)?.address ?? null);
      }
      if (path === "/stats") {
        return Response.json({
          ...live.stats(),
          rss: process.memoryUsage().rss,
          cpu: process.cpuUsage(),
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  console.log(server.port);
}

type Tab = {
  index: number;
  discover: boolean;
  pool: number | null;
  gateway: number;
  last: number;
  cursor?: string;
  discovery: Map<string, number>;
  socket?: WebSocket;
  retry?: ReturnType<typeof setTimeout>;
  joined: boolean;
  active: boolean;
  fault?: number;
  seq: number;
};

type TradeFrame = { pool_key: string; cursor: string };
type DiscoveryFrame = { view: string; checkpoint: number; ordered: boolean };

const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;

function sample(samples: number[], value: number, total: number) {
  if (samples.length < 100_000) {
    samples.push(value);
    return;
  }
  const index = Math.floor(Math.random() * total);
  if (index < samples.length) {
    samples[index] = value;
  }
}

function discoveryPageIsOrdered(page: DiscoveryResponse) {
  const data = page.section.state === "available" ? page.section.data : null;
  const rows = data?.rows ?? [];
  if (rows.length > 10 || new Set(rows.map((row) => row.launchId)).size !== rows.length) {
    return false;
  }
  if (page.view === "new") {
    return (
      rows.length === 10 &&
      Boolean(data?.nextCursor) &&
      rows.every((row, index) => row.launchId === id(16 - index))
    );
  }
  return (
    page.view === "near_graduation" &&
    rows.length === 10 &&
    rows.every(
      (row, index) =>
        row.launchId !== id(17) &&
        (row.progressBps ?? -1) >= 6_000 &&
        (!index || (rows[index - 1]!.progressBps ?? -1) >= row.progressBps!),
    )
  );
}

async function fleet() {
  const count = Number(process.argv[2] ?? 10_000);
  const seconds = Number(process.argv[3] ?? 3_600);
  const hotPools = Number(process.argv[4] ?? 3);
  assert.ok(Number.isInteger(count) && count > 0 && count <= 10_000);
  assert.ok(Number.isInteger(seconds) && seconds >= 45 && seconds <= 3_600);
  assert.ok(hotPools === 1 || hotPools === 3);
  const db = new SQL(postgres, { max: 1 });
  const children: (ReturnType<typeof Bun.spawn> | undefined)[] = [];
  const ports: (number | undefined)[] = [];
  const tabs: Tab[] = [];
  const commits = new Map<number, number>();
  const discoveryFrames = new Map<string, DiscoveryFrame>();
  const latency: number[] = [];
  const discoveryLatency: number[] = [];
  let firstCheckpoint = 0;
  let checkpoint = 0;
  let startMs = 0;
  let tickets = 0;
  let tradeCount = 0;
  let discoveryCount = 0;
  let staleFallbacks = 0;
  let missing = 0;
  let duplicates = 0;
  let wrongDiscover = 0;
  let lastFaultReadyMs = 0;
  let maxGatewayRss = 0;
  let maxGatewayCores = 0;
  const lastCpu = new Map<number, { at: number; cpu: number }>();

  async function startGateway(index: number) {
    const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "gateway"], {
      env: { PATH: process.env.PATH!, MISSION_CONTROL_METRICS: "off" },
      stdout: "pipe",
      stderr: "inherit",
    });
    children[index] = child;
    const output = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const port = Number(new TextDecoder().decode((await output.read()).value).trim());
    assert.ok(port > 0);
    output.releaseLock();
    ports[index] = port;
  }

  const ticketServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 55414,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== ticketPath) {
        return new Response(null, { status: 404 });
      }
      const port = ports[Number(url.searchParams.get("gateway"))];
      if (!port) {
        return new Response(null, { status: 503 });
      }
      tickets++;
      const { ticket, expiresAtMs } = mintLiveTicket(secret, origin);
      return Response.json({
        ticket,
        expires_at_ms: expiresAtMs,
        url: `ws://127.0.0.1:${port}/v1/socket`,
      });
    },
  });

  const ready = (tab: Tab) => tab.joined && (!tab.discover || tab.discovery.size === 2);
  const readyCount = () => tabs.filter(ready).length;
  const reconnectTimes: number[] = [];

  function recordReady(tab: Tab) {
    if (tab.fault === undefined || !ready(tab)) {
      return;
    }
    const after = Date.now() - tab.fault;
    reconnectTimes.push(after);
    lastFaultReadyMs = Math.max(lastFaultReadyMs, after);
    tab.fault = undefined;
  }

  function setDiscovery(tab: Tab, enabled: boolean) {
    tab.socket?.send(
      JSON.stringify({
        op: "set",
        seq: ++tab.seq,
        pools: [],
        price_coins: [],
        presale: null,
        discovery: enabled,
      }),
    );
  }

  function receiveTrade(tab: Tab, trade: TradeFrame) {
    if (tab.pool === null || trade.pool_key !== pool(tab.pool)) {
      missing++;
      return;
    }
    const cp = Number(trade.cursor.split(":", 1)[0]);
    if (cp <= tab.last) {
      duplicates++;
      return;
    }
    if (tab.last && cp !== tab.last + 1) {
      missing += cp - tab.last - 1;
    }
    tab.cursor = trade.cursor;
    tab.last = cp;
    const committed = commits.get(cp);
    if (committed && cp >= firstCheckpoint) {
      sample(latency, Math.max(0, Date.now() - committed), ++tradeCount);
    }
  }

  function discoveryFrame(body: string): DiscoveryFrame {
    const cached = discoveryFrames.get(body);
    if (cached) {
      return cached;
    }
    const { page, provenance } = JSON.parse(body) as {
      page: DiscoveryResponse;
      provenance: { checkpoint: number };
    };
    const frame = {
      view: page.view,
      checkpoint: provenance.checkpoint,
      ordered: discoveryPageIsOrdered(page),
    };
    // Each gateway sends the same committed display bytes to hundreds of tabs.
    // Validate those bytes once while keeping ordering and latency per tab.
    if (discoveryFrames.size === 32) {
      discoveryFrames.delete(discoveryFrames.keys().next().value!);
    }
    discoveryFrames.set(body, frame);
    return frame;
  }

  function receiveDiscovery(tab: Tab, body: string) {
    const { view, checkpoint, ordered } = discoveryFrame(body);
    if (!ordered || checkpoint < (tab.discovery.get(view) ?? -1)) {
      wrongDiscover++;
    }
    tab.discovery.set(view, checkpoint);
    const committed = commits.get(checkpoint);
    if (committed && checkpoint >= firstCheckpoint) {
      sample(discoveryLatency, Math.max(0, Date.now() - committed), ++discoveryCount);
    }
  }

  function acceptFence(tab: Tab, frame: Record<string, unknown>) {
    if (tab.joined || (tab.pool === null ? frame.type !== "hello" : frame.state !== "live")) {
      return;
    }
    if (tab.cursor && frame.resumed !== true && frame.tape_resumed !== true) {
      staleFallbacks++;
    }
    tab.joined = true;
    if (tab.discover && frame.discovery === true) {
      setDiscovery(tab, true);
    }
  }

  function receive(tab: Tab, raw: string) {
    const type = raw.match(/^event: (.+)$/m)?.[1];
    if (
      type !== "market" &&
      type !== "tape" &&
      type !== "discovery" &&
      (tab.joined || (type !== "status" && type !== "hint"))
    ) {
      return;
    }
    const body = raw.match(/^data: (.+)$/m)?.[1];
    if (!body) {
      return;
    }
    if (type === "discovery") {
      receiveDiscovery(tab, body);
    } else if (type === "tape") {
      const frame = JSON.parse(body);
      for (const trade of frame.trades.reverse()) {
        receiveTrade(tab, trade);
      }
    } else if (type === "market") {
      const frame = JSON.parse(body);
      if (frame.type === "trade") {
        receiveTrade(tab, frame.trade);
      }
    } else {
      acceptFence(tab, JSON.parse(body));
    }
    recordReady(tab);
  }

  async function connect(tab: Tab) {
    if (!tab.active) {
      return;
    }
    try {
      if (!ports[tab.gateway]) {
        tab.gateway = (tab.gateway + 1 + (tab.index % (gatewayCount - 1))) % gatewayCount;
      }
      const ticket = await fetch(`${origin}${ticketPath}?gateway=${tab.gateway}`, {
        method: "POST",
      });
      if (!ticket.ok) {
        throw new Error("ticket refused");
      }
      const grant = (await ticket.json()) as { url: string; ticket: string };
      if (!tab.active) {
        return;
      }
      const url = new URL(grant.url);
      url.searchParams.set("activity", "true");
      if (tab.pool !== null) {
        url.searchParams.set("pool", pool(tab.pool));
        if (tab.cursor) {
          url.searchParams.set("resume", `${pool(tab.pool)}~${tab.cursor}`);
        }
      }
      const ip = `10.71.${tab.index >> 8}.${tab.index & 255}`;
      const ws = new WebSocket(url, {
        headers: { Origin: origin, "X-Forwarded-For": ip },
        protocols: ["blast-live.v1", `blast-ticket.${grant.ticket}`],
      } as unknown as string[]);
      tab.socket = ws;
      tab.seq = 0;
      ws.onmessage = ({ data }) => {
        if (tab.socket === ws) {
          receive(tab, String(data));
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (tab.socket !== ws) {
          return;
        }
        tab.joined = false;
        tab.discovery.clear();
        tab.socket = undefined;
        if (tab.active) {
          tab.retry = setTimeout(() => void connect(tab), 500 + Math.random() * 1_500);
        }
      };
    } catch {
      if (tab.active) {
        tab.retry = setTimeout(() => void connect(tab), 500 + Math.random() * 1_500);
      }
    }
  }

  // This single transaction models the writer's committed projection and outbox
  // publication. The reader serves its normal queries and polls its real tables.
  async function commit() {
    const cp = ++checkpoint;
    const at = Date.now();
    commits.set(cp, at);
    await db
      .unsafe(
        `BEGIN;
      SET LOCAL search_path = blast_infra;
      UPDATE pools SET quote_reserve=5998+(created_tx_slot+${cp})%7 WHERE created_tx_slot<17;
      INSERT INTO trades (checkpoint,tx_slot,event_slot,part,timestamp_ms,tx_digest,pool_key,coin_type,trader,
         side,kind,meme_amount,quote_amount,meme_fee,quote_fee,currency_supply,pending_burn_total,balance_0x0,
         whale,meme_reserve,quote_reserve,quote_gross,meme_gross,protocol_quote_fee_delta,creator_quote_fee_delta,
         protocol_meme_fee_delta,creator_meme_fee_delta)
      SELECT ${cp},created_tx_slot,0,0,${at},repeat('1',32),pool_key,coin_type,'${id(1)}',
         'buy','buy',1,10,0,0,1000000,0,0,false,10000,quote_reserve,10,1,0,0,0,0
      FROM pools WHERE created_tx_slot<17;
      INSERT INTO committed_events(pipeline,seq,revision,checkpoint,tx_slot,event_slot,part,timestamp_ms,kind,topics,data)
      SELECT 'market',(${cp}-2)*16+created_tx_slot,${cp},${cp},created_tx_slot,0,0,${at},'trade',
         ARRAY['pool:'||pool_key],jsonb_build_object('trade',jsonb_build_object(
            'pool_key',pool_key,'venue','blast_curve','cursor',concat_ws(':',${cp},created_tx_slot,0,0),
            'checkpoint',${cp},'timestamp_ms',${at},'digest',repeat('1',32),'trader','${id(1)}',
            'side','buy','kind','buy','quote_amount','10','meme_amount','1','price','10','volume_usd',NULL,'venue_swap',NULL))
      FROM pools WHERE created_tx_slot<17;
      UPDATE committed_event_streams SET last_seq=(${cp}-1)*16 WHERE pipeline='market';
      UPDATE watermarks SET checkpoint_hi_inclusive=${cp}, timestamp_ms_hi_inclusive=${at} WHERE pipeline='market';
      UPDATE committed_read_progress SET revision=${cp},applied_checkpoint=${cp},applied_timestamp_ms=${at} WHERE pipeline='market';
      UPDATE financial_price_coverage SET checkpoint=${cp},timestamp_ms=${at};
      SELECT pg_notify('blast_committed','market');
      COMMIT;`,
      )
      .simple();
    if (commits.size > 1_000) {
      commits.delete(cp - 1_000);
    }
  }

  const waitReady = async (target: number, limitMs: number) => {
    const until = Date.now() + limitMs;
    while (readyCount() < target && Date.now() < until) {
      await Bun.sleep(100);
    }
    assert.ok(readyCount() >= target, `${readyCount()}/${target} tabs ready`);
  };
  let abort = false;
  const interrupt = () => {
    abort = true;
  };

  async function connectTabs() {
    for (let index = 0; index < count; index++) {
      const discover = index < count * 0.6;
      const key = discover ? null : index < count * 0.9 ? 1 + (index % hotPools) : 4 + (index % 13);
      const tab: Tab = {
        index,
        discover,
        pool: key,
        gateway: index % gatewayCount,
        last: 0,
        discovery: new Map(),
        active: true,
        joined: false,
        seq: 0,
      };
      tabs.push(tab);
      void connect(tab);
      if (index % 36 === 35) {
        await Bun.sleep(18);
      }
    }
    await waitReady(count, 45_000);
  }

  async function stopGateway() {
    const child = children[0]!;
    ports[0] = undefined;
    children[0] = undefined;
    for (const tab of tabs.filter((tab) => tab.gateway === 0)) {
      tab.fault = Date.now();
    }
    child.kill("SIGKILL");
    await child.exited;
  }

  function toggleDiscover() {
    for (const tab of tabs.filter((tab) => tab.discover && tab.index % 10 === 0)) {
      setDiscovery(tab, false);
      setTimeout(() => setDiscovery(tab, true), 2_500);
    }
  }

  function reconnectAll() {
    for (const tab of tabs) {
      tab.fault = Date.now();
      tab.socket?.close();
    }
  }

  async function reportProgress(elapsed: number) {
    await Promise.all(
      ports.map(async (port, index) => {
        if (!port) {
          return;
        }
        const { rss, cpu } = (await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as {
          rss: number;
          cpu: { user: number; system: number };
        };
        maxGatewayRss = Math.max(maxGatewayRss, rss);
        const at = Date.now();
        const prior = lastCpu.get(index);
        if (prior) {
          const used = (cpu.user + cpu.system - prior.cpu) / ((at - prior.at) * 1_000);
          maxGatewayCores = Math.max(maxGatewayCores, used);
        }
        lastCpu.set(index, { at, cpu: cpu.user + cpu.system });
      }),
    );
    console.log(
      JSON.stringify({
        elapsed_s: Math.round(elapsed),
        ready: readyCount(),
        checkpoint,
        tradeCount,
        discoveryCount,
        staleFallbacks,
        duplicates,
        missing,
        wrongDiscover,
        tradeP95Ms: percentile(latency, 0.95),
        discoveryP95Ms: percentile(discoveryLatency, 0.95),
      }),
    );
  }

  async function runSchedule() {
    const phases = [
      { after: 0.25, run: stopGateway },
      { after: 0.42, run: toggleDiscover },
      { after: 0.6, run: reconnectAll },
    ];
    let nextProgress = 0;
    while (!abort && Date.now() < startMs + seconds * 1_000) {
      const elapsed = (Date.now() - startMs) / 1_000;
      if (phases[0] && elapsed > seconds * phases[0].after) {
        await phases.shift()!.run();
      }
      await commit();
      if (elapsed >= nextProgress) {
        nextProgress = elapsed + 30;
        await reportProgress(elapsed);
      }
      const burst = elapsed > seconds * 0.77 && elapsed < seconds * 0.85;
      await Bun.sleep(burst ? 225 : 1_800);
    }
  }

  async function readerCalls() {
    const [stats] = await db.unsafe(
      "SELECT coalesce(sum(calls),0)::bigint AS calls FROM pg_stat_statements WHERE userid=(SELECT oid FROM pg_roles WHERE rolname='live_load_reader')",
    );
    return Number(stats.calls);
  }

  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const [watermark] = await db.unsafe(
      "SELECT applied_checkpoint FROM blast_infra.committed_read_progress WHERE pipeline='market'",
    );
    checkpoint = Number(watermark.applied_checkpoint);
    await commit();
    await Promise.all(Array.from({ length: gatewayCount }, (_, index) => startGateway(index)));
    await connectTabs();
    startMs = Date.now();
    firstCheckpoint = checkpoint + 1;
    console.log(
      JSON.stringify({ ready: count, seconds, gateways: gatewayCount, hotPools, checkpoint }),
    );
    const baseline = await readerCalls();
    await runSchedule();
    assert.ok(!abort, "interrupted");
    await waitReady(count, 45_000);
    const until = Date.now() + 10_000;
    const caughtUp = (tab: Tab) =>
      tab.pool === null
        ? (tab.discovery.get("near_graduation") ?? 0) >= checkpoint
        : tab.last >= checkpoint;
    while (tabs.some((tab) => !caughtUp(tab)) && Date.now() < until) {
      await Bun.sleep(100);
    }
    const stalledDiscover = tabs.filter((tab) => tab.discover && !caughtUp(tab)).length;
    for (const tab of tabs) {
      if (tab.pool !== null && tab.last < checkpoint) {
        missing += checkpoint - tab.last;
      }
    }
    const databaseCalls = (await readerCalls()) - baseline;
    const result = {
      ready: readyCount(),
      seconds,
      tradeCount,
      discoveryCount,
      duplicates,
      missing,
      wrongDiscover,
      stalledDiscover,
      staleFallbacks,
      tickets,
      trade_receive_p95_ms: percentile(latency, 0.95),
      discovery_receive_p95_ms: percentile(discoveryLatency, 0.95),
      recovery_p95_ms: percentile(reconnectTimes, 0.95) ?? 0,
      recovery_max_ms: lastFaultReadyMs,
      recovered_tabs: reconnectTimes.length,
      max_gateway_rss_mib: Math.round(maxGatewayRss / 2 ** 20),
      max_gateway_cpu_cores: maxGatewayCores,
      reader_statement_calls: databaseCalls,
      reader_statements_per_second: databaseCalls / seconds,
    };
    console.log(JSON.stringify(result));
    assert.ok(tradeCount && discoveryCount);
    assert.equal(readyCount(), count);
    assert.equal(duplicates + missing + wrongDiscover + stalledDiscover, 0);
    assert.equal(staleFallbacks, 0);
    assert.ok(
      (result.trade_receive_p95_ms ?? Infinity) <= 1_000 &&
        (result.discovery_receive_p95_ms ?? Infinity) <= 1_000,
    );
    assert.ok(reconnectTimes.length >= count && lastFaultReadyMs <= 45_000);
  } finally {
    for (const tab of tabs) {
      tab.active = false;
      clearTimeout(tab.retry);
      tab.socket?.close();
    }
    ticketServer.stop(true);
    for (const child of children) {
      child?.kill();
    }
    await Promise.all(children.map((child) => child?.exited));
    await db.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

if (process.argv[2] === "gateway") {
  await gateway();
} else {
  await fleet();
}
