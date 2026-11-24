import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { LRUCache } from "lru-cache";

import { createSemaphore, SemaphoreTimeoutError, type Semaphore } from "@blast/server/lib/concurrency.ts";

import { SingleFlight } from "@blast/server/modules/mission-control/card-images/single-flight.ts";
import {
  createPresaleReceiptLogo,
  PRESALE_RECEIPT_LOGO_SIZE,
  type PresaleReceiptLogo,
} from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";

/** The whole fetch, redirects included, must finish within this. */
export const COIN_LOGO_TIMEOUT_MS = 3_000;
/** A logo response body larger than this is refused. */
export const COIN_LOGO_MAX_BYTES = 1_048_576;
const MAX_REDIRECTS = 3;
/** 2000 x 2000 is far more than a 512-pixel square needs, and caps a decode's memory. */
const MAX_INPUT_PIXELS = 4_000_000;
/** Logo decodes this process runs at once; a decode waits for a slot only within the fetch's budget. */
const DECODE_SLOTS = createSemaphore(2);

/** Why a logo was not used: a bounded label, safe in metrics. */
export type CoinLogoRefusal =
  | "absent"
  | "not_https"
  | "dns"
  | "private_address"
  | "network"
  | "timeout"
  | "http_status"
  | "too_many_redirects"
  | "content_type"
  | "too_large"
  | "not_raster";

/**
 * A refusal is `transient` when a later fetch may well succeed (a timeout, a
 * network or DNS failure, a 5xx, 429 or 408), so its fallback image must not be cached
 * for long. Every other refusal is a property of the logo or its URL.
 */
export type CoinLogoResult =
  | Readonly<{ logo: PresaleReceiptLogo }>
  | Readonly<{ logo: null; reason: CoinLogoRefusal; transient: boolean }>;

export type CoinLogoOptions = Readonly<{
  /**
   * A host name's addresses (default: the system's DNS servers, A and AAAA).
   * It is given the fetch's signal and abandoned when the signal fires.
   */
  resolve?: (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>;
  /** Which resolved addresses may be connected to (default: public unicast only). */
  addressAllowed?: (address: string) => boolean;
  /** Extra trusted certificate authorities (tests only). */
  ca?: string | Buffer;
  timeoutMs?: number;
  /** Retain actual work after a visible timeout; canonical owners inject request tracking. */
  trackWork?: <T>(work: Promise<T>) => Promise<T>;
  /** The decode slots (default: two per process). */
  decodeSlots?: Semaphore;
  /** Preserve a cover's aspect ratio when reusing this guarded raster pipeline. Logos fill the square. */
  fit?: "cover" | "inside";
}>;

class Refused extends Error {
  readonly reason: CoinLogoRefusal;
  readonly transient: boolean;
  constructor(reason: CoinLogoRefusal, transient = false) {
    super(reason);
    this.reason = reason;
    this.transient = transient;
  }
}

/** `operation`, or a rejection as soon as `signal` fires (the operation is left to finish on its own). */
function track<T>(options: CoinLogoOptions, work: Promise<T>): Promise<T> {
  return options.trackWork ? options.trackWork(work) : work;
}

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Refused("timeout", true));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Refused("timeout", true));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// Separate lists: a BlockList checks an IPv4 address against IPv6 rules as its
// mapped form, so `::ffff:0:0/96` would otherwise refuse every IPv4 address.
const NON_PUBLIC_V4 = new BlockList();
const NON_PUBLIC_V6 = new BlockList();
/** IPv6 is allowed only inside global unicast, and then only outside `NON_PUBLIC_V6`. */
const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC_V4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["::1", 128], ["::ffff:0:0", 96], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) NON_PUBLIC_V6.addSubnet(network, prefix, "ipv6");

/**
 * Whether `address` is a public unicast IP: not private, loopback,
 * link-local, carrier-grade NAT, documentation, benchmarking, multicast,
 * reserved, or an IPv6 form that embeds an IPv4 address (compatible, mapped,
 * translated, NAT64, 6to4). An IPv6 address must also be in `2000::/3`.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !NON_PUBLIC_V4.check(address, "ipv4");
  return GLOBAL_UNICAST_V6.check(address, "ipv6") && !NON_PUBLIC_V6.check(address, "ipv6");
}

/** A DNS query is sent again after this long without an answer, up to `DNS_TRIES` times. */
const DNS_TRY_TIMEOUT_MS = 750;
const DNS_TRIES = 3;

/**
 * A and AAAA answers through c-ares, not `getaddrinfo`: no libuv pool thread
 * is held. A lost query is resent after 750 ms, up to three tries, so one
 * dropped packet costs one short wait, not the whole budget; the queries are
 * cancelled when the fetch's signal fires, so DNS never outlives the 3 s.
 * `servers` replaces the system's DNS servers (tests only).
 */
export function createDnsResolve(options: Readonly<{ servers?: readonly string[] }> = {}) {
  return async (hostname: string, signal?: AbortSignal): Promise<readonly string[]> => {
    const resolver = new Resolver({ timeout: DNS_TRY_TIMEOUT_MS, tries: DNS_TRIES });
    if (options.servers) resolver.setServers([...options.servers]);
    const cancel = () => resolver.cancel();
    if (signal?.aborted) throw new Refused("timeout", true);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
      const addresses = answers.flatMap((answer) => (answer.status === "fulfilled" ? answer.value : []));
      if (!addresses.length) throw new Error("The host name has no addresses.");
      return addresses;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };
}

const systemResolve = createDnsResolve();

type Fetched = Readonly<{ status: number; location: string | null; contentType: string; body: Buffer | null }>;

/**
 * One GET to `url` over TLS, connected to the vetted `address` only (no
 * second resolution, so DNS cannot rebind it), with the certificate checked
 * against the URL's host name. A redirect's body is not read; any other body
 * is read up to `COIN_LOGO_MAX_BYTES`.
 */
function get(url: URL, address: string, signal: AbortSignal, ca: string | Buffer | undefined): Promise<Fetched> {
  const family = isIP(address);
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if (options.all) (callback as (error: null, addresses: { address: string; family: number }[]) => void)(null, [{ address, family }]);
    else callback(null, address, family);
  };
  let requestClosed = Promise.resolve();
  let responseClosed = Promise.resolve();
  const result = new Promise<Fetched>((resolve, reject) => {
    const outgoing = httpsRequest(url, {
      method: "GET",
      // No pooled socket: every request connects to its own vetted address.
      agent: false,
      lookup: pinned,
      signal,
      ...(ca ? { ca } : {}),
      headers: { accept: "image/png, image/jpeg, image/webp", "user-agent": "blast-presale-receipt/1" },
    }, (response) => {
      responseClosed = new Promise<void>((closed) => response.once("close", closed));
      response.on("error", reject);
      const status = response.statusCode ?? 0;
      const location = typeof response.headers.location === "string" ? response.headers.location : null;
      const contentType = (response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (status !== 200) {
        response.destroy();
        resolve({ status, location, contentType, body: null });
        return;
      }
      if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
        response.destroy();
        reject(new Refused("content_type"));
        return;
      }
      if (Number(response.headers["content-length"]) > COIN_LOGO_MAX_BYTES) {
        response.destroy();
        reject(new Refused("too_large"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > COIN_LOGO_MAX_BYTES) {
          response.destroy();
          reject(new Refused("too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status, location, contentType, body: Buffer.concat(chunks) }));
    });
    requestClosed = new Promise<void>((closed) => outgoing.once("close", closed));
    outgoing.on("error", reject);
    outgoing.end();
  });
  return result.finally(async () => {
    await requestClosed;
    await responseClosed;
  });
}

/** PNG, JPEG or WebP by signature; SVG and everything else is not a raster logo. */
function rasterSignature(bytes: Buffer): boolean {
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  return png || jpeg || webp;
}

/**
 * The logo decoded and drawn into the fixed square, as a deterministic PNG,
 * inside the fetch's budget: it waits for one of the process's decode slots
 * only until the deadline, and the fetch gives up when the signal fires (the
 * slot is held until the decode itself ends, so the bound stays true).
 */
async function normalize(bytes: Buffer, signal: AbortSignal, deadline: number, slots: Semaphore, fit: "cover" | "inside", options: CoinLogoOptions): Promise<PresaleReceiptLogo> {
  if (!rasterSignature(bytes)) throw new Refused("not_raster");
  let release: () => void;
  try {
    // Never abandoned: an acquire left pending would take a slot later and keep it.
    release = await slots.acquire(Math.max(0, deadline - Date.now()));
  } catch (error) {
    if (error instanceof SemaphoreTimeoutError) throw new Refused("timeout", true);
    throw error;
  }
  if (signal.aborted) {
    release();
    throw new Refused("timeout", true);
  }
  const decoding = track(options, decode(bytes, fit));
  decoding.finally(release).catch(() => undefined);
  return untilAborted(decoding, signal);
}

async function decode(bytes: Buffer, fit: "cover" | "inside"): Promise<PresaleReceiptLogo> {
  const { default: sharp } = await import("sharp");
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
    const { format } = await image.metadata();
    if (format !== "png" && format !== "jpeg" && format !== "webp") throw new Refused("not_raster");
    const png = await image
      .resize(PRESALE_RECEIPT_LOGO_SIZE, PRESALE_RECEIPT_LOGO_SIZE, { fit })
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer();
    return createPresaleReceiptLogo(png);
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused("not_raster");
  }
}

async function fetchPublicLogo(url: URL, options: CoinLogoOptions, signal: AbortSignal): Promise<Fetched> {
  const resolve = options.resolve ?? systemResolve;
  const allowed = options.addressAllowed ?? isPublicAddress;
  if (url.protocol !== "https:" || url.username || url.password) throw new Refused("not_https");
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  let addresses: readonly string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await untilAborted(track(options, resolve(hostname, signal)), signal);
    } catch (error) {
      if (error instanceof Refused) throw error;
      throw new Refused("dns", true);
    }
  }
  // Every address must be public: a name with one private answer is refused outright.
  if (!addresses.length) throw new Refused("dns", true);
  if (!addresses.every(allowed)) throw new Refused("private_address");
  let fetched: Fetched;
  try {
    fetched = await track(options, get(url, addresses[0], signal, options.ca));
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused(signal.aborted ? "timeout" : "network", true);
  }
  return fetched;
}

async function fetchLogo(
  raw: string,
  options: CoinLogoOptions,
  signal: AbortSignal,
  deadline: number,
): Promise<PresaleReceiptLogo> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Refused("not_https");
  }
  for (let hop = 0; ; hop += 1) {
    const fetched = await fetchPublicLogo(url, options, signal);
    if (fetched.status >= 300 && fetched.status < 400 && fetched.location) {
      if (hop >= MAX_REDIRECTS) throw new Refused("too_many_redirects");
      try {
        url = new URL(fetched.location, url);
      } catch {
        throw new Refused("not_https");
      }
      continue;
    }
    if (fetched.status !== 200 || !fetched.body) {
      // 5xx, 429 Too Many Requests and 408 Request Timeout may well succeed later.
      const { status } = fetched;
      throw new Refused("http_status", status >= 500 || status === 429 || status === 408);
    }
    return normalize(fetched.body, signal, deadline, options.decodeSlots ?? DECODE_SLOTS, options.fit ?? "cover", options);
  }
}

/**
 * The sale coin's logo from its untrusted `Currency` icon URL, or why not.
 * HTTPS only; each host (the first and every redirect) must resolve to public
 * addresses only, and the connection goes to the vetted address. 3 s in all,
 * at most 1 MiB, PNG, JPEG or WebP only (SVG is refused), decoded and drawn
 * into a fixed 512-pixel PNG square with sharp (`fit: inside` keeps cover
 * proportions within that bound). Never throws: any failure is
 * `logo: null` with a reason, and the receipt shows the monogram mark.
 */
export async function fetchCoinLogo(url: string | null, options: CoinLogoOptions = {}): Promise<CoinLogoResult> {
  if (!url) return { logo: null, reason: "absent", transient: false };
  const timeoutMs = options.timeoutMs ?? COIN_LOGO_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const logo = await fetchLogo(url, options, signal, Date.now() + timeoutMs);
    return { logo };
  } catch (error) {
    if (signal.aborted) return { logo: null, reason: "timeout", transient: true };
    if (error instanceof Refused) return { logo: null, reason: error.reason, transient: error.transient };
    return { logo: null, reason: "network", transient: true };
  }
}

/** What a receipt uses: the logo, or null and whether that refusal was transient. */
export type CoinLogoOutcome = Readonly<{ logo: PresaleReceiptLogo | null; transient: boolean }>;

/** How long a fetched logo, and a refusal, is reused before the URL is fetched again. */
export const COIN_LOGO_CACHE_MS = 600_000;
export const COIN_LOGO_REFUSAL_CACHE_MS = 60_000;

/**
 * `fetchLogo` (the guard) with a per-process cache by icon URL, bounded by
 * `maxBytes` of logo data, and one fetch in flight per URL: every receipt of a
 * sale shares its coin's logo, so repeat views neither refetch it nor hammer
 * its host. A refusal is kept for a minute, with its kind, a logo for ten.
 */
export function cachedCoinLogo(
  fetchLogo: (url: string) => Promise<CoinLogoResult>,
  options: Readonly<{ maxBytes?: number; now?: () => number }> = {},
): (url: string | null) => Promise<CoinLogoOutcome> {
  const now = options.now ?? Date.now;
  type Entry = CoinLogoOutcome & Readonly<{ expires: number }>;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("The coin logo memory cache size must be a non-negative integer.");
  }
  const cache = maxBytes === 0 ? undefined : new LRUCache<string, Entry>({
    maxSize: maxBytes,
    sizeCalculation: (entry) => 256 + (entry.logo?.bytes.length ?? 0),
  });
  const flights = new SingleFlight<CoinLogoOutcome>();
  return async (url) => {
    if (!url) return { logo: null, transient: false };
    const cached = cache?.get(url);
    if (cached && cached.expires > now()) return { logo: cached.logo, transient: cached.transient };
    return flights.run(url, async () => {
      const result = await fetchLogo(url);
      const outcome: CoinLogoOutcome = { logo: result.logo, transient: "transient" in result && result.transient };
      cache?.set(url, { ...outcome, expires: now() + (outcome.logo ? COIN_LOGO_CACHE_MS : COIN_LOGO_REFUSAL_CACHE_MS) });
      return outcome;
    }).promise;
  };
}
