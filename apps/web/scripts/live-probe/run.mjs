#!/usr/bin/env node
// Live market probe: holds market streams open and logs, per frame, receipt time minus the
// frame's chain timestamp. Stdout is JSONL samples; a summary goes to stderr every minute.
//   node apps/web/scripts/live-probe/run.mjs [--site URL] [--mode sse|socket] [--pool KEY]... [--price-coin TYPE]... [--minutes N]
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { frameLag, parseSse, parseSseBlock, summarize } from "./lag.mjs";

const { values } = parseArgs({ options: {
  site: { type: "string", default: "https://www.blast.fun" },
  mode: { type: "string", default: "sse" },
  pool: { type: "string", multiple: true, default: [] },
  "price-coin": { type: "string", multiple: true, default: ["0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"] },
  pools: { type: "string", default: "4" },
  minutes: { type: "string", default: "1440" },
  host: { type: "string", default: process.env.HOSTNAME ?? "probe" },
} });
if (!["sse", "socket"].includes(values.mode)) throw new Error("--mode is sse or socket");
const positive = (name) => {
  const value = Number(values[name]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
};
const site = new URL(values.site).origin;
const host = values.host;
const endAt = Date.now() + positive("minutes") * 60_000;
const poolLimit = positive("pools");
const LIVED_MS = 60_000;
let minute = [];
const all = [];
let cookie = "";
let cookieAt = 0;

function ntpSynced() {
  try {
    return execFileSync("timedatectl", ["show", "-p", "NTPSynchronized", "--value"], { encoding: "utf8" }).trim() === "yes";
  } catch {
    return null;
  }
}

/** The first-party API gate wants a cookie from a page load; refresh it every 30 minutes. */
async function gateCookie() {
  if (cookie && Date.now() - cookieAt < 30 * 60_000) return { html: null };
  const response = await fetch(`${site}/`, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Home page load failed: HTTP ${response.status}`);
  }
  cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  cookieAt = Date.now();
  return { html: await response.text() };
}

async function discoverPools() {
  if (values.pool.length) return values.pool;
  const { html } = await gateCookie();
  const keys = [...new Set((html ?? "").match(/\b(?:blast_curve|cetus|bluefin):0x[0-9a-f]{64}\b/g) ?? [])];
  if (!keys.length) throw new Error("No pool keys found on the home page; pass --pool.");
  return keys.slice(0, poolLimit);
}

/** Logs status and resync reasons; collects pools the stream reports unavailable. */
function control(event, stream, run) {
  if (event.event !== "status" && event.event !== "resync") return;
  let data = {};
  try {
    data = JSON.parse(event.data);
  } catch {}
  if (event.event === "resync" || data.state !== "live") console.error(`[${stream}] ${event.event} ${event.data}`);
  if (data.state === "unavailable" && data.pool_key) run.unavailable.add(data.pool_key);
}

function record(event, receivedMs, stream, run) {
  control(event, stream, run);
  const sample = frameLag(event, receivedMs);
  if (!sample) return;
  run.frames += 1;
  if (sample.lag_ms < 0) console.error(`[${stream}] negative lag ${sample.lag_ms} ms (${sample.kind}): check the clock`);
  minute.push(sample);
  all.push({ kind: sample.kind, lag_ms: sample.lag_ms });
  process.stdout.write(`${JSON.stringify({ host, mode: values.mode, stream, ...sample })}\n`);
}

// Prices ride on stream 0 only, so every stream does not carry the same price frames.
const streamQuery = (pools, stream) => new URLSearchParams([["activity", "true"], ...pools.map((pool) => ["pool", pool]), ...(stream === 0 ? values["price-coin"] : []).map((coin) => ["price_coin", coin])]);
const headers = () => ({ cookie, "sec-fetch-site": "same-origin", origin: site });

async function openSse(pools, stream, run) {
  const query = streamQuery(pools, stream);
  const response = await fetch(`${site}/api/launchpad/market/stream?${query}`, { headers: headers() });
  if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    const now = Date.now();
    const parsed = parseSse(buffer + decoder.decode(chunk, { stream: true }));
    buffer = parsed.rest;
    for (const event of parsed.events) record(event, now, stream, run);
    if (Date.now() > endAt) return;
  }
}

async function openSocket(pools, stream, run) {
  const ticket = await fetch(`${site}/api/launchpad/market/ticket`, { method: "POST", headers: { ...headers(), "x-blast-live-bucket": "0" }, signal: AbortSignal.timeout(15_000) });
  if (ticket.status !== 200) throw new Error(`ticket ${ticket.status}`);
  const { ticket: token, url } = await ticket.json();
  const query = streamQuery(pools, stream);
  const socket = new WebSocket(`${url}?${query}`, ["blast-live.v1", `blast-ticket.${token}`]);
  socket.binaryType = "arraybuffer";
  const decoder = new TextDecoder();
  await new Promise((resolve, reject) => {
    const ping = setInterval(() => socket.readyState === 1 && socket.send(JSON.stringify({ op: "ping", t: Date.now() })), 15_000);
    const stop = setTimeout(() => socket.close(1000), Math.max(0, endAt - Date.now()));
    socket.onmessage = ({ data }) => {
      const now = Date.now();
      const text = typeof data === "string" ? data : decoder.decode(data);
      const event = parseSseBlock(text.replace(/\n+$/, ""));
      if (event) record(event, now, stream, run);
    };
    socket.onclose = ({ code }) => {
      clearInterval(ping);
      clearTimeout(stop);
      if (code === 1000) resolve();
      else reject(new Error(`socket closed ${code}`));
    };
  });
}

async function hold(initialPools, stream) {
  let pools = initialPools;
  let attempt = 0;
  while (Date.now() < endAt && (pools.length || stream === 0)) {
    const run = { frames: 0, unavailable: new Set() };
    const openedAt = Date.now();
    try {
      await gateCookie();
      await (values.mode === "sse" ? openSse : openSocket)(pools, stream, run);
    } catch (error) {
      console.error(`[${stream}] ${error.message}`);
    }
    if (run.unavailable.size) {
      pools = pools.filter((pool) => !run.unavailable.has(pool));
      console.error(`[${stream}] dropped unavailable pools; left: ${pools.join(",") || "none"}`);
    }
    // A stream that ended quickly with nothing is a failure, even when it closed cleanly.
    attempt = run.frames > 0 || Date.now() - openedAt > LIVED_MS ? 0 : attempt + 1;
    if (Date.now() >= endAt) break;
    const delay = Math.min(30_000, 1_000 * 2 ** attempt) * (1 + Math.random() / 2);
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, endAt - Date.now()))));
  }
}

const pools = await discoverPools();
const synced = ntpSynced();
console.error(JSON.stringify({ host, mode: values.mode, site, pools, ntp_synced: synced }));
if (synced !== true) console.error("warning: clock not confirmed NTP-synced; lags may be off by the clock error");
// Per-minute window; the JSONL on stdout is the full record.
const timer = setInterval(() => {
  console.error(JSON.stringify({ at: new Date().toISOString(), minute: summarize(minute) }));
  minute = [];
}, 60_000);
const groups = [];
for (let index = 0; index < pools.length; index += 2) groups.push(pools.slice(index, index + 2));
await Promise.all(groups.map((group, index) => hold(group, index)));
clearInterval(timer);
console.error(JSON.stringify({ at: new Date().toISOString(), final: summarize(all) }));
