/**
 * Load check for Home's live prices on the direct socket: each tab follows 20 coins' display prices, and in this
 * worst case every coin moves on every 1 s read, so every tab gets one `prices` frame a second.
 * Not part of the suite. Run: `bun test/live-prices.load.ts <sockets> [seconds] [batch]`.
 * The server runs in a child process, so its CPU and RSS are its own. Latency is from the read to the tab, same host.
 */
import { ingressTrust } from "@blast/core/lib/web-security/ingress.ts";
import { mintLiveTicket } from "@blast/core/modules/launchpad-contract/live-ticket.ts";
import { MARKET_STREAM_BUDGET } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { MarketStreamRelay } from "@blast/server/modules/launchpad-market/stream-relay.ts";
import type { RelaySocket } from "@blast/server/modules/launchpad-market/stream-relay.ts";
import { createLiveSocket, type LiveSocketData } from "../src/transport/live-socket.ts";

const SECRET = "s".repeat(48);
const ORIGIN = "https://blast.fun";
const FINGERPRINT = "a".repeat(64);
const PER_TAB = MARKET_STREAM_BUDGET.maxPriceCoinsPerClient;
// Every Home tab sees about the same first page: 40 coins across the tabs, 20 per tab.
const COINS = Array.from(
  { length: 40 },
  (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}::coin::COIN`,
);

if (process.argv[2] === "server") {
  let upstream: RelaySocket | undefined;
  let checkpoint = 10;
  const relay = new MarketStreamRelay(
    () => {
      upstream = { onmessage: null, onclose: null, onerror: null, send() {}, close() {} };
      return upstream;
    },
    { network: "mainnet", deployment: FINGERPRINT },
    async (coins) => {
      const now = Date.now();
      return {
        checkpoint: ++checkpoint,
        prices: coins.map((coin_type) => ({ coin_type, usd_price: `${now}`, as_of_ms: now })),
      };
    },
    Number(process.argv[3]),
  );
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
    // Every Redis step admits: the ticket burn and per-address caps are not what this measures.
    redis: { execute: async () => 1 },
  });
  const server = Bun.serve<LiveSocketData>({
    port: 0,
    hostname: "127.0.0.1",
    websocket: live.websocket,
    fetch(request, native) {
      if (new URL(request.url).pathname === "/v1/socket") {
        return live.upgrade(request, native, native.requestIP(request)?.address ?? null);
      }
      if (new URL(request.url).pathname === "/hello") {
        const receive = (frame: unknown) =>
          upstream?.onmessage?.({ data: JSON.stringify(frame) } as never);
        receive({
          type: "hello",
          protocol: 1,
          provenance: {
            network: "mainnet",
            deployment_fingerprint: FINGERPRINT,
            checkpoint: 1,
            timestamp_ms: 1_000,
            observed_ms: 1_000,
            lag_ms: 0,
          },
        });
        receive({ type: "pong" });
      }
      return Response.json({
        rss: process.memoryUsage().rss,
        cpu: process.cpuUsage(),
        ...live.stats(),
      });
    },
  });
  console.log(server.port);
} else {
  const sockets = Number(process.argv[2] ?? 1_000);
  const seconds = Number(process.argv[3] ?? 20);
  const batch = Number(process.argv[4] ?? 50);
  const child = Bun.spawn(["bun", import.meta.path, "server", String(sockets + 1)], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const port = Number(
    new TextDecoder().decode((await child.stdout.getReader().read()).value).trim(),
  );
  const stats = async (path = "/stats") =>
    (await fetch(`http://127.0.0.1:${port}${path}`)).json() as Promise<{
      rss: number;
      cpu: { user: number; system: number };
      sockets: number;
    }>;
  let frames = 0;
  let measuring = false;
  const lag: number[] = [];
  const open = (index: number) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ip = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
      const coins = Array.from({ length: PER_TAB }, (_, i) => COINS[(index + i) % COINS.length]!);
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/v1/socket?activity=true&${coins.map((coin) => `price_coin=${coin}`).join("&")}`,
        {
          headers: { Origin: ORIGIN, "X-Forwarded-For": ip },
          protocols: ["blast-live.v1", `blast-ticket.${mintLiveTicket(SECRET, ORIGIN).ticket}`],
        } as unknown as string[],
      );
      ws.onmessage = (event) => {
        if (!measuring) {
          return;
        }
        // The socket carries the stream's event framing: `event: prices` then `data: <json>`.
        const text = String(event.data);
        if (!text.startsWith("event: prices\n")) {
          return;
        }
        const frame = JSON.parse(text.slice(text.indexOf("data: ") + 6)) as {
          prices: { as_of_ms: number }[];
        };
        const first = frame.prices[0];
        if (!first) {
          return;
        }
        frames++;
        if (frames % 10 === 0) {
          lag.push(Date.now() - first.as_of_ms);
        }
      };
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error(`socket ${index} failed`));
    });
  const clients: WebSocket[] = [];
  // A failed open or a timeout must not leave the server process behind.
  process.on("exit", () => child.kill());
  process.on("SIGTERM", () => process.exit(143));
  for (let i = 0; i < sockets; i += batch) {
    clients.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(batch, sockets - i) }, (_, j) => open(i + j)),
      )),
    );
  }
  console.error(`opened ${clients.length} in ${Math.round(performance.now())} ms`);
  await stats("/hello");
  await Bun.sleep(3_000);
  const before = await stats();
  const started = performance.now();
  measuring = true;
  await Bun.sleep(seconds * 1_000);
  measuring = false;
  const after = await stats();
  const elapsed = (performance.now() - started) / 1_000;
  lag.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      sockets,
      open: after.sockets,
      frames_per_s: Math.round(frames / elapsed),
      frames_per_socket_per_s: Math.round((frames / elapsed / sockets) * 100) / 100,
      server_cpu_pct:
        Math.round(
          ((after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) /
            1e6 /
            elapsed) *
            1000,
        ) / 10,
      rss_mib: Math.round(after.rss / 2 ** 20),
      lag_ms: {
        p50: lag[Math.floor(lag.length / 2)],
        p95: lag[Math.floor(lag.length * 0.95)],
        max: lag.at(-1),
      },
    }),
  );
  for (const ws of clients) {
    ws.close();
  }
  child.kill();
}
