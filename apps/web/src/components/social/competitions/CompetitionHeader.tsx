"use client";

import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { pollInterval } from "#web/lib/query/polling.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { competitionWhen, competitionStatus } from "./competition-format.ts";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { competitionViewerSummarySchema, socialCompetitionRankPath, type Competition, type CompetitionViewerRank } from "@blast/core/modules/social/competitions/contracts.ts";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { ExternalIcon, XLogo } from "#web/components/blast-ui/Icons.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { callSocialApi } from "#web/components/social/social-api.ts";
import { useSocialViewer } from "../SignInGate";
import styles from "./CompetitionScreen.module.css";

/**
 * The signed-in viewer's own board row (redesign gap 15, interest-protocol/blast-v2#534):
 * `GET /api/social/me/competitions/rank?slug=`, read only for a signed-in viewer and only
 * where the board draws it; null for a visitor, while loading, on a failure, or when the
 * board does not count the viewer.
 */
export function useViewerRank(slug: string, enabled: boolean): Pick<CompetitionViewerRank, "member" | "members_total"> | null {
  const viewer = useSocialViewer();
  const signedIn = enabled && viewer.signedIn && viewer.getAccessToken !== undefined;
  const query = useQuery(
    {
      queryKey: queryKeys.me.competitionRank(slug, viewer.signedIn ? viewer.callsign ?? "account" : null),
      queryFn: async ({ signal }) => {
        const result = await callSocialApi({ getAccessToken: viewer.getAccessToken!, signal }, socialCompetitionRankPath(slug), { method: "GET" }, competitionViewerSummarySchema);
        return result.status === "ok" ? result.body : null;
      },
      enabled: signedIn,
      staleTime: 0,
      gcTime: 0,
      refetchInterval: (query) => pollInterval(30_000, query),
      retry: 1,
    },
    useAppQueryClient(),
  );
  return signedIn ? query.data ?? null : null;
}

function CompetitionMark({ competition }: Readonly<{ competition: Competition }>) {
  const core = coreCoin(competition.coin_type);
  const key = !competition.coin_icon_url && (core?.symbol === "SUI" || core?.symbol === "USDC") ? core.symbol.toLowerCase() : competition.coin_type;
  return (
    <CoinMark
      coin={{ key, coinType: competition.coin_type, symbol: competition.coin_symbol, iconUrl: competition.coin_icon_url, round: true }}
      size={16}
    />
  );
}

function Stats({ competition, traders, rank }: Readonly<{ competition: Competition; traders: number | null; rank: number | null }>) {
  if (!competition.prize_description && traders === null && rank === null) return null;
  return (
    <span className={styles.stats}>
      {competition.prize_description ? (
        <span className={styles.stat}>
          <span>Prize pool</span>
          <b>{competition.prize_description}</b>
        </span>
      ) : null}
      {traders === null ? null : (
        <span className={styles.stat}>
          <span>Traders</span>
          <b className="num">{traders.toLocaleString("en-US")}</b>
        </span>
      )}
      {rank === null ? null : (
        <span className={styles.stat}>
          <span>Your rank</span>
          <b className="num">#{rank.toLocaleString("en-US")}</b>
        </span>
      )}
    </span>
  );
}

/** A member count as read (`members_total`), or null when the answer carries none. */
const countOf = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null);

/**
 * A competition as the Competitions board draws it: the status and time chips,
 * the name in the display face, its UTC schedule, and the stat tiles (the prize
 * pool, how many traders the board counts once it has started, and the
 * viewer's rank while it is live). The directory's card is one link to the
 * competition; on its own page it carries the coin and the organizer's rules.
 * The count comes from the board read (`membersTotal`, its own page) or the
 * viewer's rank read; the directory carries none, so a visitor's card there
 * draws no Traders tile.
 */
export function CompetitionHero({
  competition,
  nowMs,
  href,
  membersTotal,
}: Readonly<{ competition: Competition; nowMs: number; href?: string; membersTotal?: number }>) {
  const status = competitionStatus(competition, nowMs);
  const viewer = useViewerRank(competition.slug, status === "Live");
  const rank = viewer?.member?.rank ?? null;
  const traders = status === "Scheduled" ? null : countOf(membersTotal) ?? countOf(viewer?.members_total);
  const body = (
    <>
      <span className={styles.heroMain}>
        <span className={styles.chips}>
          <span className={styles.chip} data-live={status === "Live" || undefined}>{status}</span>
          {status === "Ended" ? null : <span className={styles.chip}>{competitionWhen(competition, nowMs)}</span>}
          {href ? null : (
            <span className={styles.chip}>
              <CompetitionMark competition={competition} />
              <InspectValue value={competition.coin_type} label="coin type">{competition.coin_symbol}</InspectValue>
            </span>
          )}
        </span>
        <h2 className={styles.heroName} id={href ? undefined : "competition-title"}>{competition.name}</h2>
        <span className={styles.heroSub}>
          <DateStamp at={competition.starts_at_ms} label="competition start time" plain={Boolean(href)} />
          <span aria-hidden="true"> → </span>
          <span className="sr"> to </span>
          <DateStamp at={competition.ends_at_ms} label="competition end time" plain={Boolean(href)} />
        </span>
        {!href && competition.rules_url ? (
          <a className={styles.rules} href={competition.rules_url} rel="noopener noreferrer" target="_blank">
            <XLogo /> Announcement &amp; rules <ExternalIcon />
            <span className="sr"> (opens in a new tab)</span>
          </a>
        ) : null}
      </span>
      <Stats competition={competition} rank={rank} traders={traders} />
    </>
  );
  if (!href) return <section aria-labelledby="competition-title" className={`card ${styles.hero}`}>{body}</section>;
  return (
    <Link className={`card ${styles.hero} ${styles.heroLink}`} data-ended={status === "Ended" || undefined} href={href}>
      {body}
    </Link>
  );
}
