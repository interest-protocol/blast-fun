"use client";

import type { SocialPresalePerson } from "@blast/core/web/contracts/presales.ts";

import { AccountAvatar } from "./AccountAvatar";

export function PersonAvatar({ person, size }: Readonly<{ person: Pick<SocialPresalePerson, "callsign" | "avatar_url">; size: 18 | 26 | 30 | 34 }>) {
  return (
    <span aria-hidden="true" className={`av s${size}`} data-person-avatar="">
      <AccountAvatar accountId={person.callsign} avatarUrl={person.avatar_url} size={size} />
    </span>
  );
}
