"use client";

import { hoverExcerpt } from "#web/lib/hover-text.ts";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { useState } from "react";

import { AccountAvatar } from "#web/components/social/AccountAvatar.tsx";
import type { SocialPresaleFollowedBacker, SocialPresalePerson } from "@blast/core/web/contracts/presales.ts";

import styles from "./PresaleSocialProof.module.css";

function BackerAvatar({ person }: Readonly<{ person: SocialPresalePerson }>) {
  const [open, setOpen] = useState(false);
  const name = person.display_name ?? person.callsign;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger
      aria-label={`${name} backed this.`}
      className={styles.trigger}
      closeDelay={100}
      delay={150}
      onBlur={() => setOpen(false)}
      onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setOpen(true); }}
      openOnHover
      type="button"
    >
      <span aria-hidden="true" className={styles.avatar}><AccountAvatar accountId={person.callsign} avatarUrl={person.avatar_url} size={24} /></span>
    </Popover.Trigger>
    <PopoverSurface
      positioner={{ className: styles.positioner, collisionPadding: 12, positionMethod: "fixed", side: "top", sideOffset: 6 }}
      popup={{ className: styles.popup, initialFocus: false, finalFocus: false }}
    >
      <Popover.Title className={styles.name}>{hoverExcerpt(name)}</Popover.Title>
    </PopoverSurface>
  </Popover.Root>;
}

/** Only the viewer endpoint's eligible followed backers; callsigns identify accounts across wallets. */
export function PresaleSocialProof({ following }: Readonly<{ following: readonly SocialPresaleFollowedBacker[] }>) {
  const people = [...new Map(following.map(({ account }) => [account.callsign, account])).values()]
    .sort((a, b) => a.callsign < b.callsign ? -1 : a.callsign > b.callsign ? 1 : 0);
  if (!people.length) return null;
  const remaining = people.slice(3);
  return <div className={styles.proof}>
    <div className={styles.avatars}>
      {people.slice(0, 3).map(person => <BackerAvatar key={person.callsign} person={person} />)}
      {remaining.length ? <Popover.Root>
        <Popover.Trigger aria-label={`Show ${remaining.length} more ${remaining.length === 1 ? "backer" : "backers"} you follow`} className={`${styles.trigger} ${styles.overflow}`} type="button">+{remaining.length}</Popover.Trigger>
        <PopoverSurface
          positioner={{ align: "end", className: styles.positioner, collisionPadding: 12, positionMethod: "fixed", side: "top", sideOffset: 6 }}
          popup={{ className: styles.popup }}
        >
              <Popover.Title className={styles.heading}>More backers you follow</Popover.Title>
              <ul className={styles.list}>
                {remaining.map(person => <li className={styles.person} key={person.callsign}>
                  <span aria-hidden="true" className={styles.avatar}><AccountAvatar accountId={person.callsign} avatarUrl={person.avatar_url} size={24} /></span>
                  <span className={styles.name}>{person.display_name ?? person.callsign}</span>
                </li>)}
              </ul>
            </PopoverSurface>
      </Popover.Root> : null}
    </div>
    <span className={styles.label}>Backed this.</span>
  </div>;
}
