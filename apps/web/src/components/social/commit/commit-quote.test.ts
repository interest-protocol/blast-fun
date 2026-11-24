import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";

import { queryKeys } from "#web/lib/query/keys.ts";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";

import { COMMIT_QUOTE_DEBOUNCE_MS, COMMIT_QUOTE_MAX_AGE_MS, COMMIT_READ_TIMEOUT_MS, createCommitQuotes, quoteWalletQuery } from "./commit-quote";

beforeEach(() => mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

test("a hanging presale read times out, aborts and cannot overwrite a successful retry", async () => {
  const client = createTestQueryClient();
  const late = Promise.withResolvers<string | null>();
  let first = true;
  const signals: AbortSignal[] = [];
  const source = createCommitQuotes<string>({ client, read: (_id, signal) => {
    if (!first) return Promise.resolve("current terms");
    first = false;
    signals.push(signal);
    return late.promise;
  } });
  try {
    const pending = source.fresh("alon");
    mock.timers.tick(COMMIT_READ_TIMEOUT_MS);
    assert.equal(await pending, null);
    assert.equal(source.peek("alon").loading, false);
    assert.equal(source.peek("alon").error?.name, "TimeoutError");
    assert.equal(signals[0]?.aborted, true);
    assert.equal(await source.refresh("alon"), "current terms");
    late.resolve("old terms");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(source.peek("alon").facts, "current terms");
    assert.equal(source.peek("alon").failed, false);
  } finally { source.dispose(); client.clear(); }
});

/**
 * The commit quote's reads (R3-54-AC-12): cached for the sale read's own CDN
 * lifetime, debounced, one in flight, the last read winning. Driven with a
 * hand clock and hand timers, and reads that answer only when told to, so
 * "in flight" is a state the test holds open. The answers live in a TanStack
 * Query cache (OA-38), keyed by sale and viewer.
 */

type Pending = { saleId: string; resolve: (value: string | null) => void };

function harness(options: Readonly<{ client?: ReturnType<typeof createTestQueryClient>; viewer?: string | null }> = {}) {
  const reads: Pending[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const source = createCommitQuotes<string>({
    client: options.client ?? createTestQueryClient(),
    viewer: options.viewer,
    read: (saleId) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      return new Promise((resolve) => {
        reads.push({
          saleId,
          resolve: (value) => {
            inflight -= 1;
            resolve(value);
          },
        });
      });
    },
  });
  const advance = async (ms: number) => {
    mock.timers.tick(ms);
    await flush();
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    source,
    reads,
    advance,
    flush,
    get maxInflight() {
      return maxInflight;
    },
    answer: async (value: string | null) => {
      const read = reads.find((one) => one.saleId !== "done");
      assert.ok(read, "a read is out");
      read.saleId = "done";
      read.resolve(value);
      await flush();
    },
  };
}

const asked = (h: ReturnType<typeof harness>) => h.reads.length;

test("arming reads at once; every keystroke and preset inside the quote's age reuses it (AC-12)", async () => {
  const h = harness();
  h.source.want("mrdn", { now: true });
  assert.equal(asked(h), 1, "arming asks once, without waiting for the debounce");
  assert.equal(h.source.peek("mrdn").loading, true);
  await h.answer("quote-1");
  assert.equal(h.source.peek("mrdn").facts, "quote-1");
  // Eight characters and two preset presses, 300 ms apart.
  for (let press = 0; press < 10; press += 1) {
    h.source.want("mrdn");
    await h.advance(300);
  }
  assert.equal(asked(h), 1, "a quote younger than its age is reused");
  assert.ok(COMMIT_QUOTE_MAX_AGE_MS >= 3_000, "the age covers a burst of typing");
});

test("typing eight characters and pressing two presets on a cold quote makes at most three requests, one in flight (AC-12)", async () => {
  const h = harness();
  // Fast typing: each change inside the debounce window.
  for (let key = 0; key < 8; key += 1) {
    h.source.want("tide");
    await h.advance(60);
  }
  assert.equal(asked(h), 0, "nothing is asked while the amount keeps changing");
  await h.advance(COMMIT_QUOTE_DEBOUNCE_MS);
  assert.equal(asked(h), 1, "one read after the amount stops");
  // Two presets while that read is out: no second request.
  h.source.want("tide");
  await h.advance(COMMIT_QUOTE_DEBOUNCE_MS);
  h.source.want("tide");
  await h.advance(COMMIT_QUOTE_DEBOUNCE_MS);
  assert.equal(asked(h), 1, "a change while a read is out does not start another");
  await h.answer("quote");
  assert.ok(asked(h) <= 3);
  assert.equal(h.maxInflight, 1);
});

test("a stale quote is read again, debounced; a failed read keeps the last answer", async () => {
  const h = harness();
  h.source.want("kstl", { now: true });
  await h.answer("first");
  await h.advance(COMMIT_QUOTE_MAX_AGE_MS + 1);
  h.source.want("kstl");
  assert.equal(asked(h), 1, "debounced, not immediate");
  await h.advance(COMMIT_QUOTE_DEBOUNCE_MS);
  assert.equal(asked(h), 2);
  await h.answer(null);
  const snapshot = h.source.peek("kstl");
  assert.equal(snapshot.facts, "first");
  assert.equal(snapshot.failed, true);
  assert.equal(snapshot.loading, false);
});

test("at confirm, a fresh quote is reused, a read in flight is joined, and a stale one is read now", async () => {
  const h = harness();
  h.source.want("mrdn", { now: true });
  const joined = h.source.fresh("mrdn");
  assert.equal(asked(h), 1, "confirm joins the read already out");
  await h.answer("q1");
  assert.equal(await joined, "q1");
  assert.equal(await h.source.fresh("mrdn"), "q1", "younger than its age: no request");
  assert.equal(asked(h), 1);
  await h.advance(COMMIT_QUOTE_MAX_AGE_MS);
  const later = h.source.fresh("mrdn");
  assert.equal(asked(h), 2, "older than its age: read at once, no debounce");
  await h.answer("q2");
  assert.equal(await later, "q2");
});

test("after a blast, refresh reads again whatever the cache holds, and a read already out is followed by one more", async () => {
  const h = harness();
  h.source.want("tide", { now: true });
  await h.answer("before");
  const again = h.source.refresh("tide");
  assert.equal(asked(h), 2, "a fresh cache does not stop the post-blast read");
  await h.answer("after");
  assert.equal(await again, "after");

  // A read that left before the commit landed is followed by one more; the caller gets the last.
  h.source.want("lumn", { now: true });
  const followed = h.source.refresh("lumn");
  assert.equal(asked(h), 3);
  await h.answer("stale");
  assert.equal(asked(h), 4, "one more read after the one in flight");
  await h.answer("newest");
  assert.equal(await followed, "newest");
  assert.equal(h.source.peek("lumn").facts, "newest", "the last read wins");
  assert.equal(h.maxInflight, 1, "never two reads out at once");
});

test("each sale is its own quote, and subscribers hear every change", async () => {
  const h = harness();
  let heard = 0;
  const off = h.source.subscribe(() => {
    heard += 1;
  });
  h.source.want("a", { now: true });
  h.source.want("b", { now: true });
  assert.equal(asked(h), 2);
  await h.answer("A");
  await h.answer("B");
  assert.equal(h.source.peek("a").facts, "A");
  assert.equal(h.source.peek("b").facts, "B");
  assert.ok(heard >= 4, "loading and answered, for each");
  const snapshot = h.source.peek("a");
  assert.equal(h.source.peek("a"), snapshot, "the same snapshot object until something changes");
  off();
  h.source.dispose();
});

test("dispose cancels a pending debounce, and the source still answers afterwards", async () => {
  const h = harness();
  h.source.want("x");
  h.source.dispose();
  await h.advance(COMMIT_QUOTE_DEBOUNCE_MS * 2);
  assert.equal(asked(h), 0);
  h.source.want("x", { now: true });
  assert.equal(asked(h), 1);
});

test("the answers live in the query cache, keyed by sale and viewer: one viewer's quote never answers for another", async () => {
  const client = createTestQueryClient();
  const kai = harness({ client, viewer: "kai" });
  kai.source.want("mrdn", { now: true });
  await kai.answer("kai's facts");
  assert.deepEqual(client.getQueryData(queryKeys.quotes.commit({ sale: "mrdn", viewer: "kai" })), { facts: "kai's facts", at: 1_000_000 });
  // Another viewer on the same cache (a sign-in as someone else) reads their own.
  const mira = harness({ client, viewer: "mira" });
  assert.equal(mira.source.peek("mrdn").facts, null);
  mira.source.want("mrdn", { now: true });
  assert.equal(asked(mira), 1, "not served from kai's answer");
  await mira.answer("mira's facts");
  let heardKai = 0;
  const off = kai.source.subscribe(() => void (heardKai += 1));
  mira.source.want("tide", { now: true });
  await mira.answer("tide");
  assert.equal(heardKai, 0, "a source hears only its own viewer's quotes");
  off();
  // Leaving (or another viewer) forgets this viewer's answers, and only theirs.
  kai.source.dispose();
  assert.equal(client.getQueryData(queryKeys.quotes.commit({ sale: "mrdn", viewer: "kai" })), undefined);
  assert.equal(mira.source.peek("mrdn").facts, "mira's facts");
});

test("the quote's wallet is the shared /me/wallet entry: one read inside the quote's age, a failed read not kept, stale after a send", async () => {
  const client = createTestQueryClient();
  let calls = 0;
  let answer: string | null = "wallet";
  // The shared read (`walletQuery`): the body, or a throw when the read failed.
  const query = quoteWalletQuery({
    queryKey: queryKeys.me.wallet(),
    queryFn: async () => {
      calls += 1;
      if (answer === null) throw new Error("The wallet read failed.");
      return answer;
    },
  });
  const read = () => client.fetchQuery(query).catch(() => null);
  assert.deepEqual(query.queryKey, queryKeys.me.wallet(), "the Your coins card's entry");
  assert.equal(await read(), "wallet");
  assert.equal(await read(), "wallet");
  assert.equal(calls, 1);
  mock.timers.tick(COMMIT_QUOTE_MAX_AGE_MS);
  answer = null;
  assert.equal(await read(), null, "a failed read answers null");
  assert.equal(calls, 2);
  answer = "back";
  assert.equal(await read(), "back", "the failed read was not kept: the next ask reads");
  assert.equal(calls, 3);
  await client.invalidateQueries({ queryKey: queryKeys.me.wallet(), refetchType: "none" });
  assert.equal(await read(), "back");
  assert.equal(calls, 4, "a send marks it stale: the next quote reads it again");
});
