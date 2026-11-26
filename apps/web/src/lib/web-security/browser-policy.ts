import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";
import { CETUS_ROUTER_ORIGIN } from "@blast/core/modules/social/trades/cetus-route.ts";

const PRIVY_AUTH_ORIGIN = "https://auth.privy.io";
const PRIVY_API_ORIGIN = "https://api.privy.io";
const WALLETCONNECT_EXPLORER_ORIGIN = "https://explorer-api.walletconnect.com";
// Privy's bot protection (Cloudflare Turnstile), when enabled in its dashboard.
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Sources Privy's CSP guide requires beyond its own origins:
 * https://docs.privy.io/security/implementation-guide/content-security-policy
 * This policy allows inline styles by nonce or exact hash and keeps scripts
 * on 'strict-dynamic'.
 */
const PRIVY_CONNECT_SOURCES = [
  "wss://relay.walletconnect.com",
  "wss://relay.walletconnect.org",
  "wss://www.walletlink.org",
  "https://*.rpc.privy.systems",
] as const;
const PRIVY_FRAME_SOURCES = [
  PRIVY_AUTH_ORIGIN,
  "https://verify.walletconnect.com",
  "https://verify.walletconnect.org",
  TURNSTILE_ORIGIN,
] as const;

/**
 * OA-30: the stylesheet sonner 2.0.8 inserts as an un-nonced `<style>` when
 * its module loads, allowed by its hash so the browser applies it and reports
 * nothing. sonner appends the element empty and then fills it, and the
 * browser checks each, so the empty text's hash is listed too; an empty sheet
 * holds no rule, and any other text is still refused. `web-security.test.ts`
 * hashes the installed sonner, so an upgrade that changes the sheet fails it.
 */
export const SONNER_STYLE_HASHES = [
  "'sha256-StEaX+se6YS7pqjzrzMIA0KaX9zF/8zAhvQXZAe5epY='",
  "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='",
] as const;

// Privy's MetaMask SVG uses a <style> element for the fox's fills and strokes.
// style-hashes.test.ts checks this hash against the installed SDK.
const PRIVY_METAMASK_STYLE_HASH = "'sha256-QlwpTd7Ve6xx/zCJuRcdEKxpvG41xq7uvysQt5tkwaY='";

function assertNonce(nonce: string): void {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) {
    throw new TypeError("CSP nonce must be unguessable base64url data.");
  }
}

/** Each source is a scheme and a host with an optional port: no wildcard, credentials, path, query or fragment. */
function assertPlainSources(sources: readonly string[]): void {
  for (const source of sources) {
    if (!/^(https|wss|http|ws):\/\/[^*\s;,/?#@]+$/.test(source)) {
      throw new TypeError(`CSP source must be a plain origin without wildcards: ${source}`);
    }
  }
}

/**
 * `nonce: null` is for prerendered pages, which cannot carry a per-request
 * nonce, so they allow inline scripts and styles. Only pages built entirely
 * from source content (the legal pages) may use it. Inline sources replace
 * the nonce in script-src and style-src, and allow style attributes; every
 * other directive is the same.
 */
export function createContentSecurityPolicy(input: {
  nonce: string | null;
  development?: boolean;
  /** The presale's origins for the configured network (`presaleConnectSources`), while it is on. */
  presaleConnectSources?: readonly string[];
  /** Mayan and the source-chain RPCs (`bridgeConnectSources`), while the Bridge to Sui card is on. */
  bridgeConnectSources?: readonly string[];
  /** The direct market socket's origin (`wss://…`), while it is configured. */
  liveSocketOrigin?: string | null;
}): string {
  if (input.nonce !== null) assertNonce(input.nonce);
  const presaleSources = input.presaleConnectSources ?? [];
  assertPlainSources(presaleSources);
  const bridgeSources = input.bridgeConnectSources ?? [];
  assertPlainSources(bridgeSources);
  const liveSources = input.liveSocketOrigin ? [input.liveSocketOrigin] : [];
  assertPlainSources(liveSources);
  const inline = input.nonce === null ? "'unsafe-inline'" : `'nonce-${input.nonce}'`;
  const script = ["'self'", inline];
  if (input.nonce !== null) script.push("'strict-dynamic'");
  script.push(PRIVY_AUTH_ORIGIN, TURNSTILE_ORIGIN);
  if (input.development) script.push("'unsafe-eval'");

  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    // A hash beside 'unsafe-inline' would disable it, so the prerendered
    // policy omits the hashes.
    input.nonce === null
      ? `style-src 'self' ${inline}`
      : `style-src 'self' ${inline} ${SONNER_STYLE_HASHES.join(" ")} ${PRIVY_METAMASK_STYLE_HASH}`,
    // Next/image emits this exact style attribute during SSR.
    input.nonce === null
      ? "style-src-attr 'unsafe-inline'"
      : "style-src-attr 'unsafe-hashes' 'sha256-zlqnbDt84zf1iSefLU/ImC54isoprH/MRiVZGskwexk='",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    [
      // A presale or bridge source may repeat another (the fullnode, a shared RPC); each is listed once.
      ...new Set([
        "connect-src 'self'",
        PRIVY_AUTH_ORIGIN,
        PRIVY_API_ORIGIN,
        SUI_MAINNET_GRPC_URL,
        // The swap estimate asks Cetus's aggregator from the browser (`trade-estimate.ts`), presale on or off.
        CETUS_ROUTER_ORIGIN,
        WALLETCONNECT_EXPLORER_ORIGIN,
        ...PRIVY_CONNECT_SOURCES,
        TURNSTILE_ORIGIN,
        ...presaleSources,
        ...bridgeSources,
        ...liveSources,
      ]),
    ].join(" "),
    `frame-src ${PRIVY_FRAME_SOURCES.join(" ")}`,
    `child-src ${PRIVY_FRAME_SOURCES.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "media-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function securityHeaders(input: {
  nonce: string | null;
  development?: boolean;
  presaleConnectSources?: readonly string[];
  bridgeConnectSources?: readonly string[];
  liveSocketOrigin?: string | null;
}): Readonly<Record<string, string>> {
  return {
    "Content-Security-Policy": createContentSecurityPolicy(input),
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}
