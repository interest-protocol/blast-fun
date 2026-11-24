import type { PartnerCapacity } from "./capacity.ts";
import { RecognitionUnavailable } from "./recognition-store.ts";

type Waiter = {
  signal: AbortSignal;
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  abort: () => void;
};
type TenantQueue = { keys: Map<string, Waiter[]>; lastKey?: string };

/** Two primary workers; fair tenant/key quanta and bounded aggregate queues. */
export class PartnerScheduler {
  #active = 0;
  #cursor = 0;
  #queues = new Map<string, TenantQueue>();
  #activeByTenant = new Map<string, number>();
  #lanes = new Map<string, number>();
  #internal = 0;
  #classifier = 0;
  readonly capacity: PartnerCapacity;
  constructor(capacity: PartnerCapacity) {
    this.capacity = capacity;
    for (const tenant of capacity.tenants)
      this.#queues.set(tenant.id, { keys: new Map() });
  }
  classifier(): () => void {
    if (this.#classifier >= this.capacity.classifierInflight)
      throw new RecognitionUnavailable();
    this.#classifier++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#classifier--;
      }
    };
  }
  lane(tenantId: string, internal = false): () => void {
    const tenant = this.capacity.tenants.find((item) => item.id === tenantId);
    if (!tenant) throw new RecognitionUnavailable();
    const count = internal ? this.#internal : (this.#lanes.get(tenantId) ?? 0);
    const maximum = internal
      ? this.capacity.internalMaxInflight
      : tenant.maxInflight;
    if (count >= Math.floor(maximum / this.capacity.maxReplicas))
      throw new RecognitionUnavailable();
    if (internal) this.#internal++;
    else this.#lanes.set(tenantId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (internal) {
        this.#internal--;
        return;
      }
      const remaining = (this.#lanes.get(tenantId) ?? 1) - 1;
      if (remaining) this.#lanes.set(tenantId, remaining);
      else this.#lanes.delete(tenantId);
    };
  }
  run<T>(
    tenantId: string,
    keyId: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const tenant = this.capacity.tenants.find((item) => item.id === tenantId);
    const tenantQueue = this.#queues.get(tenantId);
    if (!tenant || !tenantQueue || signal.aborted)
      return Promise.reject(new RecognitionUnavailable());
    const queued = [...tenantQueue.keys.values()].reduce(
      (sum, queue) => sum + queue.length,
      0,
    );
    const keyQueue = tenantQueue.keys.get(keyId) ?? [];
    // One key cannot occupy every waiting slot. Distinct keys never multiply the tenant bound.
    if (
      queued >= tenant.queueLimit ||
      keyQueue.length >= Math.max(1, Math.floor(tenant.queueLimit / 2))
    )
      return Promise.reject(new RecognitionUnavailable());
    return new Promise<T>((resolve, reject) => {
      const remove = () => {
        const index = keyQueue.indexOf(waiter);
        if (index < 0) return;
        keyQueue.splice(index, 1);
        if (!keyQueue.length) tenantQueue.keys.delete(keyId);
        this.#dispose(waiter);
        reject(new RecognitionUnavailable());
      };
      const waiter: Waiter = {
        signal,
        operation,
        resolve: (value) => resolve(value as T),
        reject,
        abort: remove,
        timer: setTimeout(remove, this.capacity.queueWaitMs),
      };
      signal.addEventListener("abort", remove, { once: true });
      tenantQueue.keys.set(keyId, keyQueue);
      keyQueue.push(waiter);
      this.#pump();
    });
  }
  #dispose(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.abort);
  }
  #next(tenantId: string): Waiter | undefined {
    const queue = this.#queues.get(tenantId)!;
    const keys = [...queue.keys.keys()];
    if (!keys.length) return;
    const index =
      queue.lastKey === undefined
        ? 0
        : (keys.indexOf(queue.lastKey) + 1) % keys.length;
    const key = keys[index];
    const waiting = queue.keys.get(key)!;
    const selected = waiting.shift();
    if (!waiting.length) queue.keys.delete(key);
    queue.lastKey = key;
    return selected;
  }
  #pump(): void {
    const tenants = this.capacity.tenants;
    while (this.#active < 2) {
      let selected: Waiter | undefined;
      let tenantId: string | undefined;
      for (let checked = 0; checked < tenants.length; checked++) {
        const tenant = tenants[this.#cursor++ % tenants.length];
        if (
          (this.#activeByTenant.get(tenant.id) ?? 0) >=
          Math.floor(tenant.maxInflight / this.capacity.maxReplicas)
        )
          continue;
        selected = this.#next(tenant.id);
        if (selected) {
          tenantId = tenant.id;
          break;
        }
      }
      if (!selected || tenantId === undefined) return;
      this.#dispose(selected);
      if (selected.signal.aborted) {
        selected.reject(new RecognitionUnavailable());
        continue;
      }
      this.#active++;
      const owner = tenantId;
      this.#activeByTenant.set(
        owner,
        (this.#activeByTenant.get(owner) ?? 0) + 1,
      );
      const waiter = selected;
      Promise.resolve()
        .then(waiter.operation)
        .then(waiter.resolve, waiter.reject)
        .finally(() => {
          this.#active--;
          this.#activeByTenant.set(
            owner,
            (this.#activeByTenant.get(owner) ?? 1) - 1,
          );
          this.#pump();
        });
    }
  }
  snapshot(): {
    active: number;
    queued: number;
    lanes: number;
    internal: number;
    classifier: number;
  } {
    return {
      active: this.#active,
      queued: [...this.#queues.values()].reduce(
        (sum, tenant) =>
          sum +
          [...tenant.keys.values()].reduce((n, queue) => n + queue.length, 0),
        0,
      ),
      lanes: [...this.#lanes.values()].reduce((sum, count) => sum + count, 0),
      internal: this.#internal,
      classifier: this.#classifier,
    };
  }
}
