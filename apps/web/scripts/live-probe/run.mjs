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
const site = new URL(values.site).origin;
const host = values.host;
const endAt = Date.now() + Number(values.minutes) * 60_000;
const samples = [];
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
  const response = await fetch(`${site}/`, { redirect: "follow" });
  cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  cookieAt = Date.now();
  return { html: await response.text() };
}

async function discoverPools() {
  if (values.pool.length) return values.pool;
  const { html } = await gateCookie();
  const keys = [...new Set((html ?? "").match(/\b(?:blast_curve|cetus|bluefin):0x[0-9a-f]{64}\b/g) ?? [])];
  if (!keys.length) throw new Error("No pool keys found on the home page; pass --pool.");
  return keys.slice(0, Number(values.pools));
}

function record(event, receivedMs, stream) {
  const sample = frameLag(event, receivedMs);
  if (!sample) return;
  samples.push(sample);
  process.stdout.write(`${JSON.stringify({ host, mode: values.mode, stream, ...sample })}\n`);
}

const streamQuery = (pools) => new URLSearchParams([["activity", "true"], ...pools.map((pool) => ["pool", pool]), ...values["price-coin"].map((coin) => ["price_coin", coin])]);
const headers = () => ({ cookie, "sec-fetch-site": "same-origin", origin: site });

async function openSse(pools, stream) {
  const query = streamQuery(pools);
  const response = await fetch(`${site}/api/launchpad/market/stream?${query}`, { headers: headers() });
  if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    const now = Date.now();
    const parsed = parseSse(buffer + decoder.decode(chunk, { stream: true }));
    buffer = parsed.rest;
    for (const event of parsed.events) record(event, now, stream);
    if (Date.now() > endAt) return;
  }
}

async function openSocket(pools, stream) {
  const ticket = await fetch(`${site}/api/launchpad/market/ticket`, { method: "POST", headers: { ...headers(), "x-blast-live-bucket": "0" } });
  if (ticket.status !== 200) throw new Error(`ticket ${ticket.status}`);
  const { ticket: token, url } = await ticket.json();
  const query = streamQuery(pools);
  const socket = new WebSocket(`${url}?${query}`, ["blast-live.v1", `blast-ticket.${token}`]);
  await new Promise((resolve, reject) => {
    const ping = setInterval(() => socket.readyState === 1 && socket.send(JSON.stringify({ op: "ping", t: Date.now() })), 15_000);
    const stop = setTimeout(() => socket.close(1000), Math.max(0, endAt - Date.now()));
    socket.onmessage = ({ data }) => {
      const event = parseSseBlock(String(data).replace(/\n+$/, ""));
      if (event) record(event, Date.now(), stream);
    };
    socket.onclose = ({ code }) => {
      clearInterval(ping);
      clearTimeout(stop);
      if (code === 1000) resolve();
      else reject(new Error(`socket closed ${code}`));
    };
  });
}

async function hold(pools, stream) {
  let attempt = 0;
  while (Date.now() < endAt) {
    try {
      await gateCookie();
      await (values.mode === "sse" ? openSse : openSocket)(pools, stream);
      attempt = 0;
    } catch (error) {
      console.error(`[${stream}] ${error.message}`);
    }
    const delay = Math.min(30_000, 1_000 * 2 ** attempt++) * (1 + Math.random() / 2);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

const pools = await discoverPools();
console.error(JSON.stringify({ host, mode: values.mode, site, pools, ntp_synced: ntpSynced() }));
const timer = setInterval(() => console.error(JSON.stringify({ at: new Date().toISOString(), summary: summarize(samples) })), 60_000);
const groups = [];
for (let index = 0; index < pools.length; index += 2) groups.push(pools.slice(index, index + 2));
await Promise.all(groups.map((group, index) => hold(group, index)));
clearInterval(timer);
console.error(JSON.stringify({ at: new Date().toISOString(), final: summarize(samples) }));
