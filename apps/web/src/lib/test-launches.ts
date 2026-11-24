import { CREATE_TEST_SUI_QUOTE_TYPE, createQuoteOf } from "@blast/core/web/contracts/create.ts";
import type { DiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import type { SocialHappeningResponse } from "@blast/core/modules/social/contracts/happening.ts";

/**
 * Test launches are the ones raised in Test SUI (TSUI), a worthless coin the
 * team tests mainnet launches with. Public lists leave them out; the data
 * stays in the database and a direct link still opens the launch.
 */

/** The symbols a Test SUI quote is reported under (`TSUI` by blast-infra, `TEST_SUI` on chain). */
const TEST_QUOTE_SYMBOLS: ReadonlySet<string> = new Set(["TSUI", "TEST_SUI"]);

export function isTestQuoteType(type: string | null | undefined): boolean {
  return !!type && createQuoteOf(type)?.quote_type === CREATE_TEST_SUI_QUOTE_TYPE;
}

export function isTestQuoteSymbol(symbol: string | null | undefined): boolean {
  return !!symbol && TEST_QUOTE_SYMBOLS.has(symbol);
}

/** Home → Discover without test coins; `total` drops by the coins removed from this page. */
export function withoutTestCoins<Page extends Readonly<{ coins: readonly Readonly<{ quote: Readonly<{ type: string }> }>[]; total?: number }>>(page: Page): Page {
  const coins = page.coins.filter((coin) => !isTestQuoteType(coin.quote.type));
  if (coins.length === page.coins.length) return page;
  const removed = page.coins.length - coins.length;
  return { ...page, coins, ...(typeof page.total === "number" ? { total: Math.max(0, page.total - removed) } : {}) };
}

/** A presale list without test sales. */
type PresaleRow = Readonly<{ quote_type: string }>;

export function withoutTestPresales<Row extends PresaleRow>(rows: readonly Row[]): Row[] {
  return rows.filter((row) => !isTestQuoteType(row.quote_type));
}

export function withoutTestPresalePage<Page extends Readonly<{ presales: readonly PresaleRow[] }>>(page: Page): Page {
  const presales = withoutTestPresales(page.presales);
  return presales.length === page.presales.length ? page : { ...page, presales };
}

/** A discovery (bonding curve) page without test launches. */
export function withoutTestLaunches<Answer extends DiscoveryResponse>(answer: Answer): Answer {
  const { section } = answer;
  if (section.state !== "available" && section.state !== "stale") return answer;
  const rows = section.data.rows.filter((row) => !isTestQuoteType(row.quoteType));
  if (rows.length === section.data.rows.length) return answer;
  return { ...answer, section: { ...section, data: { ...section.data, rows } } };
}

/**
 * Reads pages from `cursor` until one still has a row once test launches are
 * removed, or the list ends, so a page of only test launches never reads as
 * "nothing here" while more pages exist. At most `maxReads` reads.
 */
export async function readVisiblePage<Page>(
  cursor: string | null,
  read: (cursor: string | null) => Promise<Page>,
  visible: (page: Page) => Page | Promise<Page>,
  rows: (page: Page) => number,
  next: (page: Page) => string | null,
  maxReads = 5,
): Promise<Page> {
  let page = await visible(await read(cursor));
  for (let reads = 1; reads < maxReads && rows(page) === 0 && next(page) !== null; reads++) page = await visible(await read(next(page)));
  return page;
}

/** Rows of a discovery answer's section (0 when it has none). */
export function discoveryRows(answer: DiscoveryResponse): number {
  const { section } = answer;
  return section.state === "available" || section.state === "stale" ? section.data.rows.length : 0;
}

/** The next page token of a discovery answer's section. */
export function discoveryNext(answer: DiscoveryResponse): string | null {
  const { section } = answer;
  return section.state === "available" || section.state === "stale" ? section.data.nextCursor : null;
}

type CoinRow = Readonly<{ presale_id: string | null; quote: Readonly<{ type: string }> }>;

/** Reads the coins of up to 50 presales by id (`/api/social/home/coins`); null when the read fails. */
export type ReadSaleCoins = (ids: readonly string[]) => Promise<readonly CoinRow[] | null>;

/** Whether each presale id seen so far is a test sale. A sale's quote never changes, so answers are kept for the process (or tab). */
const knownPresales = new Map<string, boolean>();
const KNOWN_PRESALES_MAX = 5_000;
const BY_IDS_MAX = 50;
/** Lookups in flight, so readers that start together share one read per id. */
const pendingPresales = new Map<string, Promise<boolean | undefined>>();

/**
 * The test sales among the presales Home's live activity names. Its trade
 * rows and top coins carry no quote coin, so they are looked up by id.
 */
export function testPresaleIds(read: SocialHappeningResponse, readCoins: ReadSaleCoins): Promise<ReadonlySet<string>> {
  const named: string[] = [];
  for (const event of read.tape) if (event.presale_id && event.quote_symbol === null) named.push(event.presale_id);
  for (const coin of [...(read.top_coins?.trending ?? []), ...(read.top_coins?.gainers ?? [])]) if (coin.presale_id) named.push(coin.presale_id);
  return testPresalesAmong(named, readCoins);
}

/**
 * The test sales among `ids`, for rows that name a presale but not its quote
 * coin. Each new id is looked up once (by id, 50 per read, in parallel, one
 * holder per coin) and remembered; a lookup already in flight is shared. A
 * failed lookup hides nothing.
 */
export async function testPresalesAmong(ids: Iterable<string>, readCoins: ReadSaleCoins): Promise<ReadonlySet<string>> {
  const named = new Set(ids);
  const unknown = [...named].filter((id) => !knownPresales.has(id) && !pendingPresales.has(id));
  for (let start = 0; start < unknown.length; start += BY_IDS_MAX) {
    const chunk = unknown.slice(start, start + BY_IDS_MAX);
    const answer = readCoins(chunk).then((coins) => {
      const found = new Map<string, boolean>();
      for (const coin of coins ?? []) if (coin.presale_id) found.set(coin.presale_id, isTestQuoteType(coin.quote.type));
      // Only ids the read answered are remembered, so one missing now is asked again next time.
      if (knownPresales.size + found.size > KNOWN_PRESALES_MAX) knownPresales.clear();
      for (const [id, isTest] of found) knownPresales.set(id, isTest);
      return found;
    }).catch(() => new Map<string, boolean>()).finally(() => {
      for (const id of chunk) pendingPresales.delete(id);
    });
    for (const id of chunk) pendingPresales.set(id, answer.then((found) => found.get(id)));
  }
  const answers = await Promise.all([...named].map(async (id) => [id, knownPresales.get(id) ?? (await pendingPresales.get(id))] as const));
  return new Set(answers.flatMap(([id, isTest]) => (isTest === true ? [id] : [])));
}

/**
 * Home's live activity without test sales. A row goes when its quote symbol
 * is Test SUI, or its presale or coin belongs to a test sale: one listed in
 * the same answer, or one of `testIds` (see `testPresaleIds`).
 */
export function withoutTestHappening<Read extends SocialHappeningResponse>(read: Read, testIds: ReadonlySet<string> = new Set()): Read {
  const lists = [read.fastest, read.opening_soon, read.today];
  const test = lists.flat().filter(({ presale }) => isTestQuoteSymbol(presale.quote_symbol) || testIds.has(presale.presale_id)).map(({ presale }) => presale);
  const presaleIds = new Set([...testIds, ...test.map((presale) => presale.presale_id)]);
  const coinTypes = new Set(test.flatMap((presale) => (presale.coin_type ? [presale.coin_type] : [])));
  const isTest = (row: Readonly<{ presale_id: string | null; coin_type?: string | null }>) =>
    (row.presale_id !== null && presaleIds.has(row.presale_id)) || (!!row.coin_type && coinTypes.has(row.coin_type));
  const keep = <Row extends Readonly<{ presale: Readonly<{ presale_id: string }> }>>(rows: readonly Row[]) =>
    rows.filter(({ presale }) => !presaleIds.has(presale.presale_id));
  return {
    ...read,
    fastest: keep(read.fastest),
    opening_soon: keep(read.opening_soon),
    today: keep(read.today),
    tape: read.tape.filter((event) => !isTestQuoteSymbol(event.quote_symbol) && !isTest(event)),
    ...(read.top_coins
      ? { top_coins: { trending: read.top_coins.trending.filter((coin) => !isTest(coin)), gainers: read.top_coins.gainers.filter((coin) => !isTest(coin)) } }
      : {}),
  };
}

/** The main feed without posts about test sales (profile feeds keep them). */
export function withoutTestPosts<Page extends Readonly<{ items: readonly Readonly<{ presale: Readonly<{ quote_symbol: string }> | null }>[] }>>(page: Page): Page {
  const items = page.items.filter((item) => !isTestQuoteSymbol(item.presale?.quote_symbol));
  return items.length === page.items.length ? page : { ...page, items };
}

/**
 * A trade-coin page (the coin pickers) without test sale coins. An open sale's
 * row names its quote coin; a migrated one does not, so it is looked up by id.
 */
export async function withoutTestTradeCoins<Page extends Readonly<{ coins: readonly Readonly<{ presale_id: string | null; quote_type?: string }>[] }>>(
  page: Page,
  readCoins: ReadSaleCoins,
): Promise<Page> {
  const test = await testPresalesAmong(page.coins.flatMap((coin) => (coin.presale_id && !coin.quote_type ? [coin.presale_id] : [])), readCoins);
  const coins = page.coins.filter((coin) => !isTestQuoteType(coin.quote_type) && !(coin.presale_id && test.has(coin.presale_id)));
  return coins.length === page.coins.length ? page : { ...page, coins };
}

/** A search answer without test sales (its presale rows name no quote coin). */
export async function withoutTestSearchPresales<Answer extends Readonly<{ presales: readonly Readonly<{ presale_id: string }>[] }>>(
  answer: Answer,
  readCoins: ReadSaleCoins,
): Promise<Answer> {
  const test = await testPresalesAmong(answer.presales.map((presale) => presale.presale_id), readCoins);
  const presales = answer.presales.filter((presale) => !test.has(presale.presale_id));
  return presales.length === answer.presales.length ? answer : { ...answer, presales };
}
