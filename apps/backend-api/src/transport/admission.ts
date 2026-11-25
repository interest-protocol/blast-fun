import type { PRIVATE_ROUTES } from "@blast/core/modules/backend-api/private-routes.ts";
import { observeAdmission, observeTransportBusy } from "./metrics.ts";
import { createPrivateAdmission } from "./private-admission.ts";

import type { BackendHttpOptions } from "./contracts.ts";
import type { RequestTarget } from "./request.ts";
import { refusal } from "./responses.ts";

export function createTransportAdmission(options: BackendHttpOptions) {
  if (
    options.maxPrivateWorkMs !== undefined &&
    (!Number.isInteger(options.maxPrivateWorkMs) ||
      options.maxPrivateWorkMs < 1 ||
      options.maxPrivateWorkMs > 280_000)
  ) {
    throw new Error("Invalid transport private work cap.");
  }
  const maxInflight = options.maxInflight ?? 64;
  const maxAdminInflight = options.maxAdminInflight ?? Math.min(4, maxInflight);
  if (
    !Number.isInteger(maxInflight) ||
    maxInflight < 1 ||
    maxInflight > 256 ||
    !Number.isInteger(maxAdminInflight) ||
    maxAdminInflight < 1 ||
    maxAdminInflight > Math.min(16, maxInflight)
  ) {
    throw new Error("Invalid transport admission limits.");
  }
  const partnerReserved = options.partnerReservedInflight ?? 0;
  if (
    !Number.isInteger(partnerReserved) ||
    partnerReserved < 0 ||
    (partnerReserved > 0 && partnerReserved >= maxInflight - maxAdminInflight)
  ) {
    throw new Error("Partner reservations must leave anonymous/private and admin capacity.");
  }
  let inflight = 0;
  let otherInflight = 0;
  let adminInflight = 0;
  let cronInflight = 0;
  let healthInflight = 0;
  const reservePrivateLane = createPrivateAdmission(maxInflight - partnerReserved);
  let draining = false;
  let drained: Promise<void> | undefined;
  let finishDrain: (() => void) | undefined;

  return {
    reservePartner() {
      if (draining) {
        throw refusal(503, "busy");
      }
      inflight++;
      return releaseInflight;
    },
    reserveReadiness() {
      if (draining || healthInflight >= 8) {
        observeTransportBusy("readiness", draining);
        throw refusal(503, "busy");
      }
      healthInflight++;
      inflight++;
      observeAdmission("readiness", "admitted");
      return () => {
        healthInflight--;
        releaseInflight();
      };
    },
    reserveOrdinary(target: RequestTarget, pendingRequests: number) {
      if (
        draining ||
        otherInflight >= maxInflight - partnerReserved ||
        (!options.preparePartner && pendingRequests > maxInflight) ||
        (target.operator && adminInflight >= maxAdminInflight) ||
        (target.cronContract && cronInflight >= 2)
      ) {
        observeTransportBusy("ordinary", draining);
        throw refusal(503, "busy");
      }
      inflight++;
      otherInflight++;
      if (target.operator) {
        adminInflight++;
      }
      if (target.cronContract) {
        cronInflight++;
      }
      observeAdmission("ordinary", "admitted");
      return {
        release() {
          otherInflight--;
          if (target.operator) {
            adminInflight--;
          }
          if (target.cronContract) {
            cronInflight--;
          }
          releaseInflight();
        },
      };
    },
    reservePrivate(route: (typeof PRIVATE_ROUTES)[number]) {
      return reservePrivateLane(route);
    },
    isDraining() {
      return draining;
    },
    drain(): Promise<void> {
      draining = true;
      drained ??=
        inflight === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              finishDrain = resolve;
            });
      return drained;
    },
  };

  function releaseInflight() {
    inflight--;
    if (draining && inflight === 0) {
      finishDrain?.();
    }
  }
}

export type TransportAdmission = ReturnType<typeof createTransportAdmission>;
