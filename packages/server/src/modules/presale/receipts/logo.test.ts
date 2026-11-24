import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { after, before } from "node:test";

import { createSemaphore } from "@blast/server/lib/concurrency.ts";

import sharp from "sharp";

import { createPresaleReceiptLogo, PRESALE_RECEIPT_LOGO_SIZE } from "@blast/server/modules/mission-control/card-renderer/index.ts";
import {
  cachedCoinLogo,
  createDnsResolve,
  COIN_LOGO_MAX_BYTES,
  COIN_LOGO_TIMEOUT_MS,
  fetchCoinLogo,
  isPublicAddress,
  type CoinLogoOptions,
} from "@blast/server/modules/presale/receipts/logo.ts";

/**
 * T-012 (AC-100): the coin logo fetch guard against a local HTTPS server
 * (a self-signed certificate for `logo.test`). Host names resolve through a
 * fixture resolver; the only address the tests let through besides public
 * ones is the server's own 127.0.0.1. No request leaves this machine.
 */

const execute = promisify(execFile);
let server: Server;
let port = 0;
let ca = "";
let directory = "";
const hits: string[] = [];
let connections = 0;

const PNG = await sharp({ create: { width: 64, height: 32, channels: 4, background: "#ff4c98" } }).png().toBuffer();
const JPEG = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#81cba5" } }).jpeg().toBuffer();
const WEBP = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#142532" } }).webp().toBuffer();
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');

/** Host names the fixture resolver answers; anything else is unknown. */
const DNS: Record<string, string[]> = {
  "logo.test": ["127.0.0.1"],
  "private.logo.test": ["10.0.0.7"],
  "linklocal.logo.test": ["169.254.169.254"],
  "mixed.logo.test": ["127.0.0.1", "192.168.1.20"],
  // On the fixture DNS but not in the certificate's names.
  "other.logo.test": ["127.0.0.1"],
};

function options(overrides: Partial<CoinLogoOptions> = {}): CoinLogoOptions {
  return {
    resolve: async (hostname) => {
      const addresses = DNS[hostname];
      if (!addresses) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return addresses;
    },
    addressAllowed: (address) => address === "127.0.0.1" || isPublicAddress(address),
    ca,
    ...overrides,
  };
}

const url = (path: string, host = "logo.test") => `https://${host}:${port}${path}`;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "receipt-logo-"));
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  await execute("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=logo.test",
    "-addext", "subjectAltName=DNS:logo.test,DNS:private.logo.test,DNS:mixed.logo.test,DNS:linklocal.logo.test",
  ]);
  ca = await readFile(cert, "utf8");
  server = createServer({ key: await readFile(key), cert: ca }, (request, response) => {
    hits.push(`${request.headers.host}${request.url}`);
    const send = (type: string, body: Buffer, headers: Record<string, string> = {}) => {
      response.writeHead(200, { "content-type": type, "content-length": String(body.length), ...headers });
      response.end(body);
    };
    switch (request.url) {
      case "/good.png": return send("image/png", PNG);
      case "/good.jpg": return send("image/jpeg; charset=binary", JPEG);
      case "/good.webp": return send("image/webp", WEBP);
      case "/logo.svg": return send("image/svg+xml", SVG);
      case "/svg-as-png.png": return send("image/png", SVG);
      case "/text.png": return send("text/html", PNG);
      case "/error-503.png": response.writeHead(503); return response.end();
      case "/error-429.png": response.writeHead(429, { "retry-after": "30" }); return response.end();
      case "/error-408.png": response.writeHead(408); return response.end();
      case "/huge.png": return send("image/png", Buffer.concat([PNG, Buffer.alloc(COIN_LOGO_MAX_BYTES)]));
      case "/huge-chunked.png": {
        response.writeHead(200, { "content-type": "image/png" });
        const chunk = Buffer.alloc(64 * 1024, 1);
        for (let sent = 0; sent <= COIN_LOGO_MAX_BYTES; sent += chunk.length) response.write(chunk);
        return response.end();
      }
      case "/slow.png": {
        const timer = setTimeout(() => send("image/png", PNG), 1_500);
        response.on("close", () => clearTimeout(timer));
        return;
      }
      case "/redirect-good": response.writeHead(302, { location: "/good.png" }); return response.end();
      case "/redirect-private": response.writeHead(302, { location: url("/good.png", "private.logo.test") }); return response.end();
      case "/redirect-http": response.writeHead(301, { location: `http://logo.test:${port}/good.png` }); return response.end();
      case "/redirect-loop": response.writeHead(302, { location: "/redirect-loop" }); return response.end();
      default: response.writeHead(404); return response.end();
    }
  });
  server.on("secureConnection", () => { connections += 1; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

test("the guard's limits are 3 s, 1 MiB and a fixed square", () => {
  assert.equal(COIN_LOGO_TIMEOUT_MS, 3_000);
  assert.equal(COIN_LOGO_MAX_BYTES, 1_048_576);
  assert.equal(PRESALE_RECEIPT_LOGO_SIZE, 512);
});

test("share covers retain their aspect ratio inside the same bounded raster pipeline", async () => {
  const result = await fetchCoinLogo(url("/good.png"), options({ fit: "inside" }));
  assert.ok(result.logo);
  const metadata = await sharp(Buffer.from(result.logo.bytes, "base64")).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height], ["png", 512, 256]);
});

test("PNG, JPEG and WebP logos decode to the same fixed square PNG", async () => {
  for (const path of ["/good.png", "/good.jpg", "/good.webp", "/redirect-good"]) {
    const result = await fetchCoinLogo(url(path), options());
    assert.ok(result.logo, `${path}: ${"reason" in result ? result.reason : ""}`);
    const bytes = Buffer.from(result.logo.bytes, "base64");
    assert.equal(result.logo.sha256, createHash("sha256").update(bytes).digest("hex"));
    const metadata = await sharp(bytes).metadata();
    assert.deepEqual([metadata.format, metadata.width, metadata.height], ["png", 512, 512], path);
  }
  const [one, two] = await Promise.all([fetchCoinLogo(url("/good.png"), options()), fetchCoinLogo(url("/good.png"), options())]);
  assert.equal(one.logo?.sha256, two.logo?.sha256, "normalization is deterministic");
});

test("missing, oversized, slow and non-raster logos are refused", async () => {
  const cases: [string, string, Partial<CoinLogoOptions>?][] = [
    ["/missing.png", "http_status"],
    ["/huge.png", "too_large"],
    ["/huge-chunked.png", "too_large"],
    ["/slow.png", "timeout", { timeoutMs: 300 }],
    ["/logo.svg", "content_type"],
    ["/text.png", "content_type"],
    ["/svg-as-png.png", "not_raster"],
    ["/redirect-loop", "too_many_redirects"],
  ];
  for (const [path, reason, overrides] of cases) {
    const result = await fetchCoinLogo(url(path), options(overrides));
    assert.equal(result.logo, null, path);
    assert.equal("reason" in result && result.reason, reason, path);
  }
});

test("private, loopback and link-local hosts are refused before any connection, also after a redirect", async () => {
  hits.length = 0;
  const strict = options({ addressAllowed: isPublicAddress });
  for (const [target, settings] of [
    [url("/good.png", "private.logo.test"), options()],
    [url("/good.png", "linklocal.logo.test"), options()],
    [url("/good.png", "mixed.logo.test"), options()],
    [url("/good.png"), strict],
    [`https://127.0.0.1:${port}/good.png`, strict],
    [`https://[::1]:${port}/good.png`, strict],
  ] as const) {
    const result = await fetchCoinLogo(target, settings);
    assert.equal(result.logo, null, target);
    assert.equal("reason" in result && result.reason, "private_address", target);
  }
  assert.deepEqual(hits, [], "no request reached the server");

  const redirected = await fetchCoinLogo(url("/redirect-private"), options());
  assert.equal("reason" in redirected && redirected.reason, "private_address");
  assert.deepEqual(hits, [`logo.test:${port}/redirect-private`], "the private redirect target was never requested");
});

test("only https URLs are fetched, also on redirect", async () => {
  for (const target of [`http://logo.test:${port}/good.png`, "data:image/png;base64,AAAA", "ftp://logo.test/a.png", "not a url"]) {
    const result = await fetchCoinLogo(target, options());
    assert.equal("reason" in result && result.reason, "not_https", target);
  }
  const result = await fetchCoinLogo(url("/redirect-http"), options());
  assert.equal("reason" in result && result.reason, "not_https");
  for (const missing of [null, ""]) {
    const absent = await fetchCoinLogo(missing, options());
    assert.equal("reason" in absent && absent.reason, "absent");
  }
});

test("a certificate from an untrusted authority is refused", async () => {
  const result = await fetchCoinLogo(url("/good.png"), options({ ca: undefined }));
  assert.equal("reason" in result && result.reason, "network");
});

test("a trusted certificate for another host name is refused: TLS is checked against the URL's host", async () => {
  const result = await fetchCoinLogo(url("/good.png", "other.logo.test"), options());
  assert.equal("reason" in result && result.reason, "network");
  assert.ok((await fetchCoinLogo(url("/good.png"), options())).logo, "the same server under its own name is fine");
});

test("the 3 s budget covers DNS: a slow resolver is abandoned and told to stop", async () => {
  let aborted: boolean | undefined;
  const started = performance.now();
  const result = await fetchCoinLogo(url("/good.png"), options({
    timeoutMs: 200,
    resolve: (_hostname, signal) => new Promise((resolve) => {
      setTimeout(() => { aborted = signal?.aborted; resolve(["127.0.0.1"]); }, 2_000);
    }),
  }));
  const elapsed = performance.now() - started;
  assert.equal("reason" in result && result.reason, "timeout");
  assert.ok(elapsed < 1_000, `returned after ${Math.round(elapsed)} ms`);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(aborted, true, "the resolver's signal had fired");
});

test("the 3 s budget covers decoding: a logo waiting for a decode slot times out", async () => {
  const decodeSlots = createSemaphore(1);
  const release = await decodeSlots.acquire(0);
  try {
    const started = performance.now();
    const result = await fetchCoinLogo(url("/good.png"), options({ timeoutMs: 300, decodeSlots }));
    assert.equal("reason" in result && result.reason, "timeout");
    assert.ok(performance.now() - started < 1_500);
  } finally {
    release();
  }
  assert.ok((await fetchCoinLogo(url("/good.png"), options({ decodeSlots }))).logo);
});

test("logos above 4 megapixels are refused before decoding", async () => {
  const large = await sharp({ create: { width: 2_001, height: 2_000, channels: 3, background: "#000" } }).png().toBuffer();
  const local = createServer({ key: await readFile(join(directory, "key.pem")), cert: ca }, (_request, response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(large);
  });
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  try {
    const result = await fetchCoinLogo(`https://logo.test:${(local.address() as AddressInfo).port}/large.png`, options());
    assert.equal("reason" in result && result.reason, "not_raster");
  } finally {
    local.closeAllConnections();
    await new Promise((resolve) => local.close(resolve));
  }
});

test("each hop resolves its host once and every request opens its own connection", async () => {
  const resolved: string[] = [];
  const counting = options({
    resolve: async (hostname) => {
      resolved.push(hostname);
      return DNS[hostname] ?? [];
    },
  });
  const before = connections;
  assert.ok((await fetchCoinLogo(url("/redirect-good"), counting)).logo);
  assert.ok((await fetchCoinLogo(url("/good.png"), counting)).logo);
  assert.deepEqual(resolved, ["logo.test", "logo.test", "logo.test"]);
  assert.equal(connections - before, 3, "no pooled socket is reused (agent: false)");
});

test("IPv4 and IPv6 literal forms are normalized and refused", async () => {
  const strict = options({ addressAllowed: isPublicAddress, resolve: async () => { throw new Error("no DNS for a literal"); } });
  for (const target of [
    "https://2130706433/a.png", "https://0x7f.1/a.png", "https://017700000001/a.png", "https://127.1/a.png",
    "https://0/a.png", "https://[::ffff:127.0.0.1]/a.png", "https://[::127.0.0.1]/a.png", "https://[0:0:0:0:0:ffff:a00:1]/a.png",
  ]) {
    const result = await fetchCoinLogo(target, strict);
    assert.equal("reason" in result && result.reason, "private_address", target);
  }
});

test("timeouts, network and DNS failures, 5xx, 429 and 408 are transient; other refusals are permanent", async () => {
  const cases: [string, Partial<CoinLogoOptions>, string, boolean][] = [
    [url("/slow.png"), { timeoutMs: 300 }, "timeout", true],
    [url("/error-503.png"), {}, "http_status", true],
    [url("/error-429.png"), {}, "http_status", true],
    [url("/error-408.png"), {}, "http_status", true],
    [url("/good.png", "unknown.logo.test"), {}, "dns", true],
    [url("/good.png"), { ca: undefined }, "network", true],
    [url("/missing.png"), {}, "http_status", false],
    [url("/logo.svg"), {}, "content_type", false],
    [url("/huge.png"), {}, "too_large", false],
    [url("/svg-as-png.png"), {}, "not_raster", false],
    [url("/good.png", "private.logo.test"), {}, "private_address", false],
    [`http://logo.test:${port}/good.png`, {}, "not_https", false],
  ];
  for (const [target, overrides, reason, transient] of cases) {
    const result = await fetchCoinLogo(target, options(overrides));
    assert.deepEqual("reason" in result ? [result.reason, result.transient] : null, [reason, transient], target);
  }
  const absent = await fetchCoinLogo(null, options());
  assert.equal("transient" in absent && absent.transient, false);
});

test("an unknown host is refused", async () => {
  const result = await fetchCoinLogo(url("/good.png", "unknown.logo.test"), options());
  assert.equal("reason" in result && result.reason, "dns");
});

test("the address policy refuses every non-public range", () => {
  for (const address of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "172.31.255.255",
    "192.0.0.8", "192.0.2.1", "192.168.0.1", "198.18.0.1", "198.51.100.2", "203.0.113.9", "224.0.0.1",
    "240.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1",
    "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1", "2001:db8::1", "2002:a00:1::", "100::1", "not-an-ip",
    // Outside global unicast 2000::/3, including IPv4-compatible and IPv4-translated forms.
    "::7f00:1", "::a00:1", "::a9fe:a9fe", "::ffff:0:7f00:1", "3fff::1", "5f00::1", "4000::1", "e000::1", "1::1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["1.1.1.1", "93.184.215.14", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("logos are cached per URL: one fetch in flight, ten minutes for a logo, one for a refusal", async () => {
  let clock = 0;
  const fetched: string[] = [];
  const good = await fetchCoinLogo(url("/good.png"), options());
  assert.ok(good.logo);
  const logo = cachedCoinLogo(async (target) => {
    fetched.push(target);
    return target.endsWith("good.png") ? good : { logo: null, reason: "http_status", transient: true };
  }, { now: () => clock });
  const [one, two] = await Promise.all([logo("https://a.example/good.png"), logo("https://a.example/good.png")]);
  assert.deepEqual([one, two], [{ logo: good.logo, transient: false }, { logo: good.logo, transient: false }]);
  assert.deepEqual(await logo("https://a.example/missing.png"), { logo: null, transient: true });
  assert.deepEqual(await logo("https://a.example/missing.png"), { logo: null, transient: true }, "a cached refusal keeps its kind");
  assert.deepEqual(await logo(null), { logo: null, transient: false });
  clock = 59_000;
  await logo("https://a.example/good.png");
  await logo("https://a.example/missing.png");
  assert.equal(fetched.length, 2);
  clock = 61_000;
  await logo("https://a.example/missing.png");
  assert.equal(fetched.length, 3, "a refusal is retried after a minute");
  clock = 601_000;
  await logo("https://a.example/good.png");
  assert.equal(fetched.length, 4, "a logo is refetched after ten minutes");
});

test("logo cache budgets include refusal entries and evict least recently used URLs", async () => {
  const image = createPresaleReceiptLogo(PNG);
  const fetched: string[] = [];
  const logo = cachedCoinLogo(async (target) => {
    fetched.push(target);
    return target === "good" ? { logo: image } : { logo: null, reason: "http_status", transient: true };
  }, { maxBytes: 256 + image.bytes.length + 256 });

  await logo("good");
  await logo("missing-a");
  await logo("good");
  await logo("missing-b");
  assert.deepEqual(await logo("good"), { logo: image, transient: false });
  assert.deepEqual(await logo("missing-b"), { logo: null, transient: true });
  assert.deepEqual(fetched, ["good", "missing-a", "missing-b"]);
  await logo("missing-a");
  assert.deepEqual(fetched, ["good", "missing-a", "missing-b", "missing-a"]);
});

test("oversized logos bypass storage without evicting cached refusals", async () => {
  const image = createPresaleReceiptLogo(PNG);
  const fetched: string[] = [];
  const logo = cachedCoinLogo(async (target) => {
    fetched.push(target);
    return target === "good" ? { logo: image } : { logo: null, reason: "http_status", transient: true };
  }, { maxBytes: 256 });
  await logo("missing");
  await logo("good");
  await logo("good");
  assert.deepEqual(await logo("missing"), { logo: null, transient: true });
  assert.deepEqual(fetched, ["missing", "good", "good"]);
});

test("disabled logo caches still share concurrent work and reject invalid budgets", async () => {
  let fetches = 0;
  const fetchLogo = async () => {
    fetches += 1;
    return { logo: null, reason: "http_status", transient: true } as const;
  };
  const logo = cachedCoinLogo(fetchLogo, { maxBytes: 0 });
  const refusal = { logo: null, transient: true };
  assert.deepEqual(await Promise.all([logo("missing"), logo("missing")]), [refusal, refusal]);
  assert.equal(fetches, 1);
  assert.deepEqual(await logo("missing"), refusal);
  assert.equal(fetches, 2, "a zero budget does not keep refusals");
  for (const maxBytes of [-1, 0.5, Number.NaN, Infinity]) {
    assert.throws(() => cachedCoinLogo(fetchLogo, { maxBytes }), RangeError);
  }
});

/**
 * A local DNS server for A and AAAA: it drops the first query of each type
 * it sees and answers every later one, like a lossy UDP path.
 */
async function lossyDnsServer() {
  const seen = new Map<number, number>();
  const socket = createSocket("udp4");
  socket.on("message", (query, peer) => {
    let offset = 12;
    while (query[offset] !== 0) offset += query[offset] + 1;
    const questionEnd = offset + 5;
    const type = query.readUInt16BE(offset + 1);
    const count = (seen.get(type) ?? 0) + 1;
    seen.set(type, count);
    if (count === 1) return;
    const rdata = type === 1 ? Buffer.from([93, 184, 215, 14]) : Buffer.from("26064700000000000000000000000001", "hex");
    const header = Buffer.alloc(12);
    query.copy(header, 0, 0, 2);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(1, 6);
    const answer = Buffer.alloc(12);
    answer.writeUInt16BE(0xc00c, 0);
    answer.writeUInt16BE(type, 2);
    answer.writeUInt16BE(1, 4);
    answer.writeUInt32BE(60, 6);
    answer.writeUInt16BE(rdata.length, 10);
    socket.send(Buffer.concat([header, query.subarray(12, questionEnd), answer, rdata]), peer.port, peer.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return { server: `127.0.0.1:${socket.address().port}`, seen, close: () => socket.close() };
}

test("DNS retries a dropped query inside the budget: 750 ms a try, three tries", async () => {
  const dns = await lossyDnsServer();
  try {
    const resolve = createDnsResolve({ servers: [dns.server] });
    const started = performance.now();
    const addresses = await resolve("logo.example", AbortSignal.timeout(COIN_LOGO_TIMEOUT_MS));
    const elapsed = performance.now() - started;
    assert.deepEqual([...addresses].sort(), ["2606:4700::1", "93.184.215.14"]);
    assert.ok(elapsed < 2_000, `answered after ${Math.round(elapsed)} ms, not after a whole 3 s try`);
    assert.deepEqual([dns.seen.get(1), dns.seen.get(28)], [2, 2], "each dropped query was sent again");
  } finally {
    dns.close();
  }
});

test("DNS never outlives the fetch's budget", async () => {
  const silent = createSocket("udp4");
  await new Promise<void>((resolve) => silent.bind(0, "127.0.0.1", resolve));
  try {
    const resolve = createDnsResolve({ servers: [`127.0.0.1:${silent.address().port}`] });
    const started = performance.now();
    await assert.rejects(resolve("logo.example", AbortSignal.timeout(300)));
    assert.ok(performance.now() - started < 1_000);
  } finally {
    silent.close();
  }
});
