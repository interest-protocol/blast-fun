// A loopback TCP proxy that adds a fixed round-trip delay between the app and
// Postgres, so a local run can reproduce a remote database (for example Vercel
// iad1 -> Neon eu-west-2, about 75 ms per round trip). Each chunk is held for
// half the round trip in its direction; equal timeouts fire in order, so the
// byte stream is never reordered.
//
//   node latency-proxy.mjs --listen 5499 --target 127.0.0.1:5433 --rtt-ms 75
import net from "node:net";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    listen: { type: "string" },
    target: { type: "string" },
    "rtt-ms": { type: "string" },
  },
});
const listenPort = Number(values.listen);
const [targetHost, targetPortText] = String(values.target ?? "").split(":");
const targetPort = Number(targetPortText);
const oneWayMs = Number(values["rtt-ms"]) / 2;
if (
  !Number.isInteger(listenPort) || !Number.isInteger(targetPort) ||
  targetHost !== "127.0.0.1" || !(oneWayMs >= 0 && oneWayMs <= 1_000)
) {
  console.error("usage: latency-proxy.mjs --listen PORT --target 127.0.0.1:PORT --rtt-ms 0..2000");
  process.exit(2);
}

function pipeDelayed(from, to) {
  from.on("data", (chunk) => setTimeout(() => to.destroyed || to.write(chunk), oneWayMs));
  from.on("end", () => setTimeout(() => to.end(), oneWayMs));
}

let open = 0;
const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, targetHost);
  open += 1;
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  pipeDelayed(client, upstream);
  pipeDelayed(upstream, client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", () => {
    open -= 1;
    close();
  });
});
server.listen(listenPort, "127.0.0.1", () => {
  console.log(JSON.stringify({ at: new Date().toISOString(), listening: server.address().port, target: values.target, rttMs: oneWayMs * 2 }));
});
setInterval(() => console.log(JSON.stringify({ at: new Date().toISOString(), open })), 30_000).unref();
