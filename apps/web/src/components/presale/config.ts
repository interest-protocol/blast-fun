import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** The presale runs on mainnet only. */
export const PRESALE_NETWORKS = ["mainnet"] as const;
export type PresaleNetwork = (typeof PRESALE_NETWORKS)[number];
export const PRESALE_EVM_CHAINS = ["base", "arbitrum", "ethereum"] as const;
export type PresaleEvmChain = (typeof PRESALE_EVM_CHAINS)[number];
export const PRESALE_THEMES = ["system", "dark", "light"] as const;
export type PresaleTheme = (typeof PRESALE_THEMES)[number];

// Scope records the environment variable's name. PresaleClientConfig defines
// which validated values cross the React Server Component boundary.
export const PRESALE_CONFIG_VARIABLES = {
  BLAST_NETWORK: { scope: "server", secret: false },
  NEXT_PUBLIC_PRESALE_BRIDGE_ENABLED: { scope: "public", secret: false },
  NEXT_PUBLIC_PRESALE_SOLANA_RPC_URL: { scope: "public", secret: false },
  NEXT_PUBLIC_PRESALE_EVM_RPC_URLS: { scope: "public", secret: false },
  NEXT_PUBLIC_PRESALE_SWAP_PROVIDERS: { scope: "public", secret: false },
  NEXT_PUBLIC_PRESALE_SWAP_SLIPPAGE_BPS: { scope: "public", secret: false },
  NEXT_PUBLIC_PRESALE_GAS_RESERVE_MIST: { scope: "public", secret: false },
  NEXT_PUBLIC_PRESALE_DEFAULT_THEME: { scope: "public", secret: false },
  NEXT_PUBLIC_PRESALE_APPLY_URL: { scope: "public", secret: false },
  NEXT_PUBLIC_PRESALE_NOTIFY_URL: { scope: "public", secret: false },
  NEXT_PUBLIC_PRESALE_BUY_SUI_URL: { scope: "public", secret: false },
  PRIVY_APP_ID: { scope: "server", secret: false },
} as const satisfies Record<string, { scope: "server" | "public"; secret: boolean }>;
export type PresaleConfigVariable = keyof typeof PRESALE_CONFIG_VARIABLES;

export type PresaleUnavailableReason = "missing" | "invalid";

/** One validated value, or why the feature that needs it is unavailable. */
export type PresaleSetting<T> =
  | Readonly<{ status: "available"; value: T }>
  | Readonly<{ status: "unavailable"; variable: PresaleConfigVariable; reason: PresaleUnavailableReason }>;

export type PresaleConfig = Readonly<{
  network: PresaleSetting<PresaleNetwork>;
  bridge: Readonly<{
    /** `NEXT_PUBLIC_PRESALE_BRIDGE_ENABLED=1` shows the cross-chain rail. */
    enabled: boolean;
    solanaRpcUrl: PresaleSetting<string>;
    /** At least one of base, arbitrum and ethereum. */
    evmRpcUrls: PresaleSetting<Readonly<Partial<Record<PresaleEvmChain, string>>>>;
  }>;
  swap: Readonly<{
    providers: PresaleSetting<readonly string[]>;
    slippageBps: PresaleSetting<number>;
  }>;
  /** Decimal MIST kept back for gas; convert with `BigInt`. */
  gasReserveMist: PresaleSetting<string>;
  defaultTheme: PresaleSetting<PresaleTheme>;
  links: Readonly<{
    apply: PresaleSetting<string>;
    notify: PresaleSetting<string>;
    buySui: PresaleSetting<string>;
  }>;
  privyAppId: PresaleSetting<string>;
}>;

export type PresaleClientConfig = Omit<PresaleConfig, "bridge"> &
  Readonly<{ bridge: Readonly<{ enabled: boolean }> }>;

export function presaleClientConfig(config: PresaleConfig): PresaleClientConfig {
  return {
    network: config.network,
    bridge: { enabled: config.bridge.enabled },
    swap: config.swap,
    gasReserveMist: config.gasReserveMist,
    defaultTheme: config.defaultTheme,
    links: config.links,
    privyAppId: config.privyAppId,
  };
}

/**
 * The Cetus aggregator API (`DEFAULT_AGG_V3_ENDPOINT` in
 * `@cetusprotocol/aggregator-sdk` 1.7.x). It routes mainnet swaps only.
 */
export const CETUS_AGGREGATOR_ORIGIN = "https://api-sui.cetus.zone";

const MAX_U64 = (1n << 64n) - 1n;
// Rejects CSP wildcards and anything else that is not a plain host name.
const PLAIN_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function available<T>(value: T): PresaleSetting<T> {
  return { status: "available", value };
}

function unavailable<T>(variable: PresaleConfigVariable, reason: PresaleUnavailableReason): PresaleSetting<T> {
  return { status: "unavailable", variable, reason };
}

function setting<T>(
  environment: Environment,
  variable: PresaleConfigVariable,
  parse: (raw: string) => T | null,
  fallback?: T,
): PresaleSetting<T> {
  const raw = environment[variable]?.trim();
  if (!raw) return fallback === undefined ? unavailable(variable, "missing") : available(fallback);
  const value = parse(raw);
  return value === null ? unavailable(variable, "invalid") : available(value);
}

/** An `https` URL on a plain host, with no credentials or fragment. */
function webUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" && PLAIN_HOST.test(url.hostname);
  if (!secure || url.username || url.password || url.hash) return null;
  return url;
}

function evmRpcUrls(raw: string): Partial<Record<PresaleEvmChain, string>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  if (entries.length === 0) return null;
  const urls: Partial<Record<PresaleEvmChain, string>> = {};
  for (const [chain, value] of entries) {
    if (!(PRESALE_EVM_CHAINS as readonly string[]).includes(chain) || typeof value !== "string") return null;
    const url = webUrl(value);
    if (!url) return null;
    urls[chain as PresaleEvmChain] = url.href;
  }
  return urls;
}

function swapProviders(raw: string): string[] | null {
  const providers = [...new Set(raw.split(",").map((provider) => provider.trim()))];
  return providers.every((provider) => /^[A-Z][A-Z0-9_]*$/.test(provider)) ? providers : null;
}

function integerInRange(raw: string, min: bigint, max: bigint): bigint | null {
  if (!/^\d{1,20}$/.test(raw)) return null;
  const value = BigInt(raw);
  return value >= min && value <= max ? value : null;
}

function oneOf<T extends string>(values: readonly T[]) {
  return (raw: string): T | null => ((values as readonly string[]).includes(raw) ? (raw as T) : null);
}

/** Validates the presale's configuration from `environment`. Pure; never throws. */
export function readPresaleConfig(environment: Environment): PresaleConfig {
  const url = (raw: string) => webUrl(raw)?.href ?? null;

  return {
    network: setting(environment, "BLAST_NETWORK", oneOf(PRESALE_NETWORKS)),
    bridge: {
      enabled: environment.NEXT_PUBLIC_PRESALE_BRIDGE_ENABLED === "1",
      solanaRpcUrl: setting(environment, "NEXT_PUBLIC_PRESALE_SOLANA_RPC_URL", url),
      evmRpcUrls: setting(environment, "NEXT_PUBLIC_PRESALE_EVM_RPC_URLS", evmRpcUrls),
    },
    swap: {
      providers: setting(environment, "NEXT_PUBLIC_PRESALE_SWAP_PROVIDERS", swapProviders, ["CETUS"]),
      slippageBps: setting(
        environment,
        "NEXT_PUBLIC_PRESALE_SWAP_SLIPPAGE_BPS",
        (raw) => {
          const bps = integerInRange(raw, 1n, 10_000n);
          return bps === null ? null : Number(bps);
        },
        50,
      ),
    },
    gasReserveMist: setting(
      environment,
      "NEXT_PUBLIC_PRESALE_GAS_RESERVE_MIST",
      (raw) => integerInRange(raw, 0n, MAX_U64)?.toString() ?? null,
      "50000000",
    ),
    defaultTheme: setting(environment, "NEXT_PUBLIC_PRESALE_DEFAULT_THEME", oneOf(PRESALE_THEMES), "system"),
    links: {
      apply: setting(environment, "NEXT_PUBLIC_PRESALE_APPLY_URL", url),
      notify: setting(environment, "NEXT_PUBLIC_PRESALE_NOTIFY_URL", url),
      buySui: setting(environment, "NEXT_PUBLIC_PRESALE_BUY_SUI_URL", url),
    },
    privyAppId: setting(environment, "PRIVY_APP_ID", (raw) => raw),
  };
}

/**
 * The origins browsers may connect to for the presale on mainnet: the Sui
 * fullnode, the Cetus aggregator, and the Solana and EVM RPCs while the
 * bridge rail is on. Never blast-infra: the browser reaches it only through
 * this app's routes. No wildcards: every configured RPC host passed `PLAIN_HOST`.
 */
export function presaleConnectSources(config: PresaleConfig): string[] {
  const sources: string[] = [];
  if (config.network.status === "available") {
    sources.push(SUI_MAINNET_GRPC_URL);
    if (config.swap.providers.status === "available" && config.swap.providers.value.includes("CETUS")) {
      sources.push(CETUS_AGGREGATOR_ORIGIN);
    }
  }
  if (config.bridge.enabled) {
    if (config.bridge.solanaRpcUrl.status === "available") sources.push(new URL(config.bridge.solanaRpcUrl.value).origin);
    if (config.bridge.evmRpcUrls.status === "available") {
      for (const rpc of Object.values(config.bridge.evmRpcUrls.value)) sources.push(new URL(rpc).origin);
    }
  }
  return [...new Set(sources)];
}
