import { gatedFetch } from "#web/lib/api-gate-client.ts";

export type ActivitySession = Readonly<
  {
    accountId: string;
    identity: string;
  } & (
    | { mode: "privy"; getAccessToken: () => Promise<string | null> }
    | { mode: "wallet" }
  )
>;

type ActivityDocument = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

/** One memory-only cooldown cache per mounted social session; no identity is sent in a body. */
export function createAccountActivity({
  now = Date.now,
  fetch = gatedFetch,
} = {}) {
  const cooldowns = new Map<string, { day: string; until: number }>();

  function subscribe(
    session: ActivitySession,
    document: ActivityDocument,
  ): () => void {
    const key = `${session.mode}:${session.identity}:${session.accountId}`;
    let active = true;
    let generation = 0;
    let visible = document.visibilityState === "visible";
    let pending: AbortController | null = null;

    async function record() {
      const time = now();
      const previous = cooldowns.get(key);
      if (!active || document.visibilityState !== "visible" || pending) {
        return;
      }
      if (previous?.day === utcDay(time) && time < previous.until) {
        return;
      }

      const current = generation;
      const controller = new AbortController();
      pending = controller;
      // The SDK token promise cannot be cancelled. Race it as well as the request,
      // and check the signal before POST so its late resolution cannot send anything.
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const cancelled = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          {
            once: true,
          },
        );
      });
      let accepted = false;
      try {
        accepted = await Promise.race([
          postActivity(session, controller.signal, fetch),
          cancelled,
        ]);
      } catch {
        // Activity is best effort; provider and transport errors never reach product UI.
      } finally {
        clearTimeout(timeout);
        if (pending === controller) {
          pending = null;
        }
      }
      if (!active || current !== generation) {
        return;
      }

      const completed = now();
      cooldowns.delete(key);
      // A response delivered after midnight cannot suppress the newly observed day.
      cooldowns.set(key, {
        day: utcDay(time),
        until: completed + (accepted ? 900_000 : 30_000),
      });
      if (cooldowns.size > 16) {
        cooldowns.delete(cooldowns.keys().next().value!);
      }
    }

    function cancel() {
      generation += 1;
      pending?.abort();
      pending = null;
    }

    function visibility() {
      const nextVisible = document.visibilityState === "visible";
      if (nextVisible === visible) {
        return;
      }
      visible = nextVisible;
      if (visible) {
        void record();
      } else {
        cancel();
      }
    }

    function input(event: Event) {
      if (event.isTrusted) {
        void record();
      }
    }

    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("pointerdown", input, { passive: true });
    document.addEventListener("keydown", input, { passive: true });
    // Let Strict Mode's initial setup/cleanup finish before acquiring a token.
    queueMicrotask(() => {
      void record();
    });
    return () => {
      active = false;
      cancel();
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("pointerdown", input);
      document.removeEventListener("keydown", input);
    };
  }

  return { subscribe };
}

async function postActivity(
  session: ActivitySession,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch,
): Promise<boolean> {
  const headers = new Headers();
  if (session.mode === "privy") {
    const token = await session.getAccessToken();
    if (!token || signal.aborted) {
      return false;
    }
    headers.set("Authorization", `Bearer ${token}`);
  }
  signal.throwIfAborted();
  const response = await fetch("/api/analytics/activity", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers,
    signal,
  });
  return response.status === 204;
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
