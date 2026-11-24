import { z } from "zod";
import { createHash } from "node:crypto";

import {
  concurrencyFromEnvironment,
  createSemaphore,
  retryAfterMs,
  type Semaphore,
} from "@blast/server/lib/concurrency.ts";
import { requiredValue } from "@blast/core/lib/config/secret.ts";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import { PrivyAdapterError } from "@blast/core/lib/privy-adapter/errors.ts";
import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import type { PrivyProviderGateway } from "@blast/core/lib/privy-adapter/types.ts";

const DEFAULT_BASE_URL = "https://api.privy.io";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 256 * 1_024;
const DEFAULT_MAX_CONCURRENCY = 16;
const DEFAULT_QUEUE_TIMEOUT_MS = 3_000;
const MAX_RETRIES = 2;
/** Total time a request may spend sleeping between retries. */
const MAX_RETRY_WAIT_MS = 2_000;
const RETRY_BASE_DELAY_MS = 250;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export type PrivyHttpGatewayOptions = Readonly<{
  appId: string;
  appSecret: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  jwtVerificationKey: string;
  timeoutMs?: number;
  /** Shared per-instance limit; a private one is created when omitted. */
  limiter?: Semaphore;
  queueTimeoutMs?: number;
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}>;

type PrivyEndpoint = "users" | "wallets";

function requiredSecret(value: string | undefined): string {
  const parsed = z.string().min(1).safeParse(value);
  if (!parsed.success) throw new PrivyAdapterError("INVALID_CONFIGURATION");
  return parsed.data;
}

function safeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    const isLocalHttp =
      url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (url.protocol !== "https:" && !isLocalHttp) {
      throw new Error("Privy base URL must use HTTPS");
    }
    return url.href.replace(/\/$/, "");
  } catch {
    throw new PrivyAdapterError("INVALID_CONFIGURATION");
  }
}

export function createPrivyHttpGateway(options: PrivyHttpGatewayOptions): PrivyProviderGateway {
  const appId = requiredSecret(options.appId);
  const appSecret = requiredSecret(options.appSecret);
  const baseUrl = safeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof fetchImplementation !== "function" ||
    !z.number().int().min(1).max(30_000).safeParse(timeoutMs).success
  ) {
    throw new PrivyAdapterError("INVALID_CONFIGURATION");
  }

  const verifyAccessToken = createPrivyTokenVerifier({
    appId,
    verificationKey: options.jwtVerificationKey,
  });
  const authorization = `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`;

  const limiter = options.limiter ?? createSemaphore(DEFAULT_MAX_CONCURRENCY);
  const queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  if (!z.number().int().min(0).max(30_000).safeParse(queueTimeoutMs).success) {
    throw new PrivyAdapterError("INVALID_CONFIGURATION");
  }
  const random = options.random ?? Math.random;
  const sleep =
    options.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  type Attempt = { ok: true; value: unknown } | { ok: false; headers: Headers; retryable: boolean };

  /** One HTTP exchange; the timeout covers the headers and the body. */
  async function attempt(
    path: string,
    init: RequestInit | undefined,
    observe: (status: string) => void,
  ): Promise<Attempt> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImplementation(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: authorization,
          "privy-app-id": appId,
          ...init?.headers,
        },
        signal: controller.signal,
      });
      observe(String(response.status));

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return {
          ok: false,
          headers: response.headers,
          retryable: RETRYABLE_STATUSES.has(response.status),
        };
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new PrivyAdapterError("PROVIDER_RESPONSE_INVALID");
      }
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
        throw new PrivyAdapterError("PROVIDER_RESPONSE_INVALID");
      }
      try {
        return { ok: true, value: JSON.parse(body) as unknown };
      } catch {
        throw new PrivyAdapterError("PROVIDER_RESPONSE_INVALID");
      }
    } catch (error) {
      if (error instanceof PrivyAdapterError) throw error;
      if (controller.signal.aborted) {
        observe("timeout");
        throw new PrivyAdapterError("PROVIDER_TIMEOUT");
      }
      observe("network");
      throw new PrivyAdapterError("PROVIDER_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * One bounded Privy call: waits at most `queueTimeoutMs` for a slot, retries
   * 429/502/503/504 at most twice while honouring Retry-After, and never sleeps
   * more than MAX_RETRY_WAIT_MS in total. A Retry-After beyond that budget
   * fails fast with PROVIDER_UNAVAILABLE instead of holding the request open.
   */
  async function request(
    endpoint: PrivyEndpoint,
    path: string,
    init?: RequestInit,
  ): Promise<unknown> {
    const started = performance.now();
    let retries = 0;
    let status = "queue_timeout";
    let release: () => void;
    try {
      release = await limiter.acquire(queueTimeoutMs);
    } catch {
      recordMetric("privy.request", {
        durationMs: Math.round(performance.now() - started),
        endpoint,
        retries,
        status,
      });
      throw new PrivyAdapterError("PROVIDER_UNAVAILABLE");
    }
    try {
      let waitedMs = 0;
      for (;;) {
        const result = await attempt(path, init, (observed) => {
          status = observed;
        });
        if (result.ok) return result.value;
        if (!result.retryable || retries >= MAX_RETRIES) {
          throw new PrivyAdapterError("PROVIDER_UNAVAILABLE");
        }
        const hinted = retryAfterMs(result.headers, Date.now());
        const delayMs = hinted ?? Math.floor(random() * RETRY_BASE_DELAY_MS * 2 ** retries);
        if (waitedMs + delayMs > MAX_RETRY_WAIT_MS) {
          throw new PrivyAdapterError("PROVIDER_UNAVAILABLE");
        }
        await sleep(delayMs);
        waitedMs += delayMs;
        retries += 1;
      }
    } finally {
      release();
      recordMetric("privy.request", {
        durationMs: Math.round(performance.now() - started),
        endpoint,
        retries,
        status,
      });
    }
  }

  return {
    verifyAccessToken,
    getUser(privyDid) {
      return request("users", `/v1/users/${encodeURIComponent(privyDid)}`);
    },
    createEmbeddedSuiWallet({ chainType, ownerPrivyDid }) {
      const idempotencyKey = createHash("sha256")
        .update(`${appId}\0${ownerPrivyDid}\0${chainType}`)
        .digest("hex");
      return request("wallets", "/v1/wallets", {
        body: JSON.stringify({
          chain_type: chainType,
          owner: { user_id: ownerPrivyDid },
        }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        method: "POST",
      });
    },
  };
}

export type PrivyConfig = Readonly<{
  appId: string;
  appSecret: string;
  jwtVerificationKey: string;
  /** Bounds every Privy call this process makes. */
  maxConcurrency: number;
}>;

/** Privy's credentials, issued by Privy: presence only. */
export function parsePrivyConfig(environment: Readonly<Record<string, string | undefined>>): PrivyConfig {
  return {
    appId: requiredValue(environment, "PRIVY_APP_ID"),
    appSecret: requiredValue(environment, "PRIVY_APP_SECRET"),
    jwtVerificationKey: requiredValue(environment, "PRIVY_JWT_VERIFICATION_KEY"),
    maxConcurrency: concurrencyFromEnvironment(environment, "PRIVY_MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENCY, 256),
  };
}

/** A Privy gateway against Privy's production API; ignores any mock base URL. */
export function productionPrivyGateway(config: PrivyConfig): PrivyProviderGateway {
  return createPrivyHttpGateway({
    appId: config.appId,
    appSecret: config.appSecret,
    baseUrl: DEFAULT_BASE_URL,
    jwtVerificationKey: config.jwtVerificationKey,
    limiter: createSemaphore(config.maxConcurrency),
  });
}
