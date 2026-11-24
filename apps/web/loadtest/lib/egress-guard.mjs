// Preloaded into the app (NODE_OPTIONS=--import) during load tests.
// Every outbound TCP/TLS connection must target loopback: Postgres and the
// vendor mock. Anything else is logged to LOADTEST_EGRESS_LOG and, in the
// default "block" mode, fails before a packet leaves the host, so a missed
// vendor override can never reach X, Privy or any other real service.
import fs from "node:fs";
import net from "node:net";

const logPath = process.env.LOADTEST_EGRESS_LOG;
const block = process.env.LOADTEST_EGRESS_MODE !== "log";
// Exact hostnames that may be reached besides loopback (the Neon branch endpoint in Neon mode).
const allowed = new Set((process.env.LOADTEST_EGRESS_ALLOW ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));

function write(entry) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
  } catch {
    // Logging must never change app behaviour.
  }
}

function isLoopback(host) {
  const value = String(host).replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value === "::1" || /^127\./.test(value) || /^::ffff:127\./.test(value);
}

function target(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === "object") {
    if (first.path) return null;
    return { host: first.host ?? "localhost", port: first.port };
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return { host: typeof args[1] === "string" ? args[1] : "localhost", port: Number(first) };
  }
  return null; // IPC path
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const destination = target(args);
  if (destination && !isLoopback(destination.host) && !allowed.has(String(destination.host).toLowerCase())) {
    write({ egress: `${destination.host}:${destination.port}`, blocked: block, stack: new Error().stack.split("\n").slice(2, 7).join(" | ") });
    if (block) {
      process.nextTick(() => this.destroy(new Error(`loadtest egress guard blocked ${destination.host}:${destination.port}`)));
      return this;
    }
  }
  return originalConnect.apply(this, args);
};

write({ guard: "active", mode: block ? "block" : "log", allowed: [...allowed] });
