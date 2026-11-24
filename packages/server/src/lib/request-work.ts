import { AsyncLocalStorage } from "node:async_hooks";

export type AfterResponseReservation = Readonly<{
  attach(task: () => Promise<unknown>): void;
  release(): void;
}>;

type WorkOwner = {
  signal?: AbortSignal;
  track<T>(promise: Promise<T>): Promise<T>;
};
const owners = new AsyncLocalStorage<WorkOwner>();

/** Register the actual provider operation before racing its visible deadline. */
export function trackRequestWork<T>(promise: Promise<T>): Promise<T> {
  const owner = owners.getStore();
  if (!owner) {
    void promise.catch(() => {});
    throw new Error("Provider work requires an active ownership context.");
  }
  return owner.track(promise);
}

function workOwner() {
  const pending = new Set<Promise<void>>();
  let closed = false;
  let completion: Promise<void> | undefined;
  return {
    track<T>(promise: Promise<T>): Promise<T> {
      if (closed) {
        void promise.catch(() => {});
        throw new Error("Provider work ownership is closed.");
      }
      const observed = promise
        .then(
          () => {},
          () => {},
        )
        .finally(() => pending.delete(observed));
      pending.add(observed);
      return promise;
    },
    finish(): Promise<void> {
      return (completion ??= (async () => {
        // A tracked operation may register another operation before settling.
        while (pending.size) await Promise.all([...pending]);
        closed = true;
      })());
    },
  };
}

type Reservation = AfterResponseReservation & { start(): void };

/** Two reserved-or-running jobs, no queue. Accepted work survives stop(). */
export function createAfterResponseScheduler(onFailure: () => void = () => {}) {
  let accepting = true;
  let occupied = 0;
  const idle = new Set<() => void>();
  function relinquish() {
    occupied--;
    if (!occupied) {
      for (const resolve of idle) resolve();
      idle.clear();
    }
  }
  return {
    reserve(): Reservation | null {
      if (!accepting || occupied === 2) return null;
      occupied++;
      let state: "reserved" | "attached" | "running" | "released" = "reserved";
      let task: (() => Promise<unknown>) | undefined;
      return {
        attach(next) {
          if (state !== "reserved")
            throw new Error("Background reservation is not available.");
          task = next;
          state = "attached";
        },
        release() {
          if (state === "released") return;
          if (state !== "reserved")
            throw new Error("Attached background work cannot be discarded.");
          state = "released";
          relinquish();
        },
        start() {
          if (state === "reserved") {
            state = "released";
            relinquish();
            return;
          }
          if (state !== "attached") return;
          state = "running";
          const owner = workOwner();
          void owners.run(owner, async () => {
            try {
              await task!();
            } catch {
              // Labels and logs belong to composition; never expose task data.
              try {
                onFailure();
              } catch {
                /* Metrics cannot release ownership early. */
              }
            } finally {
              await owner.finish();
              state = "released";
              relinquish();
            }
          });
        },
      };
    },
    stop() {
      accepting = false;
    },
    drain(): Promise<void> {
      accepting = false;
      return occupied === 0
        ? Promise.resolve()
        : new Promise((resolve) => idle.add(resolve));
    },
    get active() {
      return occupied;
    },
  };
}

export type AfterResponseScheduler = ReturnType<
  typeof createAfterResponseScheduler
>;

/** Owned by one physical request, completed only after handler and body settle. */
export function createRequestWork(scheduler: AfterResponseScheduler) {
  const owner = workOwner();
  const reservations = new Set<Reservation>();
  let completing = false;
  let completion: Promise<void> | undefined;
  return {
    track: owner.track,
    reserveAfterResponse(): AfterResponseReservation | null {
      if (completing) throw new Error("Request work ownership is completing.");
      const reservation = scheduler.reserve();
      if (reservation) reservations.add(reservation);
      return reservation;
    },
    complete(): Promise<void> {
      if (completion) return completion;
      completing = true;
      return (completion = (async () => {
        await owner.finish();
        for (const reservation of reservations) reservation.start();
        reservations.clear();
      })());
    },
  };
}

export type RequestWork = ReturnType<typeof createRequestWork>;
export function runWithRequestWork<T>(
  scope: RequestWork,
  callback: () => T,
  signal?: AbortSignal,
): T {
  return owners.run({ ...scope, signal }, callback);
}

export function reserveAfterResponse(): AfterResponseReservation | null {
  const owner = owners.getStore();
  if (!owner || !("reserveAfterResponse" in owner)) {
    throw new Error("After-response work requires an active request.");
  }
  return (owner as RequestWork).reserveAfterResponse();
}

/** Read at provider invocation time; fresh background owners have no request signal. */
export function requestWorkSignal(): AbortSignal | undefined {
  return owners.getStore()?.signal;
}
