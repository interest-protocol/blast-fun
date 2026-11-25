import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

type Address = ipaddr.IPv4 | ipaddr.IPv6;
type Network = readonly [Address, number];
export type IngressTrust = Readonly<{ mode: "direct" }> | Readonly<{ mode: "trusted-proxy"; networks: readonly Network[] }>;
type Environment = Readonly<Record<string, string | undefined>>;

/** Render's edge proxies sit in 10.24.0.0/13 and move between /24s, so ranges inside 10/8 may be as wide as /13. */
const PRIVATE_PROXY_SPACE = ipaddr.parseCIDR("10.0.0.0/8");
const PRIVATE_PROXY_MIN_PREFIX = 13;

/** One address, never a forwarded chain, zone identifier or permissively parsed IPv4. */
export function canonicalAddress(value: string | null): string | null {
  if (!value || value.includes("%") || !isIP(value)) return null;
  const parsed = ipaddr.parse(value);
  return parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()
    ? (parsed as ipaddr.IPv6).toIPv4Address().toString() : parsed.toString();
}

function proxyNetwork(value: string): Network {
  const [address, width, ...extra] = value.split("/");
  const canonical = canonicalAddress(address ?? null);
  if (!canonical || extra.length || (width !== undefined && !/^\d{1,3}$/.test(width))) throw new Error("Invalid trusted proxy CIDR.");
  const original = ipaddr.parse(address!);
  const mapped = original.kind() === "ipv6" && (original as ipaddr.IPv6).isIPv4MappedAddress();
  const parsed = ipaddr.parse(canonical);
  const maximum = parsed.kind() === "ipv4" ? 32 : 128;
  const prefix = width === undefined ? maximum : Number(width) - (mapped ? 96 : 0);
  // A trusted range can set any client key, so deployment supplies the actual ingress ranges and
  // nothing implicitly trusts private IPs. A /13 inside 10/8 assumes that space carries only the
  // platform's edge proxies; the Render probe saw nothing else there (live-data-delivery.md).
  let minimum = 64;
  if (parsed.kind() === "ipv4") minimum = parsed.match(PRIVATE_PROXY_SPACE) ? PRIVATE_PROXY_MIN_PREFIX : 24;
  if (prefix < minimum || prefix > maximum) throw new Error("Trusted proxy CIDRs must be IPv4 /24+ (/13+ inside 10.0.0.0/8) or IPv6 /64+ ranges.");
  return [parsed, prefix];
}

export function ingressTrust(environment: Environment): IngressTrust {
  const mode = environment.BLAST_BACKEND_INGRESS_MODE;
  const raw = environment.BLAST_BACKEND_TRUSTED_PROXY_CIDRS ?? "";
  if (mode === "direct" && !raw.trim()) return { mode };
  if (mode !== "trusted-proxy" || !raw.trim()) throw new Error("Choose explicit direct ingress or trusted-proxy ingress with CIDRs.");
  const values = raw.split(",").map((value) => value.trim());
  if (values.length > 32 || values.some((value) => !value || value.length > 64)) throw new Error("Invalid trusted proxy CIDRs.");
  return { mode, networks: values.map(proxyNetwork) };
}

/**
 * The trusted proxy appends the client it saw as the last X-Forwarded-For entry.
 * Earlier entries come from the client and are ignored, so they cannot change the key.
 */
export function ingressAddress(request: Request, peer: string | null, trust: IngressTrust): string | null {
  const canonical = canonicalAddress(peer);
  if (!canonical) return null;
  if (trust.mode === "direct") return canonical;
  const address = ipaddr.parse(canonical);
  if (!trust.networks.some(([network, prefix]) => address.kind() === network.kind() && address.match(network, prefix))) return null;
  const last = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? null;
  return canonicalAddress(last);
}
