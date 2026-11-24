import "server-only";
import { diagnosticMessage } from "#web/lib/errors.ts";

import { notFound } from "next/navigation";
import { connection } from "next/server";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import {
  PRESALE_LIST_DEFAULT_LIMIT,
  type PresaleListStatus,
  type SocialPresaleListPage,
} from "@blast/core/web/contracts/presales.ts";
import { readFeaturedPresalesFromBackend, readPresaleListFromBackend } from "#web/lib/backend-api/presales.ts";

import { cx } from "./cx";
import { featuredVisible } from "./featured-model";
import { saleOf } from "./server-reads";
import { readCalendarPages } from "./calendar-pages";
import { discoveryState, type PresaleListView } from "./discovery-state";
import { SaleAside } from "./SaleAside";
import { WatchedPresalesList, WatchedSalePage } from "./watched";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

async function listOrNull(status: PresaleListStatus, sort: string, limit = PRESALE_LIST_DEFAULT_LIMIT, calendar = false): Promise<SocialPresaleListPage | null> {
  try {
    const read = (cursor: string | null) => readPresaleListFromBackend({ status, sort, cursor, limit });
    return calendar ? await readCalendarPages(read) : await read(null);
  } catch {
    recordMetric("social.presales_page", { page: "list", outcome: "error" });
    return null;
  }
}

/** The page's reads at one moment, including live and upcoming sales for the calendar. */
async function readListPage(status: PresaleListStatus, sort: string, view: PresaleListView) {
  const nowMs = Date.now();
  const [initial, calendar, calendarLive, calendarEnded, featured] = await Promise.all([
    view === "backed" ? Promise.resolve(null) : listOrNull(status, sort),
    view === "calendar" ? listOrNull("upcoming", "opening", 50, true) : Promise.resolve(undefined),
    view === "calendar" ? listOrNull("live", "ending", 50, true) : Promise.resolve(undefined),
    view === "calendar" ? listOrNull("ended", "recent", 50, true) : Promise.resolve(undefined),
    featuredVisible(view) ? readFeaturedPresalesFromBackend().catch(() => null) : Promise.resolve(undefined),
  ]);
  return { nowMs, initial, calendar, calendarLive, calendarEnded, featured };
}

/**
 * `/presale`: the first page of the asked tab and sort (`?status=`, `?sort=`,
 * `?view=calendar` or `?view=backed`; anything else, old `?view=mine`
 * links included, falls back to Live, Pinned first), read on
 * the replica exactly as `GET /api/social/presales` reads it. A request seed
 * sets the pin order for the first paint and browser updates.
 */
export async function PresalesListPage({ searchParams }: Readonly<{ searchParams: SearchParams }>) {
  await connection();
  const params = await searchParams;
  const selection = discoveryState({ status: one(params.status), sort: one(params.sort), scope: one(params.scope), view: one(params.view), layout: one(params.layout), calendarRange: one(params.calendarRange) });
  const { status, sort, view } = selection;
  const pinSeed = crypto.randomUUID();
  const { nowMs, initial, calendar, calendarLive, calendarEnded, featured } = await readListPage(status, sort, view);
  recordMetric("social.presales_page", { page: "list", outcome: view === "backed" || initial ? "ok" : "error" });
  return (
    <WatchedPresalesList
      calendar={calendar}
      calendarLive={calendarLive}
      calendarEnded={calendarEnded}
      featured={featured}
      featuredEnabled
      initial={initial}
      nowMs={nowMs}
      initialPinSeed={pinSeed}
      {...selection}
    />
  );
}

/**
 * `/presale/<id>`: the sale read on the replica exactly as `GET
 * /api/social/presales/<id>` reads it; a sale blast-infra does not know is
 * the shell's "Nothing here".
 */
export async function SaleDetailPage({ presaleId }: Readonly<{ presaleId: string }>) {
  const read = await saleOf(presaleId);
  recordMetric("social.presales_page", { page: "sale", outcome: read.status });
  if (read.status === "ok") return <WatchedSalePage detail={read.detail} nowMs={read.nowMs} />;
  if (read.status === "missing") notFound();
  return (
    <div className={cx("card err err-page")} role="alert">
      <b>This presale couldn’t load</b>
      <span>{diagnosticMessage("Nothing changed. Check your connection and try again.", { code: "service_unavailable" })}</span>
      <a className={cx("btn btn-quiet btn-sm")} href={`/presale/${presaleId}`}>Try again</a>
    </div>
  );
}

export async function SaleRail({ presaleId }: Readonly<{ presaleId: string }>) {
  const read = await saleOf(presaleId);
  return read.status === "ok" ? <SaleAside detail={read.detail} nowMs={read.nowMs} /> : null;
}
