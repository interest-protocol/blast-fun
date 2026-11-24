import { PublicError, responseError } from "#web/lib/errors.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

/**
 * OA-38: the shared server-state pieces. The client's defaults (fresh for
 * the CDN's 10 s, retries only what a retry can fix, with backoff), the key
 * factory's stable keys, and — in jsdom — two consumers of one
 * key making one request, a remount inside the window making none.
 */

installTestDom();

const { act, useEffect, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { useQuery } = await import("@tanstack/react-query");
const client = await import("./client");
const { queryKeys, sortedIds } = await import("./keys");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("./test-client");
const { QueryProvider, useAppQueryClient } = await import("./provider");

const { FAILED_RECHECK_MS, PUBLIC_STALE_MS, QueryRefusal, QueryTransientError, httpError, makeQueryClient, recheckFailed, retryDelay, shouldRetry, unwrapApiResult, apiResultOfError } = client;

test("a read failed on an outage rechecks on a steady, backed-off timer; a definite answer does not", () => {
  const failed = (error: unknown, errorUpdateCount = 1, errorUpdatedAt = 1_700_000_000_500) => ({ state: { status: "error", error, errorUpdatedAt, errorUpdateCount } });
  const outage = failed(httpError(503));
  // The same state always gives the same interval, so a re-render never restarts the timer.
  assert.equal(recheckFailed(outage), recheckFailed(outage));
  assert.equal(recheckFailed(outage), FAILED_RECHECK_MS);
  assert.equal(recheckFailed(failed(httpError(503), 2)), 2 * FAILED_RECHECK_MS);
  assert.equal(recheckFailed(failed(httpError(503), 9)), 4 * FAILED_RECHECK_MS);
  assert.equal(recheckFailed(failed(new PublicError("Sign in again.", { code: "unauthorized", httpStatus: 401 }))), FAILED_RECHECK_MS);
  assert.equal(recheckFailed(failed(httpError(404))), false);
  assert.equal(recheckFailed(failed(new Error("bug"))), false);
  assert.equal(recheckFailed({ state: { status: "success", error: null, errorUpdatedAt: 0, errorUpdateCount: 0 } }), false);
});

test("a refusal, a 4xx and an abort are never retried; a transient failure twice", () => {
  assert.equal(shouldRetry(0, new QueryRefusal("not_found")), false);
  assert.equal(shouldRetry(0, httpError(404)), false);
  assert.equal(shouldRetry(0, httpError(429)), false);
  assert.equal(shouldRetry(0, Object.assign(new Error("aborted"), { name: "AbortError" })), false);
  assert.equal(shouldRetry(0, httpError(503)), true);
  assert.equal(shouldRetry(1, new QueryTransientError()), true);
  assert.equal(shouldRetry(2, new QueryTransientError()), false);
  assert.equal(shouldRetry(0, new TypeError("Failed to fetch")), true);
  for (const attempt of [0, 1, 2, 3, 4, 5]) {
    const delay = retryDelay(attempt);
    const cap = Math.min(1_000 * 2 ** attempt, 8_000);
    assert.ok(delay >= cap / 2 && delay <= cap);
  }
});

test("the client's defaults: fresh for the CDN window, no refetch on focus, mutations never retried", () => {
  const options = makeQueryClient().getDefaultOptions();
  assert.equal(options.queries?.staleTime, PUBLIC_STALE_MS);
  assert.equal(PUBLIC_STALE_MS, 10_000);
  assert.equal(options.queries?.refetchOnWindowFocus, false);
  assert.equal(options.queries?.retry, shouldRetry);
  assert.equal(options.mutations?.retry, false);
  const testOptions = createTestQueryClient().getDefaultOptions();
  assert.equal(testOptions.queries?.retry, false);
  assert.equal(testOptions.queries?.gcTime, 0);
  assert.equal(testOptions.queries?.staleTime, PUBLIC_STALE_MS);
});

test("a coin panel's wallet read that failed or came back empty asks again in 15 s; a healthy one waits the minute", async () => {
  const { ACCOUNT_POLL_MS, accountReadInterval, walletReadInterval } = await import("#web/components/social/blast-mode/workspace/panels/use-coin-read.ts");
  assert.equal(accountReadInterval({ status: "error" }), FAILED_RECHECK_MS);
  assert.equal(accountReadInterval({ status: "success" }), ACCOUNT_POLL_MS, "no PnL is an answer");
  assert.equal(walletReadInterval({ status: "ready", value: null }), FAILED_RECHECK_MS, "the wallet read answers null when it fails");
  assert.equal(walletReadInterval({ status: "error", value: null }), FAILED_RECHECK_MS);
  assert.equal(walletReadInterval({ status: "ready", value: { balance: 1 } }), ACCOUNT_POLL_MS);
});

test("a coin panel's wallet waits the minute while it has balances, asks again in 15 s while it has none, and at once when balances move", async () => {
  const { ACCOUNT_POLL_MS, useCoinWalletRead } = await import("#web/components/social/blast-mode/workspace/panels/use-coin-read.ts");
  const { BalancesProvider } = await import("#web/components/social/coins/balances.tsx");
  const { WorkspaceLiveProvider } = await import("#web/components/social/blast-mode/workspace/live-clock.tsx");
  const { handClock } = await import("../../../test/fixtures/workspace/live-clock.ts");
  const time = handClock();
  const answers: ({ balance: number } | null)[] = [{ balance: 1 }, null, { balance: 2 }, { balance: 3 }];
  let reads = 0;
  const read = async () => answers[reads++] ?? null;
  function Panel() {
    useCoinWalletRead(true, "actor", read);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const settle = () => act(async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); });
  const advance = async (ms: number) => { await act(async () => time.advance(ms)); await settle(); };
  const queries = createTestQueryClient();
  const render = (version: number) => root.render(withQueryClient(queries, <BalancesProvider value={{ version, changed() {} }}><WorkspaceLiveProvider clock={time.clock}><Panel /></WorkspaceLiveProvider></BalancesProvider>));
  await act(async () => render(0));
  await settle();
  assert.equal(reads, 1);
  await advance(ACCOUNT_POLL_MS - 1);
  assert.equal(reads, 1, "no read inside the minute");
  await advance(1);
  assert.equal(reads, 2, "the failed read answers null");
  await advance(FAILED_RECHECK_MS);
  assert.equal(reads, 3, "a panel with no balances asks again in 15 s");
  await advance(FAILED_RECHECK_MS);
  assert.equal(reads, 3, "a healthy answer waits the minute again");
  await act(async () => render(1)); await settle();
  assert.equal(reads, 4, "the viewer's own trade, deposit or commit reads it again at once");
  await act(async () => root.unmount());
});

test("callSocialApi's answer bridges both ways", () => {
  assert.equal(unwrapApiResult({ status: "ok", body: 7 }), 7);
  assert.throws(() => unwrapApiResult({ status: "refused", code: "unauthenticated", retryAfterSeconds: null }), QueryRefusal);
  assert.throws(() => unwrapApiResult({ status: "error" }), QueryTransientError);
  assert.deepEqual(apiResultOfError(new QueryRefusal("rate_limited", { retryAfterSeconds: 3 })), { status: "refused", code: "rate_limited", retryAfterSeconds: 3 });
  assert.deepEqual(apiResultOfError(new QueryTransientError()), { status: "error", code: "network_unavailable" });
});

test("shared query failures keep the server reference in the message and result", () => {
  const refused = { status: "refused", code: "service_unavailable", retryAfterSeconds: 5, requestId: "req-21" } as const;
  const malformed = { status: "error", code: "network_unavailable", requestId: "req-22" } as const;
  for (const result of [refused, malformed]) {
    assert.throws(() => unwrapApiResult(result), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`Reference: ${result.requestId}`));
      assert.deepEqual(apiResultOfError(error), result);
      return true;
    });
  }
  assert.match(new QueryRefusal("service_unavailable").message, /temporarily unavailable.*Try again soon.*Code: service_unavailable/);
  assert.match(new QueryRefusal("rate_limited").message, /Too many requests.*Try again later.*Code: rate_limited/);
  assert.equal(new QueryRefusal("constructor").code, "request_failed");
  assert.equal(new QueryRefusal("constructor").message, "The server refused the read. Review it and retry. Code: request_failed.");
});

test("keys: id lists are sorted and de-duplicated; prefixes nest", () => {
  assert.deepEqual(queryKeys.me.presaleViewer(["0xb", "0xa", "0xb"]), queryKeys.me.presaleViewer(["0xa", "0xb"]));
  assert.deepEqual(sortedIds(["c", "a", "b", "a"]), ["a", "b", "c"]);
  assert.deepEqual(queryKeys.presales.detail("0x1").slice(0, queryKeys.presales.all.length), [...queryKeys.presales.all]);
  assert.deepEqual(queryKeys.me.notifications.unread().slice(0, queryKeys.me.all.length), [...queryKeys.me.all]);
  assert.deepEqual(queryKeys.happening().slice(0, queryKeys.public.length), [...queryKeys.public]);
});

function Reader({ name, read, seen }: Readonly<{ name: string; read: () => Promise<string>; seen: string[] }>) {
  const query = useQuery({ queryKey: queryKeys.happening(), queryFn: read });
  seen.push(`${name}:${query.data ?? "-"}`);
  return <span>{query.data ?? "…"}</span>;
}

test("two consumers of one key make one request; a remount inside the window makes none", async () => {
  const queryClient = createTestQueryClient({ queries: { gcTime: 60_000 } });
  let calls = 0;
  const read = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "rows";
  };
  const seen: string[] = [];
  const toggles: Array<(on: boolean) => void> = [];
  const toggle = (on: boolean) => toggles.at(-1)?.(on);
  function Page() {
    const [on, setOn] = useState(true);
    useEffect(() => void toggles.push(setOn), []);
    return (
      <>
        <Reader name="tape" read={read} seen={seen} />
        {on ? <Reader name="today" read={read} seen={seen} /> : null}
      </>
    );
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(withQueryClient(queryClient, <Page />)));
  await act(async () => settleQueries(queryClient));
  assert.equal(calls, 1);
  assert.ok(seen.includes("tape:rows") && seen.includes("today:rows"));
  await act(async () => toggle(false));
  await act(async () => toggle(true));
  await act(async () => settleQueries(queryClient));
  assert.equal(calls, 1, "the remount read the cache");
  await act(async () => root.unmount());
  queryClient.clear();
});

test("a transient failure is retried with the policy; a refusal is not", async () => {
  const queryClient = createTestQueryClient({ queries: { retry: shouldRetry, retryDelay: 0 } });
  let transient = 0;
  await assert.rejects(
    queryClient.fetchQuery({
      queryKey: ["t"],
      queryFn: async () => {
        transient += 1;
        throw new QueryTransientError();
      },
    }),
    QueryTransientError,
  );
  assert.equal(transient, 3, "one attempt and two retries");
  let refused = 0;
  await assert.rejects(
    queryClient.fetchQuery({
      queryKey: ["r"],
      queryFn: async () => {
        refused += 1;
        throw new QueryRefusal("not_found");
      },
    }),
    QueryRefusal,
  );
  assert.equal(refused, 1);
  queryClient.clear();
});

test("server render: initial data paints with no request, and the provider renders no element or style", () => {
  let calls = 0;
  const seededAt = Date.now();
  function Seeded() {
    const query = useQuery({
      queryKey: queryKeys.presales.detail("0x1"),
      queryFn: async () => {
        calls += 1;
        return "fetched";
      },
      initialData: "server",
      initialDataUpdatedAt: seededAt,
    });
    return <b>{query.data}</b>;
  }
  const html = renderToString(
    <QueryProvider client={createTestQueryClient()}>
      <Seeded />
    </QueryProvider>,
  );
  assert.equal(html, "<b>server</b>");
  assert.equal(calls, 0);
  assert.doesNotMatch(html, /<style|style="/);
});

test("hydration with initial data inside the window does not refetch", async () => {
  const queryClient = createTestQueryClient();
  let calls = 0;
  const seededAt = Date.now();
  function Seeded() {
    const query = useQuery({
      queryKey: queryKeys.presales.detail("0x2"),
      queryFn: async () => {
        calls += 1;
        return "fetched";
      },
      initialData: "server",
      initialDataUpdatedAt: seededAt,
    });
    return <b>{query.data}</b>;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(withQueryClient(queryClient, <Seeded />)));
  await act(async () => settleQueries(queryClient));
  assert.equal(calls, 0);
  await act(async () => root.unmount());
});

test("a hook outside any provider still gets a client", () => {
  function Probe() {
    const queryClient = useAppQueryClient();
    return <i>{typeof queryClient.getQueryCache}</i>;
  }
  assert.equal(renderToString(<Probe />), "<i>function</i>");
});


test("base public HTTP errors keep their code and never retry authentication or cancellation", () => {
  for (const status of [401, 403, 404, 429]) {
    const error = responseError({ error: { code: "unauthorized" } }, new Response(null, { status, headers: { "X-Request-ID": "public-query-213", "Retry-After": "5" } }));
    assert.equal(shouldRetry(0, error), false);
    assert.deepEqual(apiResultOfError(error), { status: "error", code: "unauthorized", httpStatus: status, requestId: "public-query-213", retryAfterSeconds: 5 });
  }
  assert.equal(shouldRetry(0, new PublicError("Cancelled.", { code: "request_cancelled" })), false);
  assert.equal(shouldRetry(0, responseError(null, new Response(null, { status: 503 }))), true);
});
