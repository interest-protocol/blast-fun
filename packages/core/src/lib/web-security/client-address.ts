import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { canonicalAddress } from "./ingress.ts";

declare const attested: unique symbol;

/**
 * The client one backend entry point verified: the private relay's signed
 * proof or the gateway/peer address. Only `attestClientAddress` makes one,
 * so a handler holding it never re-reads a forwarded header.
 */
export type ClientAddress = Readonly<{
  /** One canonical address: what signing, recognition and admission compare. */
  address: string;
  /** The rate-limit subject's `ip`: IPv4 as is, IPv6 as its /64. */
  rateKey: string;
  [attested]: true;
}>;

/** The attested client for one address, or null when it is not a single IP address. */
export function attestClientAddress(value: string | null): ClientAddress | null {
  const address = canonicalAddress(value);
  const rateKey = address && rateLimitAddress(address);
  return address && rateKey ? (Object.freeze({ address, rateKey }) as ClientAddress) : null;
}

/** The rate-limit subject for one textual address, or null when it is not an IP address. */
export function rateLimitAddress(value: string): string | null {
  if (value.length > 64) return null;
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;
  const address = value.split("%", 1)[0]!;
  const parsed = ipaddr.IPv6.parse(address);
  return parsed.isIPv4MappedAddress()
    ? parsed.toIPv4Address().toString()
    : `${parsed.parts.slice(0, 4).map((part) => part.toString(16)).join(":")}::/64`;
}
