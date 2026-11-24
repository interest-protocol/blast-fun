import type { PRIVATE_ROUTES } from "@blast/core/modules/backend-api/private-routes.ts";
import { ACTIVITY_HINT_STREAM_BUDGET } from "@blast/core/modules/backend-api/stream-budget.ts";
import { MARKET_STREAM_ROUTE_ID } from "@blast/core/modules/launchpad-contract/market-stream.ts";
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
  const streamDrainMs = options.streamDrainMs ?? 0;
  if (!Number.isInteger(streamDrainMs) || streamDrainMs < 0 || streamDrainMs > 30_000) {
    throw new Error("Invalid connected stream drain window.");
  }
  const maxInflight = options.maxInflight ?? 64;
  const maxAdminInflight = options.maxAdminInflight ?? Math.min(4, maxInflight);
  const maxHintStreams = options.maxHintStreams ?? ACTIVITY_HINT_STREAM_BUDGET.defaultClients;
  if (
    !Number.isInteger(maxHintStreams) ||
    maxHintStreams < 1 ||
    maxHintStreams > ACTIVITY_HINT_STREAM_BUDGET.maxClients
  ) {
    throw new Error("Invalid connected activity stream capacity.");
  }
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
  let hintStreamsInflight = 0;
  let connectedHintStreams = 0;
  const connectedHintAborts = new Set<(reason: unknown) => void>();
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
        (!options.preparePartner && pendingRequests - connectedHintStreams > maxInflight) ||
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
      let ordinaryPermitHeld = true;
      let hintConnected = false;

      function disconnectHint() {
        if (!hintConnected) {
          return;
        }
        hintConnected = false;
        connectedHintStreams--;
      }

      return {
        connectHint(abort: (reason: unknown) => void, signal: AbortSignal) {
          if (signal.aborted) {
            return;
          }
          if (draining) {
            abort(new Error("Backend is draining connected streams."));
            return;
          }
          connectedHintAborts.add(abort);
          connectedHintStreams++;
          hintConnected = true;
          signal.addEventListener("abort", disconnect, { once: true });
          otherInflight--;
          ordinaryPermitHeld = false;
          return disconnect;

          function disconnect() {
            disconnectHint();
            connectedHintAborts.delete(abort);
            signal.removeEventListener("abort", disconnect);
          }
        },
        release() {
          if (ordinaryPermitHeld) {
            otherInflight--;
          }
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
      if (route.id !== "social.activity.hints" && route.id !== MARKET_STREAM_ROUTE_ID) {
        return reservePrivateLane(route);
      }
      if (hintStreamsInflight >= maxHintStreams) {
        observeAdmission("hint", "busy", { cause: "capacity" });
        throw refusal(503, "busy");
      }
      hintStreamsInflight++;
      observeAdmission("hint", "admitted");
      return () => {
        hintStreamsInflight--;
      };
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
      for (const abort of [...connectedHintAborts]) {
        const close = () => abort(new Error("Backend is draining connected streams."));
        if (streamDrainMs === 0) {
          close();
        } else {
          setTimeout(close, Math.floor(Math.random() * streamDrainMs));
        }
      }
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
