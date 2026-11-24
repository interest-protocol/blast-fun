import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import {
  createAccountActivity,
  type ActivitySession,
} from "./account-activity.ts";

class Foreground extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  show() {
    this.visibilityState = "visible";
    this.dispatchEvent(new Event("visibilitychange"));
  }
  hide() {
    this.visibilityState = "hidden";
    this.dispatchEvent(new Event("visibilitychange"));
  }
  input(type = "pointerdown", trusted = true) {
    const event = new Event(type);
    // This models the browser boundary. The browser fixture also exercises real trusted input.
    Object.defineProperty(event, "isTrusted", { value: trusted });
    this.dispatchEvent(event);
  }
}

const wallet: ActivitySession = {
  accountId: "account-A",
  identity: "wallet",
  mode: "wallet",
};
const flush = () => setImmediate();

function fixture(fetch: typeof globalThis.fetch) {
  let time = Date.parse("2026-11-16T12:00:00Z");
  const activity = createAccountActivity({ fetch, now: () => time });
  const document = new Foreground();
  return {
    activity,
    document,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    setTime: (value: string) => {
      time = Date.parse(value);
    },
  };
}

test("foreground activity uses a body-free cookie POST, suppresses synthetic/idle events and resets at fifteen minutes or UTC midnight", async () => {
  const requests: RequestInit[] = [];
  const { activity, document, advance, setTime } = fixture(
    async (url, init) => {
      assert.equal(url, "/api/analytics/activity");
      requests.push(init!);
      return new Response(null, { status: 204 });
    },
  );
  const stop = activity.subscribe(wallet, document);
  try {
    await flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, "POST");
    assert.equal(requests[0]!.body, undefined);
    assert.equal(requests[0]!.credentials, "same-origin");
    assert.equal(requests[0]!.cache, "no-store");
    assert.equal(new Headers(requests[0]!.headers).get("Authorization"), null);
    advance(899_999);
    document.input();
    await flush();
    assert.equal(requests.length, 1);
    advance(1);
    await flush();
    assert.equal(requests.length, 1, "elapsed time alone is not activity");
    document.input("keydown", false);
    await flush();
    assert.equal(requests.length, 1, "scripted input is not activity");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    assert.equal(
      requests.length,
      1,
      "an already visible page has no foreground transition",
    );
    document.hide();
    document.show();
    await flush();
    assert.equal(
      requests.length,
      2,
      "hidden to visible is foreground activity",
    );
    advance(900_000);
    document.input("keydown");
    await flush();
    assert.equal(requests.length, 3);
    setTime("2026-11-16T23:59:59Z");
    document.input();
    await flush();
    assert.equal(requests.length, 4);
    setTime("2026-11-17T00:00:00Z");
    document.hide();
    document.input();
    await flush();
    assert.equal(requests.length, 4);
    document.show();
    await flush();
    assert.equal(
      requests.length,
      5,
      "a new UTC day ignores the preceding success window",
    );
  } finally {
    stop();
  }
});

test("Privy token failure never falls back to cookies and retries only after thirty seconds", async () => {
  let token: string | null = null;
  let tokens = 0;
  const requests: RequestInit[] = [];
  const { activity, document, advance } = fixture(async (_, init) => {
    requests.push(init!);
    return new Response(null, { status: 204 });
  });
  const stop = activity.subscribe(
    {
      accountId: "A",
      identity: "privy-A",
      mode: "privy",
      getAccessToken: async () => {
        tokens += 1;
        return token;
      },
    },
    document,
  );
  try {
    await flush();
    assert.equal(tokens, 1);
    assert.equal(requests.length, 0);
    token = "fixture-token";
    advance(29_999);
    document.input();
    await flush();
    assert.equal(tokens, 1);
    advance(1);
    document.input();
    await flush();
    assert.equal(tokens, 2);
    assert.equal(requests.length, 1);
    assert.equal(
      new Headers(requests[0]!.headers).get("Authorization"),
      "Bearer fixture-token",
    );
    assert.equal(requests[0]!.body, undefined);
  } finally {
    stop();
  }
});

test("token rejection and refused requests use the failure window rather than the accepted window", async () => {
  let rejectToken = true;
  let tokens = 0;
  let requests = 0;
  const { activity, document, advance } = fixture(async () => {
    requests += 1;
    return new Response(null, { status: 503 });
  });
  const stop = activity.subscribe(
    {
      accountId: "A",
      identity: "privy-A",
      mode: "privy",
      getAccessToken: async () => {
        tokens += 1;
        if (rejectToken) {
          throw new Error("provider refused");
        }
        return "token";
      },
    },
    document,
  );
  try {
    await flush();
    assert.equal(requests, 0);
    rejectToken = false;
    advance(30_000);
    document.input();
    await flush();
    assert.equal(requests, 1);
    advance(29_999);
    document.input();
    await flush();
    assert.equal(tokens, 2);
    advance(1);
    document.input();
    await flush();
    assert.equal(requests, 2);
  } finally {
    stop();
  }
});

test("a hung SDK token or request expires after ten seconds and cannot send or accept a late result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveToken!: (value: string) => void;
  let resolveRequest!: (value: Response) => void;
  let tokenCalls = 0;
  const requests: RequestInit[] = [];
  const { activity, document, advance } = fixture(async (_, init) => {
    requests.push(init!);
    return new Promise((resolve) => {
      resolveRequest = resolve;
    });
  });
  const stop = activity.subscribe(
    {
      accountId: "A",
      identity: "privy-A",
      mode: "privy",
      getAccessToken: () => {
        tokenCalls += 1;
        return tokenCalls === 1
          ? new Promise((resolve) => {
              resolveToken = resolve;
            })
          : Promise.resolve("next-token");
      },
    },
    document,
  );
  try {
    await flush();
    t.mock.timers.tick(9_999);
    await flush();
    assert.equal(requests.length, 0);
    t.mock.timers.tick(1);
    await flush();
    resolveToken("late-token");
    await flush();
    assert.equal(requests.length, 0);
    advance(29_999);
    document.input();
    await flush();
    assert.equal(tokenCalls, 1);
    advance(1);
    document.input();
    await flush();
    assert.equal(requests.length, 1);
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(requests[0]!.signal!.aborted, true);
    resolveRequest(new Response(null, { status: 204 }));
    await flush();
    advance(30_000);
    document.input();
    await flush();
    assert.equal(
      requests.length,
      2,
      "late 204 cannot create a fifteen-minute success window",
    );
  } finally {
    stop();
  }
});

test("hiding or detaching aborts the old account and its late completion cannot overwrite another account's cooldown", async () => {
  let resolveA!: (value: Response) => void;
  const requests: RequestInit[] = [];
  const { activity, document, advance } = fixture(async (_, init) => {
    requests.push(init!);
    if (requests.length === 1) {
      return new Promise((resolve) => {
        resolveA = resolve;
      });
    }
    return new Response(null, { status: 204 });
  });
  let stop = activity.subscribe(wallet, document);
  try {
    await flush();
    document.hide();
    assert.equal(requests[0]!.signal!.aborted, true);
    document.input();
    await flush();
    assert.equal(requests.length, 1);
    stop();
    stop = activity.subscribe(
      {
        accountId: "account-B",
        identity: "privy-B",
        mode: "privy",
        getAccessToken: async () => "B",
      },
      document,
    );
    document.show();
    await flush();
    assert.equal(requests.length, 2);
    resolveA(new Response(null, { status: 503 }));
    await flush();
    advance(1);
    stop();
    stop = activity.subscribe(wallet, document);
    await flush();
    assert.equal(
      requests.length,
      3,
      "cancelled A completion cannot leave a failure cooldown",
    );
    stop();
    stop = activity.subscribe(
      {
        accountId: "account-B",
        identity: "privy-B",
        mode: "privy",
        getAccessToken: async () => "B",
      },
      document,
    );
    await flush();
    advance(30_000);
    document.input();
    await flush();
    assert.equal(
      requests.length,
      3,
      "old failure cannot replace B's successful cooldown",
    );
    stop();
    document.input();
    document.show();
    await flush();
    assert.equal(requests.length, 3, "detached listeners cannot send");
  } finally {
    stop();
  }
});

test("a prior-day request accepted after midnight cannot suppress activity for the new UTC day", async () => {
  let complete!: (value: Response) => void;
  let requests = 0;
  const { activity, document, setTime } = fixture(async () => {
    requests += 1;
    return requests === 1
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : new Response(null, { status: 204 });
  });
  setTime("2026-11-16T23:59:59Z");
  const stop = activity.subscribe(wallet, document);
  try {
    await flush();
    assert.equal(requests, 1);
    setTime("2026-11-17T00:00:01Z");
    complete(new Response(null, { status: 204 }));
    await flush();
    document.input();
    await flush();
    assert.equal(requests, 2);
  } finally {
    stop();
  }
});
