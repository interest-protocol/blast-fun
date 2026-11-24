import type { TransportAdmission } from "./admission.ts";
import { requestLifetime } from "./lifetime.ts";
import { unavailableCode } from "./responses.ts";

/** Coalesce probes and retain passing results for 5 s, failures for 1 s. */
export function createHealthProbe(ready: () => Promise<boolean>) {
  let health: Promise<boolean> | undefined;
  let healthAt = 0;
  let healthPending = false;
  let healthPassed = false;

  // A passing probe is reused for 5 s; a failing one for 1 s, so a recovered
  // replica rejoins promptly while repeated probes still run at most once a second.
  function healthy(): Promise<boolean> {
    const reuseMs = healthPassed ? 5_000 : 1_000;
    if (!health || (!healthPending && Date.now() - healthAt > reuseMs)) {
      healthAt = Date.now();
      healthPending = true;
      health = Promise.resolve()
        .then(ready)
        .catch(() => false)
        .then((passed) => {
          healthPassed = passed;
          return passed;
        })
        .finally(() => {
          healthPending = false;
        });
    }
    return health;
  }

  return healthy;
}

export function createTransportReadiness(
  path: string,
  handler: (request: Request) => Promise<Response>,
  admission: TransportAdmission,
) {
  // A coalesced dependency probe has its own bounded admission lane. Ordinary
  // saturation must not mark a healthy replica unavailable to its load balancer.
  return function readiness(request: Request): Promise<Response> {
    const release = admission.reserveReadiness();
    const lifetime = requestLifetime(request, release, unavailableCode(path));
    const operation = handler(request).then(lifetime.responseBody).catch(lifetime.failed);
    return Promise.race([operation, lifetime.aborted]);
  };
}
