import { MARKET_STREAM_PATH } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { privateBackendRelay } from "@blast/server/private/relay.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";

type Environment = Readonly<Record<string, string | undefined>>;
type Relay = ReturnType<typeof privateBackendRelay>;

const STREAMS = new Set(["/api/social/activity/hints", MARKET_STREAM_PATH]);

/**
 * The web relay against one test backend playing both deployed roles: other
 * calls signed as the API's and streams as the isolated hints process's
 * (`BLAST_BACKEND_HINTS_*`), both under the backend's one gateway secret. The
 * relay requires the two secrets to differ, so streams carry an unused API one.
 */
export function relayToOneBackend(
  environment: Environment,
  dependencies: Parameters<typeof privateBackendRelay>[1],
): Relay {
  const secret = environment.BLAST_BACKEND_GATEWAY_SECRET!;
  const ordinary = privateBackendRelay(parseRelayConfig(environment), dependencies);
  const streams = privateBackendRelay(
    parseRelayConfig({
      ...environment,
      BLAST_BACKEND_GATEWAY_SECRET: `${secret}-api-only`,
      BLAST_BACKEND_HINTS_ORIGIN: environment.BLAST_BACKEND_API_ORIGIN,
      BLAST_BACKEND_HINTS_GATEWAY_SECRET: secret,
    }),
    dependencies,
  );
  return (request, purpose) =>
    (STREAMS.has(new URL(request.url).pathname) ? streams : ordinary)(request, purpose);
}
