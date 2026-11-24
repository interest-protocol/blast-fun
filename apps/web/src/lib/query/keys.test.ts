import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { clearViewerQueries, invalidateAfter } from "./invalidate.ts";
import { isCommitQuoteFor, isPortfolioCoinsFilter, queryKeys } from "./keys.ts";

test("quote ownership and portfolio filters never reuse a different viewer or search", () => {
  assert.equal(isCommitQuoteFor(queryKeys.quotes.commit({ sale: "sale", viewer: "kai" }), "kai"), true);
  assert.equal(isCommitQuoteFor(queryKeys.quotes.commit({ sale: "sale", viewer: "kai" }), "lee"), false);
  assert.equal(isCommitQuoteFor(queryKeys.quotes.swap({ viewer: "kai" }), "kai"), false);
  assert.equal(isPortfolioCoinsFilter(queryKeys.me.portfolioCoins(2, "sui", true), "sui", true), true);
  assert.equal(isPortfolioCoinsFilter(queryKeys.me.portfolioCoins(2, "other", true), "sui", true), false);
  assert.equal(isPortfolioCoinsFilter(queryKeys.me.portfolioCoins(2, "sui", false), "sui", true), false);
});

test("viewer changes remove private competition ranks while keeping public boards", () => {
  const client = new QueryClient();
  try {
    const rank = queryKeys.me.competitionRank("sui", "kai");
    const board = queryKeys.competitions.board("sui", 1, "all");
    client.setQueryData(rank, { member: "kai" });
    client.setQueryData(board, { members: [] });
    clearViewerQueries(client);
    assert.equal(client.getQueryData(rank), undefined);
    assert.deepEqual(client.getQueryData(board), { members: [] });
  } finally { client.clear(); }
});

test("wallet staleness keeps active reads idle until a fresh quote asks for balances", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  let reads = 0;
  const query = {
    queryKey: queryKeys.me.wallet(),
    queryFn: async () => ++reads,
    staleTime: Infinity,
    initialData: 5,
  };
  const observer = new QueryObserver(client, query);
  const off = observer.subscribe(() => undefined);
  try {
    await invalidateAfter(client, { kind: "wallet-stale" });
    assert.equal(reads, 0);
    assert.equal(await client.fetchQuery(query), 1);
  } finally { off(); client.clear(); }
});
