"use client";

import { useQuery } from "@tanstack/react-query";

import { CoinVerifiedMark, VerifiedBadge } from "#web/components/blast-ui/Icons.tsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { HomeTapeEvent, HomeWindow } from "@blast/core/web/contracts/home.ts";
import { bxAgo } from "@blast/core/web/format.ts";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";

import { presaleHref } from "../feed-ui/shell-bridge-model";
import { Avatar } from "../post/PostMedia";
import { useSocialViewer } from "../SignInGate";
import styles from "./CoinHome.module.css";
import { followingTapeQuery } from "./home-client";
import { firstName, tapeParts } from "./home-model";

/**
 * The tape (the critic's one borrowing from Perpsplexity's trench): one
 * line above the list, the newest trades, commitments and claims by the
 * people the viewer follows across every coin, newest first, each a face,
 * a name and what happened: `Maya sold $25 of ORBIT · 10h`. It answers
 * "are people I trust in it" before a single row is scanned. A visitor,
 * or a viewer whose follows did nothing in the window, sees no tape.
 */
export function FollowedTape({ window, nowMs }: Readonly<{ window: HomeWindow; nowMs: number }>) {
  const viewer = useSocialViewer();
  const client = useAppQueryClient();
  const token = viewer.getAccessToken;
  const query = useQuery({ ...followingTapeQuery(token ?? (async () => null), viewer.callsign ?? "", window), enabled: viewer.signedIn && token !== undefined }, client);
  const events = query.data?.events ?? [];
  if (!viewer.signedIn || events.length === 0) return null;
  return (
    <section aria-label="Latest from people you follow" className={styles.tape}>
      <span className={styles.tapeLive}><i aria-hidden="true" key={events[0]?.activity_id} />Live</span>
      <ul className={styles.tapeList}>
        {events.map((event) => <TapeItem event={event} key={event.activity_id} nowMs={nowMs} />)}
      </ul>
    </section>
  );
}

function TapeItem({ event, nowMs }: Readonly<{ event: HomeTapeEvent; nowMs: number }>) {
  const actor = event.actor;
  const parts = tapeParts(event);
  return (
    <li className={styles.tapeItem}>
      {actor.type === "account" ? <Avatar callsign={actor.callsign} size={26} src={actor.avatar_url} /> : null}
      <span className={styles.tapeText}>
        {actor.type === "account" ? <Link className={styles.tapeName} href={actor.path}>{firstName(actor)}</Link> : null}
        {actor.type === "account" && actor.verified ? <VerifiedBadge className="verified" /> : null}
        {` ${parts.before} `}
        <span className="coinNamed sm"><Link className={styles.tapeCoin} href={event.coin.presale_id === null ? coinPagePath(event.coin.coin_type) : presaleHref(event.coin.presale_id)}>{event.coin.symbol}</Link>{event.coin.verified_team ? <CoinVerifiedMark size="sm" /> : null}</span>
        {parts.after ? ` ${parts.after}` : null}
      </span>
      <span className={styles.tapeWhen}>{bxAgo(event.occurred_at_ms, nowMs)}</span>
    </li>
  );
}
