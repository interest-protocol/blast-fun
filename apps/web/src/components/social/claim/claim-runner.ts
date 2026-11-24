import { addExact, compareExact, exactDecimal, type Exact } from "@blast/core/web/exact-amount.ts";
import { CLAIM_IDLE, claimCanRetry, claimSettled, type ClaimPath, type ClaimTarget, type ClaimView } from "./claims";
import type { Claims } from "./use-claims";

/** No claim path: no claim button renders. */
export const NO_CLAIMS: Claims = Object.freeze({ available: false, supports: () => false, view: () => CLAIM_IDLE, run: () => undefined });

/** After every answer, confirmed or not: read the positions and the log again, toast a success. */
export type ClaimSettled = (target: ClaimTarget, view: ClaimView, retry?: () => void) => void;

export type ClaimRunner = Readonly<{
  view: (key: string, claimed?: string, received?: string) => ClaimView;
  run: (target: ClaimTarget, settled?: ClaimSettled) => void;
  pending: () => ReadonlyMap<string, ClaimTarget & { digest: string }>;
  acknowledge: (key: string, digest: string) => void;
  /** The views as one value, which changes whenever any claim moves. */
  snapshot: () => ReadonlyMap<string, ClaimView>;
  subscribe: (listener: () => void) => () => void;
  /** Aborts every running claim; nothing it answers later is shown, and nothing new runs until `resume`. */
  dispose: () => void;
  /** Runs again after `dispose` (a development remount of the same screen). */
  resume: () => void;
  /** What runs after each answer (the host's reads and toast), replaced as the host re-renders. */
  onSettled: (settled: ClaimSettled | undefined) => void;
}>;

/**
 * The claims' state over a `ClaimPath`, outside React so its rules are a
 * test: one run per key at a time (a second press while it runs does
 * nothing); a path that throws is a refusal with its own published code,
 * never a silent stop; a refusal keeps the view until the next try; disposing
 * aborts what is running.
 */
export function createClaimRunner(path: ClaimPath, initial?: ClaimSettled): ClaimRunner {
  let settled = initial;
  let views: ReadonlyMap<string, ClaimView> = new Map();
  const running = new Map<string, AbortController>();
  const pending = new Map<string, ClaimTarget & { digest: string }>();
  const completed = new Map<string, { view: Extract<ClaimView, { state: "done" }>; claimed: Exact | null; received?: string }>();
  const listeners = new Set<() => void>();
  let disposed = false;
  const publish = (key: string, view: ClaimView) => {
    views = new Map(views).set(key, view);
    for (const listener of listeners) listener();
  };
  const readView = (key: string, claimed?: string, received?: string): ClaimView => {
    const view = views.get(key) ?? CLAIM_IDLE;
    const previous = completed.get(key);
    if (collectionReceiptAdvanced(previous?.received,received) && view.state === "done") return CLAIM_IDLE;
    if (previous?.claimed && claimed !== undefined) {
      const indexed = exactDecimal(claimed);
      // Keep the previous confirmation over older snapshots, even after a later attempt fails.
      if (indexed === null || compareExact(indexed, previous.claimed) < 0) return previous.view;
      if (view.state === "done") return CLAIM_IDLE;
    }
    return view;
  };
  const runner: ClaimRunner = {
    view: readView,
    pending: () => pending,
    acknowledge: (key, digest) => { if (pending.get(key)?.digest === digest) pending.delete(key); },
    snapshot: () => views,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run: (target, answered) => {
      if (disposed || running.has(target.key) || readView(target.key, target.vesting?.claimed, target.collection?.received).state === "done") return;
      const controller = new AbortController();
      running.set(target.key, controller);
      publish(target.key, { state: "claiming" });
      let answer: Promise<Awaited<ReturnType<ClaimPath>> | null>;
      try {
        answer = path(target, controller.signal).catch(() => null);
      } catch {
        answer = Promise.resolve(null);
      }
      void answer.then((outcome) => {
        if (controller.signal.aborted || disposed) return;
        running.delete(target.key);
        const view = claimSettled(outcome);
        if (view.state === "done") {
          completed.set(target.key, { view, claimed: claimedAfter(target), received: target.collection?.received });
          pending.set(target.key, { ...target, digest: view.digest });
        }
        publish(target.key, view);
        const retry = claimCanRetry(view) ? () => {
          if (views.get(target.key) === view) runner.run(target, answered);
        } : undefined;
        (answered ?? settled)?.(target, view, retry);
      });
    },
    dispose: () => {
      disposed = true;
      for (const controller of running.values()) controller.abort();
      running.clear();
    },
    resume: () => {
      disposed = false;
    },
    onSettled: (next) => {
      settled = next;
    },
  };
  return runner;
}

/** Cumulative payments must increase; stale reads and decimal formatting never unlock a retry. */
export function collectionReceiptAdvanced(before: string | undefined, after: string | undefined): boolean {
  const oldParts = before?.split(":");
  const newParts = after?.split(":");
  if (oldParts?.length !== 2 || newParts?.length !== 2) return false;
  const comparisons = oldParts.map((part,index) => {
    const previous = exactDecimal(part);
    const current = exactDecimal(newParts[index]);
    return previous !== null && current !== null ? compareExact(current,previous) : null;
  });
  return comparisons.every((value) => value !== null && value >= 0) && comparisons.some((value) => value !== null && value > 0);
}

/** Minimum cumulative amount proving this vesting claim's displayed allocation was indexed. */
export function claimedAfter(target: ClaimTarget): Exact | null {
  const before = exactDecimal(target.vesting?.claimed);
  const amount = exactDecimal(target.vesting?.claimable);
  if (before === null || amount === null || amount.n === 0n) return null;
  return addExact(before, amount);
}
