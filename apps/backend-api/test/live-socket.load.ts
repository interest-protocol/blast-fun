/**
 * Load check for the direct live socket: memory per socket and fan-out time.
 * Not part of the suite. Run: `bun test/live-socket.load.ts <sockets> [frames]`.
 * The server runs in a child process so its RSS is not mixed with the clients'.
 * Each client sends its own X-Forwarded-For so per-address limits do not apply.
 */
import { ingressTrust } from "@blast/core/lib/web-security/ingress.ts";
import { mintLiveTicket } from "@blast/core/modules/launchpad-contract/live-ticket.ts";
import { MarketStreamRelay } from "@blast/server/modules/launchpad-market/stream-relay.ts";
import type { RelaySocket } from "@blast/server/modules/social/activity/hint-relay.ts";
import { createLiveSocket, type LiveSocketData } from "../src/transport/live-socket.ts";

const SECRET = "s".repeat(48);
const ORIGIN = "https://blast.fun";
const FINGERPRINT = "a".repeat(64);
const POOLS = Array.from(
  { length: 32 },
  (_, i) => `blast_curve:0x${(i + 1).toString(16).padStart(64, "0")}`,
);
const provenance = (checkpoint: number) => ({
  network: "mainnet",
  deployment_fingerprint: FINGERPRINT,
  checkpoint,
  timestamp_ms: checkpoint * 1_000,
  observed_ms: checkpoint * 1_000,
  lag_ms: 0,
});
const envelope = (checkpoint: number) => ({
  checkpoint,
  timestamp_ms: checkpoint * 1_000,
  cursor: `${checkpoint}:0:0:0`,
  provenance: provenance(checkpoint),
});

if (process.argv[2] === "server") {
  let upstream!: RelaySocket;
  const relay = new MarketStreamRelay(
    () => {
      upstream = { onmessage: null, onclose: null, onerror: null, send() {}, close() {} };
      return upstream;
    },
    { network: "mainnet", deployment: FINGERPRINT },
  );
  const receive = (frame: unknown) =>
    upstream.onmessage?.({ data: JSON.stringify(frame) } as never);
  const live = createLiveSocket({
    host: "127.0.0.1",
    siteOrigin: ORIGIN,
    gatewaySecret: SECRET,
    namespace: "load",
    ingress: ingressTrust({
      BLAST_BACKEND_INGRESS_MODE: "trusted-proxy",
      BLAST_BACKEND_TRUSTED_PROXY_CIDRS: "127.0.0.0/24",
    }),
    relay,
    redis: { execute: async () => "OK" },
  });
  let checkpoint = 10;
  const server = Bun.serve<LiveSocketData>({
    port: 0,
    hostname: "127.0.0.1",
    websocket: live.websocket,
    fetch(request, native) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/socket") {
        return live.upgrade(request, native, native.requestIP(request)?.address ?? null);
      }
      if (path === "/hello") {
        receive({ type: "hello", protocol: 1, provenance: provenance(1) });
        receive({ type: "pong" });
        for (const pool of POOLS) {
          receive({ type: "snapshot", topic: `pool:${pool}`, ...envelope(checkpoint) });
        }
      }
      if (path === "/emit") {
        for (const pool of POOLS) {
          receive({ type: "lifecycle", pool_key: pool, ...envelope(++checkpoint) });
        }
      }
      Bun.gc(true);
      return Response.json({
        rss: process.memoryUsage().rss,
        heap: process.memoryUsage().heapUsed,
        ...live.stats(),
      });
    },
  });
  console.log(server.port);
} else {
  const sockets = Number(process.argv[2] ?? 500);
  const frames = Number(process.argv[3] ?? 20);
  const child = Bun.spawn(["bun", import.meta.path, "server"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
  const stats = async (path: string) =>
    (await fetch(`http://127.0.0.1:${port}${path}`)).json() as Promise<{
      rss: number;
      heap: number;
      sockets: number;
    }>;
  const before = await stats("/stats");
  let received = 0;
  const open = (index: number) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ip = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
      const pools = [POOLS[index % POOLS.length]!, POOLS[(index + 1) % POOLS.length]!];
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/v1/socket?activity=true&${pools.map((pool) => `pool=${pool}`).join("&")}`,
        {
          headers: { Origin: ORIGIN, "X-Forwarded-For": ip },
          protocols: ["blast-live.v1", `blast-ticket.${mintLiveTicket(SECRET, ORIGIN).ticket}`],
        } as unknown as string[],
      );
      ws.onmessage = () => {
        received++;
      };
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error(`socket ${index} failed`));
    });
  const clients: WebSocket[] = [];
  for (let i = 0; i < sockets; i += 50) {
    clients.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(50, sockets - i) }, (_, j) => open(i + j)),
      )),
    );
  }
  await Bun.sleep(500);
  await stats("/hello");
  await Bun.sleep(500);
  const opened = await stats("/stats");
  const perFrame = sockets * 2;
  const times: number[] = [];
  for (let f = 0; f < frames; f++) {
    const target = received + perFrame;
    const start = performance.now();
    await fetch(`http://127.0.0.1:${port}/emit`);
    while (received < target) {
      await Bun.sleep(1);
    }
    times.push(performance.now() - start);
  }
  const after = await stats("/stats");
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      sockets,
      open: opened.sockets,
      rss_per_socket_kib: Math.round(((after.rss - before.rss) / sockets / 1024) * 10) / 10,
      heap_per_socket_kib: Math.round(((after.heap - before.heap) / sockets / 1024) * 10) / 10,
      rss_mib: Math.round(after.rss / 2 ** 20),
      fanout_ms: {
        p50: Math.round(times[Math.floor(times.length / 2)]!),
        p95: Math.round(times[Math.floor(times.length * 0.95)]!),
      },
    }),
  );
  for (const ws of clients) {
    ws.close();
  }
  child.kill();
}
