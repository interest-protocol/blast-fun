import { attestClientAddress, type ClientAddress } from "../../../../src/lib/web-security/client-address.ts";

/** The client an entry point attests for `address`; throws on a value no entry point would accept. */
export function testClient(address = "203.0.113.7"): ClientAddress {
  const client = attestClientAddress(address);
  if (!client) throw new TypeError(`Not a single IP address: ${address}`);
  return client;
}
