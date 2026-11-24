"use client";

import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import type { HomeActivity } from "@blast/core/web/contracts/home.ts";
import { ActorCell, Facepile } from "./ActorCell";
import { actorIdentity, actorKey } from "./actor-identity";
import styles from "./CoinHolderSignals.module.css";

/** Activity proves a buy or commitment; a current holding alone does not. */
export function CoinParticipants({ symbol, activity, sale, className }: Readonly<{ symbol: string; activity: HomeActivity; sale: boolean; className?: string }>) {
  const rank = (person: HomeActivity["preview"][number]) => (person.relation === "followed" ? 1e12 : 0) + (person.followers ?? -1);
  const people = activity.preview.filter(person => (sale ? person.commits : person.buys) !== null).toSorted((a, b) => rank(b) - rank(a));
  if (!people.length) return null;
  const identities = people.map(person => actorIdentity(person.actor));
  const label = `${symbol} ${sale ? "backers" : "buyers"}${activity.scope === "followed" ? " you follow" : ""} · ${activity.window}`;
  return <Popover.Root>
    <Popover.Trigger render={<Button variant="ghost" size="sm" />} openOnHover delay={180} closeDelay={100} className={`${styles.trigger} ${className ?? ""}`} aria-label={`View ${label}`}>
      <Facepile identities={identities} max={3} size={22} />
    </Popover.Trigger>
    <PopoverSurface
      positioner={{ sideOffset: 8, collisionPadding: 16, className: styles.layer }}
      popup={{ className: styles.popup }}
    >
          <Popover.Title className={styles.title}>{label}</Popover.Title>
          <ul className={styles.people} aria-label="Activity preview">{identities.map(identity => <li key={actorKey(identity)}><ActorCell identity={identity} /></li>)}</ul>
          <Popover.Close render={<Button variant="secondary" size="sm" />}>Close</Popover.Close>
        </PopoverSurface>
  </Popover.Root>;
}
