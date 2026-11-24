// Optional preload for load tests (NODE_OPTIONS=--import): every 10 s, logs one
// JSON metric line with the process's event-loop delay and CPU use, so server
// stalls can be told apart from a CPU-starved load generator. k6 times include
// its own scheduling delay; these are measured inside the app process.
import { monitorEventLoopDelay } from "node:perf_hooks";

const INTERVAL_MS = 10_000;
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
let cpu = process.cpuUsage();
const toMs = (ns) => Math.round(ns / 1e6);

setInterval(() => {
  const used = process.cpuUsage(cpu);
  cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  process.stdout.write(`${JSON.stringify({
    metric: "loadtest.event_loop",
    at: new Date().toISOString(),
    pid: process.pid,
    p50Ms: toMs(delay.percentile(50)),
    p99Ms: toMs(delay.percentile(99)),
    maxMs: toMs(delay.max),
    cpuPercent: Math.round(((used.user + used.system) / 1_000 / INTERVAL_MS) * 100),
    rssMb: Math.round(memory.rss / 1_048_576),
    heapUsedMb: Math.round(memory.heapUsed / 1_048_576),
  })}\n`);
  delay.reset();
}, INTERVAL_MS).unref();
