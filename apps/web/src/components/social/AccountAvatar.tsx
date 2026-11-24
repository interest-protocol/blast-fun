"use client";

import { cardRingPath } from "@blast/core/web/contracts/card-identity.ts";
import { Avatar, type AvatarProps } from "#web/components/blast-ui/Avatar.tsx";
import { useCardIdentity } from "./card-identity-query";

export function AccountAvatar(props: AvatarProps) {
  const card = useCardIdentity(props.accountId);
  const ring = card ? { edition: card.edition, source: cardRingPath(card.edition) } : undefined;
  return <Avatar {...props} ring={ring} />;
}
