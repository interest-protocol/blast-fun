import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

type Address = ipaddr.IPv4 | ipaddr.IPv6;
type Network = readonly [Address, number];
export type IngressTrust = Readonly<{ mode: "direct" }> | Readonly<{ mode: "trusted-proxy"; networks: readonly Network[] }>;
type Environment = Readonly<Record<string, string | undefined>>;

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
  // Wide internal/platform ranges would trust unrelated tenants. Deployment must
  // supply the narrow actual ingress ranges; nothing implicitly trusts private IPs.
  if (prefix < (maximum === 32 ? 24 : 64) || prefix > maximum) throw new Error("Trusted proxy CIDRs must be narrow IPv4 /24+ or IPv6 /64+ ranges.");
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

/** A trusted proxy must overwrite X-Forwarded-For with exactly one address. */
export function ingressAddress(request: Request, peer: string | null, trust: IngressTrust): string | null {
  const canonical = canonicalAddress(peer);
  if (!canonical) return null;
  if (trust.mode === "direct") return canonical;
  const address = ipaddr.parse(canonical);
  if (!trust.networks.some(([network, prefix]) => address.kind() === network.kind() && address.match(network, prefix))) return null;
  return canonicalAddress(request.headers.get("x-forwarded-for"));
}
