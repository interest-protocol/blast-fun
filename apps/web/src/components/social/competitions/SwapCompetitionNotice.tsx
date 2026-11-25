"use client";

import Link from "next/link";

import type { Competition } from "@blast/core/modules/social/competitions/contracts.ts";
import styles from "./SwapCompetitionNotice.module.css";

export function SwapCompetitionNotice({
  competitions,
  coinTypes,
  onNavigate,
}: Readonly<{
  competitions: readonly Competition[];
  coinTypes: readonly string[];
  onNavigate?: () => void;
}>) {
  const types = new Set(coinTypes);
  const events = competitions.filter((event) => types.has(event.coin_type));
  if (events.length === 0) return null;
  return (
    <aside className={styles.notice} aria-label="Live trading competitions">
      {events.map((event) => (
        <div key={event.slug}>
          <p>
            <strong>{event.coin_symbol} competition · Live</strong>
          </p>
          <nav aria-label={`${event.coin_symbol} competition links`}>
            <Link href={`/competitions/${event.slug}`} onClick={onNavigate} prefetch={false}>
              Leaderboard
            </Link>
            {event.rules_url ? (
              <a href={event.rules_url} target="_blank" rel="noopener noreferrer">
                Rules <span className="sr">(opens in a new tab)</span>
                <span aria-hidden="true">↗</span>
              </a>
            ) : null}
          </nav>
        </div>
      ))}
    </aside>
  );
}
