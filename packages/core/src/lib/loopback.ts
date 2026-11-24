const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];

/** The three loopback names, as `URL.hostname` spells them; other 127/8 addresses are not among them. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.includes(hostname);
}
